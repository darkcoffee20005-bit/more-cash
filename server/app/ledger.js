// المحاسبة (نسخة تجريبية): دفتر يومية بالقيد المزدوج يُبنى تلقائياً من مستندات البرنامج نفسها
// (الإيصالات، الاسترجاع، المصروفات، حركات الدرج، إغلاق الورديات، حركات المخزون) + قيود يدوية للتسويات.
//
// المبدأ: كل مستند مصدر له "قيد مطلوب" محسوب حتمياً. المزامنة تقارن المطلوب بما رُحِّل فعلاً لنفس المصدر،
// وتُرحِّل الفرق فقط كقيد جديد. لا يُعدَّل قيد ولا يُحذف أبداً: حذف مصروف أو مراجعة وردية تولّد قيداً عكسياً
// مؤرخاً بيوم التصحيح. كل قيد متوازن (المدين = الدائن) وكل المبالغ دنانير صحيحة.
import { costOf } from '../../shared/calc.js';
import { localDate } from '../../shared/format.js';
import { AppError, audit, bad, getSettings, id as checkId, int, isDup, requirePerm, str } from './core.js';

export const ACCOUNT_TYPES = { asset: 'أصول', liability: 'خصوم', equity: 'حقوق الملكية', revenue: 'إيرادات', expense: 'مصروفات' };
// الحسابات ذات الطبيعة المدينة (رصيدها = مدين − دائن)
const DEBIT_NATURE = new Set(['asset', 'expense']);

export const DEFAULT_ACCOUNTS = [
  ['1000', 'الصندوق (نقد الدرج)', 'asset'],
  ['1010', 'تسويات كي (مبالغ البطاقات)', 'asset'],
  ['1020', 'البنك', 'asset'],
  ['1100', 'المخزون', 'asset'],
  ['1900', 'سحوبات الدرج قيد التصنيف', 'asset'],
  ['2000', 'الموردون', 'liability'],
  ['2100', 'ضريبة المبيعات المستحقة', 'liability'],
  ['3000', 'رأس المال', 'equity'],
  ['3010', 'جاري المالك', 'equity'],
  ['4000', 'المبيعات', 'revenue'],
  ['4010', 'مردودات وإلغاءات المبيعات', 'revenue'],
  ['5000', 'تكلفة البضاعة المباعة', 'expense'],
  ['5100', 'هدر وتالف', 'expense'],
  ['5200', 'فروقات الجرد', 'expense'],
  ['5300', 'فروقات الصندوق', 'expense'],
  ['6100', 'إيجار', 'expense'],
  ['6200', 'رواتب وأجور', 'expense'],
  ['6300', 'كهرباء وماء', 'expense'],
  ['6400', 'مشتريات ومستلزمات', 'expense'],
  ['6500', 'صيانة', 'expense'],
  ['6900', 'مصروفات أخرى', 'expense'],
];
const EXPENSE_ACCOUNT = { rent: '6100', salaries: '6200', utilities: '6300', supplies: '6400', maintenance: '6500', other: '6900' };
const A = { cash: '1000', card: '1010', bank: '1020', inventory: '1100', drawerClearing: '1900', suppliers: '2000', tax: '2100', capital: '3000', owner: '3010', sales: '4000', returns: '4010', cogs: '5000', waste: '5100', countDiff: '5200', cashDiff: '5300' };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** يبني قيداً من أزواج (حساب، مبلغ: مدين موجب ودائن سالب) ويجمع المكرر ويحذف الأصفار */
function net(pairs) {
  const m = new Map();
  for (const [acc, amt] of pairs) if (amt) m.set(acc, (m.get(acc) ?? 0) + amt);
  for (const [k, v] of m) if (!v) m.delete(k);
  return m;
}
const toLines = (m) => [...m].map(([account, v]) => ({ account, debit: v > 0 ? v : 0, credit: v < 0 ? -v : 0 }));
const sumMap = (m) => [...m.values()].reduce((a, v) => a + v, 0);

export function createLedger(ctx) {
  const { db, now, newId } = ctx;
  const J = () => db.collection('journal');
  const ACC = () => db.collection('ledger_accounts');

  async function accounts() {
    let rows = await ACC().find({}).toArray();
    if (!rows.length) {
      for (const [code, name, type] of DEFAULT_ACCOUNTS) {
        try { await ACC().insertOne({ _id: newId(), code, name, type, system: true, createdAt: now() }); } catch (e) { if (!isDup(e)) throw e; }
      }
      rows = await ACC().find({}).toArray();
    }
    return rows.sort((a, b) => a.code.localeCompare(b.code));
  }

  // ---------------------------------------------------------------- القيود المطلوبة من المستندات
  async function desiredEntries() {
    const out = new Map(); // key → { date, memo, source, lines: Map }
    const put = (key, date, memo, source, pairs) => { const lines = net(pairs); if (lines.size) out.set(key, { date, memo, source, lines }); };
    const payPairs = (payments, sign) => payments.map((p) => [p.kind === 'cash' ? A.cash : A.card, sign * p.amount]);

    // الإيصالات: بيع واسترجاع
    for (const r of await db.collection('receipts').find({}).toArray()) {
      const T = r.totals;
      const revenue = T.total - T.tax;
      if (r.type === 'sale') {
        put(`sale:${r._id}`, r.createdAt, `بيع إيصال #${r.number}`, { type: 'receipt', id: r._id, number: r.number }, [
          ...payPairs(r.payments, 1), [A.sales, -revenue], [A.tax, -T.tax], [A.cogs, T.cost], [A.inventory, -T.cost],
        ]);
      } else {
        const waste = r.wasteCost ?? 0;
        put(`refund:${r._id}`, r.createdAt, `${r.cancel ? 'إلغاء' : 'استرجاع'} #${r.number} للإيصال #${r.refundOfNumber}${r.reason ? ` — ${r.reason}` : ''}`, { type: 'receipt', id: r._id, number: r.number }, [
          [A.returns, revenue], [A.tax, T.tax], ...payPairs(r.payments, -1),
          [A.inventory, T.cost], [A.cogs, -T.cost],
          [A.waste, waste], [A.cogs, -waste],
        ]);
      }
    }

    // المصروفات (المحذوفة تختفي من المطلوب فيُرحَّل عكسها تلقائياً)
    for (const e of await db.collection('expenses').find({}).toArray()) {
      const acc = EXPENSE_ACCOUNT[e.category] ?? '6900';
      put(`expense:${e._id}`, new Date(`${e.day}T12:00:00Z`), `مصروف${e.note ? `: ${e.note}` : ''}`, { type: 'expense', id: e._id }, [
        [acc, e.amount], [e.fromDrawer ? A.drawerClearing : A.owner, -e.amount],
      ]);
    }

    // الورديات: النقد الافتتاحي، حركات الدرج، وفرق الإغلاق
    const shifts = (await db.collection('shifts').find({}).toArray()).sort((a, b) => new Date(a.openedAt) - new Date(b.openedAt));
    let prev = null;
    for (const s of shifts) {
      // النقد بين ورديتين (أخذه المالك أو أضافه): الفرق بين المعدود عند إغلاق السابقة وافتتاحي هذه
      const before = prev ? prev.actualCash ?? 0 : 0;
      put(`shift-open:${s._id}`, s.openedAt, `افتتاح وردية #${s.number}${prev ? ' — فرق النقد عن إغلاق الوردية السابقة' : ' — النقد الافتتاحي'}`, { type: 'shift', id: s._id, number: s.number }, [
        [A.cash, s.startingCash - before], [A.owner, before - s.startingCash],
      ]);
      for (const m of s.movements ?? []) {
        const sign = m.type === 'pay_in' ? 1 : -1;
        const other = m.purpose === 'supplier' ? A.suppliers : m.purpose === 'owner' ? A.owner : A.drawerClearing;
        put(`move:${s._id}:${m.id}`, m.at, `${m.type === 'pay_in' ? 'إدخال نقد' : 'سحب نقد'}: ${m.note}`, { type: 'shift', id: s._id, number: s.number }, [
          [A.cash, sign * m.amount], [other, -sign * m.amount],
        ]);
      }
      if (s.status === 'closed' && s.difference) {
        put(`shift-diff:${s._id}`, s.closedAt, `فرق عدّ النقد عند إغلاق الوردية #${s.number}`, { type: 'shift', id: s._id, number: s.number }, [
          [A.cash, s.difference], [A.cashDiff, -s.difference],
        ]);
      }
      if (s.status === 'closed') prev = s;
    }

    // المخزون: الاستلام والرصيد الافتتاحي والهدر والجرد (البيع والاسترجاع محسوبان من الإيصالات)
    const variants = new Map((await db.collection('variants').find({}).toArray()).map((v) => [v._id, v]));
    const moves = await db.collection('stock_moves').find({ reason: { $in: ['receive', 'initial', 'loss', 'count', 'adjust'] } }).toArray();
    for (const m of moves) {
      const unit = m.unitCostMilli ?? (m.reason === 'receive' ? m.costMilli : null) ?? variants.get(m.variantId)?.costMilli ?? 0;
      const value = costOf(Math.abs(m.delta), unit) * Math.sign(m.delta);
      if (!value) continue;
      const other = m.reason === 'receive' ? A.suppliers : m.reason === 'initial' ? A.capital : m.reason === 'loss' ? A.waste : A.countDiff;
      const label = { receive: 'استلام مخزون', initial: 'رصيد افتتاحي للمخزون', loss: 'هدر/تالف', count: 'فرق جرد', adjust: 'تعديل مخزون' }[m.reason];
      put(`stock:${m._id}`, m.at, `${label}${m.note ? `: ${m.note}` : ''}`, { type: 'stock', id: m._id }, [[A.inventory, value], [other, -value]]);
    }
    return out;
  }

  // ---------------------------------------------------------------- المزامنة
  let syncing = null;
  async function sync() {
    if (syncing) return syncing;
    syncing = (async () => {
      const settings = await getSettings(db);
      await accounts();
      const desired = await desiredEntries();
      const posted = new Map(); // key → { n, lines: Map }
      for (const e of await J().find({ auto: true }).toArray()) {
        const p = posted.get(e.key) ?? { n: 0, lines: new Map() };
        p.n += 1;
        for (const l of e.lines) p.lines.set(l.account, (p.lines.get(l.account) ?? 0) + l.debit - l.credit);
        posted.set(e.key, p);
      }
      let created = 0;
      for (const key of new Set([...desired.keys(), ...posted.keys()])) {
        const want = desired.get(key);
        const have = posted.get(key);
        const diff = net([...(want?.lines ?? new Map())].concat([...(have?.lines ?? new Map())].map(([a, v]) => [a, -v])));
        if (!diff.size) continue;
        if (sumMap(diff) !== 0) throw new AppError(500, 'UNBALANCED_ENTRY', key);
        const correction = Boolean(have);
        const date = correction ? now() : new Date(want.date);
        const doc = {
          _id: newId(), key, postKey: `${key}#${(have?.n ?? 0) + 1}`, auto: true, date, day: localDate(date, settings.tzOffsetMin),
          memo: correction ? `تصحيح: ${want?.memo ?? 'مستند حُذف أو تغيّر'}` : want.memo, source: want?.source ?? null,
          lines: toLines(diff), createdAt: now(),
        };
        try { await J().insertOne(doc); created += 1; } catch (e) { if (!isDup(e)) throw e; }
      }
      return { created };
    })();
    try { return await syncing; } finally { syncing = null; }
  }

  // ---------------------------------------------------------------- الأرصدة والتقارير
  async function entriesUpTo(toDay, fromDay = null) {
    const q = { day: { $lte: toDay } };
    if (fromDay) q.day.$gte = fromDay;
    return J().find(q).toArray();
  }

  function totalsByAccount(entries) {
    const m = new Map();
    for (const e of entries) for (const l of e.lines) {
      const t = m.get(l.account) ?? { debit: 0, credit: 0 };
      t.debit += l.debit; t.credit += l.credit;
      m.set(l.account, t);
    }
    return m;
  }
  const balanceOf = (acc, t) => (DEBIT_NATURE.has(acc.type) ? t.debit - t.credit : t.credit - t.debit);

  async function trialBalance(actor, { to } = {}) {
    requirePerm(actor, 'admin.reports');
    await sync();
    const day = checkDay(to);
    const accs = await accounts();
    const t = totalsByAccount(await entriesUpTo(day));
    const rows = accs.map((a) => {
      const x = t.get(a.code) ?? { debit: 0, credit: 0 };
      const bal = x.debit - x.credit;
      return { code: a.code, name: a.name, type: a.type, debit: x.debit, credit: x.credit, balanceDebit: bal > 0 ? bal : 0, balanceCredit: bal < 0 ? -bal : 0 };
    }).filter((r) => r.debit || r.credit);
    const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
    return { to: day, rows, totals: { debit: sum('debit'), credit: sum('credit'), balanceDebit: sum('balanceDebit'), balanceCredit: sum('balanceCredit') } };
  }

  async function incomeStatement(actor, { from, to } = {}) {
    requirePerm(actor, 'admin.reports');
    await sync();
    const f = checkDay(from);
    const tday = checkDay(to);
    if (f > tday) throw new AppError(400, 'INVALID_RANGE');
    return buildIncome(await accounts(), await entriesUpTo(tday, f), f, tday);
  }

  function buildIncome(accs, entries, from, to) {
    const t = totalsByAccount(entries);
    const line = (a) => ({ code: a.code, name: a.name, amount: balanceOf(a, t.get(a.code) ?? { debit: 0, credit: 0 }) });
    const revenue = accs.filter((a) => a.type === 'revenue').map(line);
    const cost = accs.filter((a) => a.type === 'expense' && a.code < '6000').map(line);
    const opex = accs.filter((a) => a.type === 'expense' && a.code >= '6000').map(line);
    const netRevenue = revenue.reduce((s, r) => s + r.amount, 0);
    const costTotal = cost.reduce((s, r) => s + r.amount, 0);
    const opexTotal = opex.reduce((s, r) => s + r.amount, 0);
    return {
      from, to, revenue, netRevenue, cost, costTotal, grossProfit: netRevenue - costTotal,
      opex, opexTotal, netProfit: netRevenue - costTotal - opexTotal,
    };
  }

  async function balanceSheet(actor, { to } = {}) {
    requirePerm(actor, 'admin.reports');
    await sync();
    const day = checkDay(to);
    const accs = await accounts();
    const entries = await entriesUpTo(day);
    const t = totalsByAccount(entries);
    const line = (a) => ({ code: a.code, name: a.name, amount: balanceOf(a, t.get(a.code) ?? { debit: 0, credit: 0 }) });
    const pick = (type) => accs.filter((a) => a.type === type).map(line).filter((r) => r.amount);
    const assets = pick('asset');
    const liabilities = pick('liability');
    const equity = pick('equity');
    const profit = buildIncome(accs, entries, null, day).netProfit; // الأرباح المتراكمة = كل الأرباح حتى التاريخ
    equity.push({ code: '3900', name: 'الأرباح المتراكمة', amount: profit, computed: true });
    const sum = (rows) => rows.reduce((a, r) => a + r.amount, 0);
    const totals = { assets: sum(assets), liabilities: sum(liabilities), equity: sum(equity) };
    // قيمة المخزون حسب الكميات الحالية × متوسط التكلفة (للمقارنة مع رصيد الدفتر)
    const vs = await db.collection('variants').find({ trackStock: true, active: true }).toArray();
    const stockValue = vs.reduce((a, v) => a + (v.stock > 0 ? costOf(v.stock, v.costMilli ?? 0) : 0), 0);
    return { to: day, assets, liabilities, equity, totals, balanced: totals.assets === totals.liabilities + totals.equity, stockValue };
  }

  async function ledger(actor, code, { from, to } = {}) {
    requirePerm(actor, 'admin.reports');
    await sync();
    const f = checkDay(from);
    const tday = checkDay(to);
    const acc = (await accounts()).find((a) => a.code === code);
    if (!acc) throw new AppError(404, 'NOT_FOUND');
    const sign = DEBIT_NATURE.has(acc.type) ? 1 : -1;
    const before = await J().find({ day: { $lt: f }, 'lines.account': code }).toArray();
    let balance = before.flatMap((e) => e.lines).filter((l) => l.account === code).reduce((a, l) => a + sign * (l.debit - l.credit), 0);
    const opening = balance;
    const rows = (await J().find({ day: { $gte: f, $lte: tday }, 'lines.account': code }).toArray())
      .sort((a, b) => new Date(a.date) - new Date(b.date) || String(a.postKey).localeCompare(String(b.postKey)))
      .flatMap((e) => e.lines.filter((l) => l.account === code).map((l) => {
        balance += sign * (l.debit - l.credit);
        return { id: e._id, date: e.date, memo: e.memo, source: e.source, manual: !e.auto, debit: l.debit, credit: l.credit, balance };
      }));
    return { account: { code: acc.code, name: acc.name, type: acc.type }, from: f, to: tday, opening, closing: balance, rows };
  }

  async function journal(actor, { from, to } = {}) {
    requirePerm(actor, 'admin.reports');
    await sync();
    const f = checkDay(from);
    const tday = checkDay(to);
    const rows = await J().find({ day: { $gte: f, $lte: tday } }).toArray();
    rows.sort((a, b) => new Date(b.date) - new Date(a.date));
    return rows.slice(0, 1000).map((e) => ({ id: e._id, date: e.date, memo: e.memo, auto: !!e.auto, source: e.source, lines: e.lines, reversedBy: e.reversedBy ?? null, reverses: e.reverses ?? null, byName: e.byName ?? null }));
  }

  // ---------------------------------------------------------------- القيود اليدوية والحسابات
  async function manualEntry(actor, input = {}) {
    requirePerm(actor, 'admin.settings');
    const clientId = checkId(input.clientId, 'clientId');
    const prior = await J().findOne({ postKey: `manual:${clientId}` });
    if (prior) return { id: prior._id, duplicate: true };
    const settings = await getSettings(db);
    const day = checkDay(input.date);
    if (day > localDate(now(), settings.tzOffsetMin)) throw bad('INVALID_DATE', 'date');
    const memo = str(input.memo, { field: 'memo', min: 2, max: 160 });
    const codes = new Set((await accounts()).map((a) => a.code));
    if (!Array.isArray(input.lines) || input.lines.length < 2 || input.lines.length > 20) throw bad('INVALID_LIST', 'lines');
    const lines = input.lines.map((l, i) => {
      if (!codes.has(l.account)) throw bad('UNKNOWN_ACCOUNT', String(i + 1));
      const debit = int(l.debit ?? 0, { field: 'debit', max: 1_000_000_000_000 });
      const credit = int(l.credit ?? 0, { field: 'credit', max: 1_000_000_000_000 });
      if ((debit > 0) === (credit > 0)) throw bad('LINE_ONE_SIDE', String(i + 1));
      return { account: l.account, debit, credit };
    });
    const dr = lines.reduce((a, l) => a + l.debit, 0);
    const cr = lines.reduce((a, l) => a + l.credit, 0);
    if (dr !== cr) throw bad('UNBALANCED_ENTRY', `${dr}≠${cr}`);
    const doc = { _id: newId(), key: `manual:${clientId}`, postKey: `manual:${clientId}`, auto: false, date: new Date(`${day}T12:00:00Z`), day, memo, source: null, lines, by: actor.id, byName: actor.name, createdAt: now() };
    try { await J().insertOne(doc); } catch (e) { if (isDup(e)) return { id: (await J().findOne({ postKey: doc.postKey }))._id, duplicate: true }; throw e; }
    await audit({ ...ctx, actor }, 'ledger.manual', { memo, total: dr });
    return { id: doc._id, duplicate: false };
  }

  async function reverseManual(actor, entryId) {
    requirePerm(actor, 'admin.settings');
    const e = await J().findOne({ _id: checkId(entryId) });
    if (!e) throw new AppError(404, 'NOT_FOUND');
    if (e.auto) throw bad('AUTO_ENTRY_READONLY');
    if (e.reversedBy || e.reverses) throw bad('ALREADY_REVERSED');
    const settings = await getSettings(db);
    const day = localDate(now(), settings.tzOffsetMin);
    const doc = { _id: newId(), key: `manual-rev:${e._id}`, postKey: `manual-rev:${e._id}`, auto: false, date: now(), day, memo: `عكس قيد: ${e.memo}`, source: null, reverses: e._id,
      lines: e.lines.map((l) => ({ account: l.account, debit: l.credit, credit: l.debit })), by: actor.id, byName: actor.name, createdAt: now() };
    try { await J().insertOne(doc); } catch (err) { if (!isDup(err)) throw err; }
    await J().updateOne({ _id: e._id }, { $set: { reversedBy: doc._id } });
    await audit({ ...ctx, actor }, 'ledger.reverse', { memo: e.memo });
    return { id: doc._id };
  }

  async function listAccounts(actor) {
    requirePerm(actor, 'admin.reports');
    return (await accounts()).map((a) => ({ code: a.code, name: a.name, type: a.type, system: !!a.system }));
  }

  async function saveAccount(actor, input = {}) {
    requirePerm(actor, 'admin.settings');
    const code = String(input.code ?? '');
    if (!/^\d{4}$/.test(code)) throw bad('INVALID_CODE', 'code');
    const name = str(input.name, { field: 'name', min: 2, max: 60 });
    await accounts();
    const existing = await ACC().findOne({ code });
    if (existing) {
      await ACC().updateOne({ _id: existing._id }, { $set: { name } });
    } else {
      const type = Object.keys(ACCOUNT_TYPES).includes(input.type) ? input.type : null;
      if (!type) throw bad('INVALID_CHOICE', 'type');
      try { await ACC().insertOne({ _id: newId(), code, name, type, system: false, createdAt: now() }); } catch (e) { if (isDup(e)) throw bad('CODE_IN_USE'); throw e; }
    }
    return { code, name };
  }

  function checkDay(d) {
    if (!DATE.test(String(d ?? ''))) throw new AppError(400, 'INVALID_RANGE');
    return String(d);
  }

  return { sync, trialBalance, incomeStatement, balanceSheet, ledger, journal, manualEntry, reverseManual, listAccounts, saveAccount };
}
