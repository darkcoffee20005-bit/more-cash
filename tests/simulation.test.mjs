// محاكاة استخدام حقيقي لعدة أيام: مبيعات بإضافات وخصومات ونقاط ودفع مقسّم، استرجاع وإلغاء، مصروفات (من الدرج وخارجه)،
// إدخال وسحب نقد، إغلاق ورديات بفروقات، استلام وهدر وجرد، وتغيير الضريبة — مع إعادة إرسال عشوائية لكل عملية.
// بعد كل خطوة تُطابَق أرقام النظام مع دفتر مستقل يبنيه الاختبار من ردود الخادم نفسها، ومع ثوابت محاسبية:
// لا كسور، المجاميع تساوي مجموع أجزائها، الاسترجاع لا يتجاوز البيع، النقد المتوقع، المخزون = دفتر الحركات،
// النقاط = دفتر النقاط، والتقارير (يومي، فترة، وردية، لوحة) متفقة فيما بينها.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MemoryDb } from '../server/db/memory.js';
import { ensureIndexes } from '../server/db/indexes.js';
import { createApp } from '../server/app/index.js';
import { calculateTicket, unitPrice } from '../shared/calc.js';
import { localDate } from '../shared/format.js';

/** مولّد عشوائي ثابت البذرة حتى تتكرر أي مشكلة بنفس الخطوات */
function rng(seed) {
  let s = seed >>> 0;
  const next = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, int: (a, b) => a + Math.floor(next() * (b - a + 1)), pick: (arr) => arr[Math.floor(next() * arr.length)], chance: (p) => next() < p };
}

const TZ = 180;
const isMoney = (v) => Number.isSafeInteger(v);

async function boot() {
  const db = new MemoryDb({ newId: randomUUID });
  await ensureIndexes(db);
  let clock = new Date('2026-10-14T05:00:00Z'); // 08:00 بغداد
  const app = createApp({ db, now: () => clock, log: { error() {}, warn() {}, info() {} } });
  const tokens = {};
  const pins = { owner: '1357', mgr: '2580', sara: '2468' };
  const call = async (who, method, path, body, query) => {
    let r = await app.handle({ method, path, body, query, token: tokens[who] ?? null, ip: who });
    if (r.setToken !== undefined) tokens[who] = r.setToken;
    // الجلسة تنتهي بعد 12 ساعة: الموظف يُدخل رمزه من جديد كما في الواقع
    if (r.status === 401 && path !== '/api/auth/pin' && tokens[who]) {
      const l = await app.handle({ method: 'POST', path: '/api/auth/pin', body: { pin: pins[who] }, token: null, ip: who });
      if (l.setToken !== undefined) tokens[who] = l.setToken;
      r = await app.handle({ method, path, body, query, token: tokens[who] ?? null, ip: who });
    }
    return r;
  };
  const ok = async (who, method, path, body, query) => {
    const r = await call(who, method, path, body, query);
    assert.equal(r.status, 200, `${who} ${method} ${path} → ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  assert.equal((await call('owner', 'POST', '/api/setup', { storeName: 'مقهى المحاكاة', ownerName: 'أحمد', pin: '1357', seed: true })).status, 200);
  await ok('owner', 'POST', '/api/auth/pin', { pin: '1357' });
  return { db, call, ok, tick: (ms) => { clock = new Date(clock.getTime() + ms); }, now: () => clock };
}

async function simulate(seed, steps) {
  const R = rng(seed);
  const { db, call, ok, tick, now } = await boot();
  await ok('owner', 'POST', '/api/admin/employees', { name: 'زينب', role: 'manager', pin: '2580' });
  await ok('owner', 'POST', '/api/admin/employees', { name: 'سارة', role: 'cashier', pin: '2468' });
  await ok('mgr', 'POST', '/api/auth/pin', { pin: '2580' });
  await ok('sara', 'POST', '/api/auth/pin', { pin: '2468' });
  const staff = ['owner', 'mgr', 'sara'];

  let { catalog, settings } = await ok('owner', 'GET', '/api/pos/bootstrap');
  const modsById = new Map(catalog.modifiers.map((m) => [m.id, m]));
  const customers = [];
  for (const [i, name] of ['علي حسن', 'نور', 'مصطفى', 'هدى'].entries()) customers.push(await ok('sara', 'POST', '/api/customers', { name, phone: `0770000000${i}` }));

  // الدفتر المستقل
  const sales = new Map(); // id → receipt
  const refundsOf = new Map(); // saleId → [refund receipts]
  const expenses = new Map(); // id → { amount, day }
  let shift = null; // { id, starting, cashIn, cashOut, payIn, payOut }
  const closedShifts = [];
  const days = new Set();
  const stats = { sale: 0, refund: 0, cancel: 0, expense: 0, expenseDel: 0, payIn: 0, payOut: 0, close: 0, receive: 0, loss: 0, count: 0, tax: 0, replay: 0, rejected: {} };
  const reject = (code) => { stats.rejected[code] = (stats.rejected[code] ?? 0) + 1; };

  const today = () => localDate(now(), TZ);
  const cashOf = (receipt) => receipt.payments.filter((p) => p.kind === 'cash').reduce((a, p) => a + p.amount, 0);

  async function openShift() {
    const startingCash = R.int(0, 8) * 5000;
    const s = await ok(R.pick(staff), 'POST', '/api/shifts/open', { startingCash });
    shift = { id: s.id, number: s.number, starting: startingCash, cashIn: 0, cashOut: 0, payIn: 0, payOut: 0 };
  }

  function priceOf(line) {
    const item = catalog.items.find((i) => i.variants.some((v) => v.id === line.variantId));
    const v = item.variants.find((x) => x.id === line.variantId);
    const mods = catalog.modifiers.flatMap((m) => m.options).filter((o) => line.modifierOptionIds.includes(o.id)).map((o) => o.price);
    return unitPrice(v.price, mods);
  }

  function randomLines() {
    const n = R.int(1, 4);
    const lines = [];
    for (let i = 0; i < n; i++) {
      const item = R.pick(catalog.items);
      const v = R.pick(item.variants);
      const opts = [];
      for (const mid of item.modifierIds) {
        const g = modsById.get(mid);
        if (!g) continue;
        if (g.required || R.chance(0.35)) {
          if (g.selection === 'multiple') { for (const o of g.options) if (R.chance(0.4)) opts.push(o.id); if (g.required && !g.options.some((o) => opts.includes(o.id))) opts.push(g.options[0].id); }
          else opts.push(R.pick(g.options).id);
        }
      }
      const discountIds = R.chance(0.12) ? [R.pick(catalog.discounts.filter((d) => !d.restricted)).id] : [];
      lines.push({ variantId: v.id, qty: R.int(1, 3), modifierOptionIds: opts, discountIds });
    }
    return lines;
  }

  async function doSale(who) {
    const lines = randomLines();
    const allowed = catalog.discounts.filter((d) => who !== 'sara' || !d.restricted);
    const discountIds = R.chance(0.25) ? [R.pick(allowed).id, ...(R.chance(0.3) ? [R.pick(allowed).id] : [])].filter((x, i, a) => a.indexOf(x) === i) : [];
    const customer = R.chance(0.45) ? R.pick(customers) : null;
    const disc = (ids) => ids.map((id) => catalog.discounts.find((d) => d.id === id));
    const calc = (points) => calculateTicket(lines.map((l) => ({ qty: l.qty, unitPrice: priceOf(l), discounts: disc(l.discountIds) })), { discounts: disc(discountIds), pointsRedeemed: points, tax: settings.tax });
    let points = 0;
    if (customer) {
      const c = await ok(who, 'GET', `/api/customers/${customer.id}`);
      const before = calc(0);
      if (c.points > 0 && R.chance(0.4)) points = Math.min(c.points, R.int(1, c.points), before.net);
    }
    const t = calc(points);
    const total = t.total;
    let payments;
    if (total === 0) payments = [];
    else if (R.chance(0.25) && total > 1) { const part = R.int(1, total - 1); payments = [{ typeId: 'qi', amount: part }, { typeId: 'cash', amount: total - part }]; }
    else payments = [{ typeId: R.chance(0.6) ? 'cash' : 'qi', amount: total }];
    const body = { clientId: randomUUID(), lines, discountIds, customerId: customer?.id ?? null, pointsRedeemed: points, clientTotal: total, payments, diningOption: 'dine_in' };
    if (R.chance(0.08)) body.offlineAt = new Date(now().getTime() - R.int(1, 20) * 60000).toISOString();
    const r = await call(who, 'POST', '/api/sales', body);
    if (r.status !== 200) { reject(r.body.error); return; }
    const receipt = r.body.receipt;
    assert.equal(receipt.totals.total, total, 'الخادم والجهاز يتفقان على المجموع');
    // إعادة الإرسال بنفس المعرف: نفس الإيصال ولا أثر إضافي
    if (R.chance(0.15)) {
      stats.replay += 1;
      const again = await ok(who, 'POST', '/api/sales', body);
      assert.equal(again.duplicate, true);
      assert.equal(again.receipt.id, receipt.id);
    }
    sales.set(receipt.id, receipt);
    refundsOf.set(receipt.id, []);
    if (receipt.shiftId === shift.id) shift.cashIn += cashOf(receipt);
    days.add(localDate(receipt.createdAt, TZ));
    stats.sale += 1;
  }

  async function doRefund(cancel) {
    const open = [...sales.values()].filter((s) => s.lines.some((l, i) => l.qty > refunded(s.id, i)));
    if (!open.length) return;
    const who = cancel ? R.pick(staff) : R.pick(['owner', 'mgr']);
    const candidates = cancel && who === 'sara' ? open.filter((s) => s.shiftId === shift.id) : open;
    if (!candidates.length) return;
    const sale = R.pick(candidates);
    const lines = [];
    sale.lines.forEach((l, i) => { const left = l.qty - refunded(sale.id, i); if (left > 0 && R.chance(0.6)) lines.push({ index: i, qty: R.int(1, left) }); });
    if (!lines.length) { const i = sale.lines.findIndex((l, j) => l.qty > refunded(sale.id, j)); lines.push({ index: i, qty: 1 }); }
    const body = { clientId: randomUUID(), lines, reason: cancel ? 'لم يستلمه الزبون' : 'طلب خاطئ', cancel, restock: R.chance(0.5), restockIngredients: R.chance(0.5) };
    if (R.chance(0.3)) body.paymentTypeId = R.pick(['cash', 'qi']);
    const r = await call(who, 'POST', `/api/receipts/${sale.id}/refund`, body);
    if (r.status !== 200) { reject(r.body.error); return; }
    const refund = r.body.receipt;
    if (R.chance(0.15)) {
      stats.replay += 1;
      const again = await ok(who, 'POST', `/api/receipts/${sale.id}/refund`, body);
      assert.equal(again.duplicate, true);
    }
    refundsOf.get(sale.id).push(refund);
    sales.set(sale.id, await ok('owner', 'GET', `/api/receipts/${sale.id}`));
    if (refund.shiftId === shift.id) shift.cashOut += cashOf(refund);
    days.add(localDate(refund.createdAt, TZ));
    stats[cancel ? 'cancel' : 'refund'] += 1;
  }

  const refunded = (saleId, index) => refundsOf.get(saleId).flatMap((r) => r.lines).filter((l) => l.index === index).reduce((a, l) => a + l.qty, 0);

  async function doExpense() {
    const fromDrawer = R.chance(0.5);
    const amount = R.int(1, 60) * 250;
    const body = { clientId: randomUUID(), amount, category: R.pick(['rent', 'salaries', 'utilities', 'supplies', 'maintenance', 'other']), note: 'محاكاة', fromDrawer };
    const r = await call(R.pick(['owner', 'mgr']), 'POST', '/api/admin/expenses', body);
    if (r.status !== 200) { reject(r.body.error); return; }
    if (R.chance(0.15)) { stats.replay += 1; await ok('owner', 'POST', '/api/admin/expenses', body); }
    expenses.set(r.body.id, { amount, day: r.body.day, fromDrawer, shiftId: fromDrawer ? shift.id : null });
    if (fromDrawer) shift.payOut += amount;
    stats.expense += 1;
  }

  async function doDeleteExpense() {
    const ids = [...expenses.keys()];
    if (!ids.length) return;
    const id = R.pick(ids);
    const r = await call('owner', 'DELETE', `/api/admin/expenses/${id}`);
    if (r.status !== 200) { reject(r.body.error); return; }
    const e = expenses.get(id);
    // مصروف من الدرج حُذف في نفس الوردية: يعود المبلغ للدرج المتوقع
    if (e.fromDrawer && e.shiftId === shift.id) shift.payOut -= e.amount;
    expenses.delete(id);
    stats.expenseDel += 1;
  }

  async function doMove(type) {
    const amount = R.int(1, 40) * 250;
    const body = { clientId: randomUUID(), type, amount, note: type === 'pay_in' ? 'فكة' : 'ثلج' };
    const who = R.pick(['owner', 'mgr']);
    const r = await call(who, 'POST', '/api/shifts/move', body);
    if (r.status !== 200) { reject(r.body.error); return; }
    if (R.chance(0.2)) { stats.replay += 1; await ok(who, 'POST', '/api/shifts/move', body); }
    if (type === 'pay_in') { shift.payIn += amount; stats.payIn += 1; } else { shift.payOut += amount; stats.payOut += 1; }
  }

  async function doClose() {
    const cur = await ok('sara', 'GET', '/api/shifts/current');
    const expected = shift.starting + shift.cashIn - shift.cashOut + shift.payIn - shift.payOut;
    assert.equal(cur.live.expectedCash, expected, `النقد المتوقع للوردية #${shift.number}`);
    const diff = R.chance(0.6) ? 0 : Math.max(-expected, R.int(-4, 4) * 250) || 0;
    const closed = await ok('sara', 'POST', '/api/shifts/close', { actualCash: expected + diff, note: diff ? 'فرق عدّ' : undefined });
    assert.equal(closed.difference, diff);
    assert.equal(closed.summary.expectedCash, expected);
    closedShifts.push({ ...shift, actual: expected + diff, diff });
    shift = null;
    stats.close += 1;
  }

  async function doInventory() {
    const inv = await ok('owner', 'GET', '/api/admin/inventory');
    const row = R.pick(inv.rows);
    const kind = R.pick(['receive', 'receive', 'loss', 'count']);
    const body = { clientId: randomUUID(), variantId: row.variantId, type: kind, qty: kind === 'count' ? R.int(0, 3000) : R.int(1, 500), note: kind === 'loss' ? 'انسكب' : null };
    if (kind === 'receive' && R.chance(0.7)) body.cost = `${R.int(0, 40)}.${R.int(0, 999)}`;
    const r = await call('owner', 'POST', '/api/admin/inventory/adjust', body);
    if (r.status !== 200) { reject(r.body.error); return; }
    if (R.chance(0.2)) { stats.replay += 1; assert.equal((await ok('owner', 'POST', '/api/admin/inventory/adjust', body)).applied, false); }
    stats[kind] += 1;
  }

  async function doTax() {
    const tax = R.pick([{ mode: 'none', rateBp: 0 }, { mode: 'added', rateBp: R.int(1, 2000) }, { mode: 'included', rateBp: R.int(1, 2000) }]);
    await ok('owner', 'PUT', '/api/admin/settings', { tax: { ...tax, name: 'ضريبة' } });
    ({ settings, catalog } = await ok('owner', 'GET', '/api/pos/bootstrap'));
    stats.tax += 1;
  }

  // ------------------------------------------------------------ الفحوص
  async function checkInvariants(label) {
    const all = await db.collection('receipts').find({}).toArray();
    for (const r of all) {
      const T = r.totals;
      for (const k of ['gross', 'discountTotal', 'net', 'tax', 'total', 'cost']) assert.ok(isMoney(T[k]) && T[k] >= 0, `${label}: ${k} صحيح موجب في #${r.number}`);
      assert.equal(r.lines.reduce((a, l) => a + l.gross, 0), T.gross, `${label}: مجموع الأسطر = الإجمالي #${r.number}`);
      assert.equal(r.lines.reduce((a, l) => a + l.net, 0), T.net, `${label}: صافي #${r.number}`);
      assert.equal(r.lines.reduce((a, l) => a + l.tax, 0), T.tax, `${label}: ضريبة #${r.number}`);
      assert.equal(r.lines.reduce((a, l) => a + l.total, 0), T.total, `${label}: مجموع #${r.number}`);
      assert.equal(r.lines.reduce((a, l) => a + l.cost, 0), T.cost, `${label}: تكلفة #${r.number}`);
      assert.equal(T.total, T.taxMode === 'added' ? T.net + T.tax : T.net, `${label}: الإجمالي حسب نوع الضريبة #${r.number}`);
      assert.equal(r.payments.reduce((a, p) => a + p.amount, 0), T.total, `${label}: الدفعات = الإجمالي #${r.number}`);
      for (const l of r.lines) {
        assert.equal(l.gross - l.discount, l.net, `${label}: سطر صافي = إجمالي − خصم #${r.number}`);
        assert.ok(l.net >= 0 && l.discount >= 0 && l.tax >= 0, `${label}: لا قيم سالبة #${r.number}`);
      }
      if (r.type === 'sale') {
        assert.equal(T.gross - T.discountTotal, T.net, `${label}: الخصم الكلي #${r.number}`);
        const refunds = all.filter((x) => x.refundOf === r._id);
        const refundedTotal = refunds.reduce((a, x) => a + x.totals.total, 0);
        assert.equal(r.refundTotal, refundedTotal, `${label}: refundTotal #${r.number}`);
        assert.ok(refundedTotal <= T.total, `${label}: المسترجع لا يتجاوز البيع #${r.number}`);
        r.lines.forEach((l, i) => {
          const parts = refunds.flatMap((x) => x.lines).filter((x) => x.index === i);
          const q = parts.reduce((a, x) => a + x.qty, 0);
          assert.equal(l.refundedQty, q, `${label}: كمية مسترجعة #${r.number}/${i}`);
          assert.ok(q <= l.qty);
          const s = (k) => parts.reduce((a, x) => a + x[k], 0);
          for (const k of ['gross', 'net', 'tax', 'total']) assert.ok(s(k) <= l[k], `${label}: ${k} المسترجع ≤ السطر #${r.number}/${i}`);
          assert.ok(s('cost') + parts.reduce((a, x) => a + (x.wasteCost ?? 0), 0) <= l.cost, `${label}: التكلفة المسترجعة ≤ السطر #${r.number}/${i}`);
          if (q === l.qty) {
            for (const k of ['gross', 'net', 'tax', 'total']) assert.equal(s(k), l[k], `${label}: استرجاع كامل يساوي السطر بالضبط (${k}) #${r.number}/${i}`);
            assert.equal(s('cost') + parts.reduce((a, x) => a + (x.wasteCost ?? 0), 0), l.cost, `${label}: التكلفة + الهدر = تكلفة السطر #${r.number}/${i}`);
          }
        });
        const fully = r.lines.every((l) => l.refundedQty >= l.qty);
        const any = r.lines.some((l) => l.refundedQty > 0);
        assert.equal(r.status, fully ? 'refunded' : any ? 'partially_refunded' : 'paid', `${label}: حالة #${r.number}`);
        if (r.customerId) {
          const reversed = refunds.reduce((a, x) => a + (x.pointsReversed ?? 0), 0);
          assert.ok(reversed <= r.pointsEarned, `${label}: النقاط المعكوسة ≤ المكتسبة #${r.number} (${reversed} > ${r.pointsEarned})`);
          if (fully) assert.equal(reversed, r.pointsEarned, `${label}: استرجاع كامل يعكس كل النقاط #${r.number}`);
        }
        // الدفع لكل طريقة: بلا اختيار صريح لا يُرجع لطريقة أكثر مما دُفع بها
        if (!refunds.some((x) => x.explicitPayment)) for (const p of r.payments) {
          const back = refunds.flatMap((x) => x.payments).filter((x) => x.typeId === p.typeId).reduce((a, x) => a + x.amount, 0);
          const paid = r.payments.filter((x) => x.typeId === p.typeId).reduce((a, x) => a + x.amount, 0);
          assert.ok(back <= paid, `${label}: المُرجع بـ${p.typeName} (${back}) ≤ المدفوع به (${paid}) #${r.number}`);
        }
      }
    }
    // المخزون = دفتر الحركات
    const variants = await db.collection('variants').find({ trackStock: true }).toArray();
    const moves = await db.collection('stock_moves').find({}).toArray();
    for (const v of variants) {
      const sum = moves.filter((m) => m.variantId === v._id).reduce((a, m) => a + m.delta, 0);
      assert.equal(v.stock, sum, `${label}: رصيد ${v.name || v._id} = دفتر الحركات`);
      assert.ok(isMoney(v.costMilli) && v.costMilli >= 0, `${label}: تكلفة الوحدة صحيحة`);
    }
    // النقاط = دفتر النقاط
    for (const c of await db.collection('customers').find({}).toArray()) {
      const pm = await db.collection('point_moves').find({ customerId: c._id }).toArray();
      assert.equal(c.points, pm.reduce((a, m) => a + m.delta, 0), `${label}: نقاط ${c.name} = دفترها`);
      assert.ok(c.points >= 0, `${label}: نقاط ${c.name} غير سالبة`);
    }
    // النقد المتوقع للوردية المفتوحة
    if (shift) {
      const cur = await ok('owner', 'GET', '/api/shifts/current');
      assert.equal(cur.live.expectedCash, shift.starting + shift.cashIn - shift.cashOut + shift.payIn - shift.payOut, `${label}: النقد المتوقع`);
      assert.ok(cur.live.expectedCash >= 0, `${label}: الدرج لا يصبح سالباً`);
    }
  }

  async function checkReports() {
    const all = await db.collection('receipts').find({}).toArray();
    const sorted = [...days].sort();
    const agg = { net: 0, gross: 0, tax: 0, cogs: 0, profit: 0, expenses: 0, waste: 0 };
    for (const day of sorted) {
      const d = await ok('owner', 'GET', '/api/admin/reports/daily', null, { date: day });
      const inDay = all.filter((r) => localDate(r.createdAt, TZ) === day);
      const sign = (r) => (r.type === 'refund' ? -1 : 1);
      const net = inDay.reduce((a, r) => a + sign(r) * r.totals.net, 0);
      const tax = inDay.reduce((a, r) => a + sign(r) * r.totals.tax, 0);
      const cogs = inDay.reduce((a, r) => a + sign(r) * r.totals.cost, 0);
      const incl = inDay.reduce((a, r) => a + (r.totals.taxMode === 'included' ? sign(r) * r.totals.tax : 0), 0);
      const total = inDay.reduce((a, r) => a + sign(r) * r.totals.total, 0);
      const waste = inDay.reduce((a, r) => a + (r.wasteCost ?? 0), 0);
      const exp = [...expenses.values()].filter((e) => e.day === day).reduce((a, e) => a + e.amount, 0);
      const S = d.summary;
      assert.equal(S.net, net, `${day}: صافي المبيعات`);
      assert.equal(S.tax, tax, `${day}: الضريبة`);
      assert.equal(S.cogs, cogs, `${day}: تكلفة البضاعة`);
      assert.equal(S.profit, net - incl - cogs, `${day}: الربح الإجمالي`);
      assert.equal(S.expenses, exp, `${day}: المصروفات`);
      assert.equal(S.netProfit, S.profit - exp, `${day}: صافي الربح`);
      assert.equal(S.wasteCost, waste, `${day}: الهدر`);
      assert.equal(S.gross - S.refunds - S.discounts, S.net, `${day}: إجمالي − مرتجعات − خصومات = صافي`);
      assert.equal(d.byPayment.reduce((a, p) => a + p.net, 0), total, `${day}: طرق الدفع = المحصّل`);
      assert.equal(d.byItem.reduce((a, i) => a + i.net, 0), net, `${day}: الأصناف = الصافي`);
      assert.equal(S.salesCount, inDay.filter((r) => r.type === 'sale').length, `${day}: عدد الإيصالات`);
      assert.equal(d.cancelled.length, inDay.filter((r) => r.type === 'refund' && r.cancel).length, `${day}: الإلغاءات`);
      for (const k of Object.keys(agg)) agg[k] += { net, gross: S.gross, tax, cogs, profit: S.profit, expenses: exp, waste }[k];
    }
    // تقرير الفترة = مجموع الأيام
    const range = await ok('owner', 'GET', '/api/admin/reports', null, { from: sorted[0], to: sorted.at(-1) });
    assert.equal(range.summary.net, agg.net, 'الفترة: الصافي = مجموع الأيام');
    assert.equal(range.summary.gross, agg.gross, 'الفترة: الإجمالي');
    assert.equal(range.summary.tax, agg.tax, 'الفترة: الضريبة');
    assert.equal(range.summary.cogs, agg.cogs, 'الفترة: التكلفة');
    assert.equal(range.summary.profit, agg.profit, 'الفترة: الربح');
    assert.equal(range.summary.expenses, agg.expenses, 'الفترة: المصروفات');
    assert.equal(range.summary.netProfit, agg.profit - agg.expenses, 'الفترة: صافي الربح');
    assert.equal(range.summary.wasteCost, agg.waste, 'الفترة: الهدر');
    assert.equal(range.byCategory.reduce((a, c) => a + c.net, 0), agg.net, 'الفترة: التصنيفات = الصافي');
    assert.equal(range.byEmployee.reduce((a, c) => a + c.net, 0), agg.net, 'الفترة: الموظفون = الصافي');
    assert.equal(range.byDay.reduce((a, c) => a + c.net, 0), agg.net, 'الفترة: الأيام = الصافي');
    // كل وردية مغلقة: ملخصها المخزّن = إعادة الحساب من الإيصالات والحركات
    const shifts = await db.collection('shifts').find({ status: 'closed' }).toArray();
    for (const sh of shifts) {
      const rs = all.filter((r) => r.shiftId === sh._id);
      const cash = (r) => r.payments.filter((p) => p.kind === 'cash').reduce((a, p) => a + p.amount, 0);
      const cashSales = rs.filter((r) => r.type === 'sale').reduce((a, r) => a + cash(r), 0);
      const cashRefunds = rs.filter((r) => r.type === 'refund').reduce((a, r) => a + cash(r), 0);
      const pin = sh.movements.filter((m) => m.type === 'pay_in').reduce((a, m) => a + m.amount, 0);
      const pout = sh.movements.filter((m) => m.type === 'pay_out').reduce((a, m) => a + m.amount, 0);
      assert.equal(sh.summary.expectedCash, sh.startingCash + cashSales - cashRefunds + pin - pout, `وردية #${sh.number}: المتوقع المخزّن = إعادة الحساب`);
      assert.equal(sh.difference, sh.actualCash - sh.summary.expectedCash, `وردية #${sh.number}: الفرق`);
    }
    // المخزون: المطابقة لا تجد ما تصلحه
    assert.deepEqual((await ok('owner', 'POST', '/api/admin/inventory/reconcile', {})).fixed, [], 'لا انحراف بين الرصيد والدفتر');
  }

  // ------------------------------------------------------------ التشغيل
  await openShift();
  for (let step = 0; step < steps; step++) {
    tick(R.int(1, 25) * 60000);
    const hour = new Date(now().getTime() + TZ * 60000).getUTCHours();
    if (!shift) await openShift();
    const roll = R.next();
    if (roll < 0.5) await doSale(R.pick(staff));
    else if (roll < 0.6) await doRefund(false);
    else if (roll < 0.68) await doRefund(true);
    else if (roll < 0.74) await doExpense();
    else if (roll < 0.76) await doDeleteExpense();
    else if (roll < 0.8) await doMove('pay_in');
    else if (roll < 0.85) await doMove('pay_out');
    else if (roll < 0.9) await doInventory();
    else if (roll < 0.91) await doTax();
    else if (roll < 0.93) { const s = R.pick([...sales.values()]); if (s?.prep && ['new', 'preparing', 'ready'].includes(s.prep.status)) await call('sara', 'POST', `/api/kds/${s.id}/advance`, { from: s.prep.status }); }
    if (hour >= 23 || R.chance(0.02)) { await doClose(); tick(R.int(6, 9) * 3600000); }
    if (step % 10 === 9) await checkInvariants(`خطوة ${step + 1}`);
  }
  if (shift) await doClose();
  await checkInvariants('النهاية');
  await checkReports();
  return stats;
}

// SIM_SEEDS=30 لتشغيل موسّع (يدوياً قبل الإصدارات): بذور إضافية وخطوات أطول
const extra = Number(process.env.SIM_SEEDS ?? 0);
const seeds = extra ? Array.from({ length: extra }, (_, i) => 1000 + i * 7919) : [11, 2024, 777];
for (const seed of seeds) {
  test(`محاكاة استخدام حقيقي (بذرة ${seed}): كل الحسابات متطابقة`, { timeout: 240_000 }, async () => {
    const stats = await simulate(seed, extra ? 900 : 450);
    assert.ok(stats.sale > 150 && stats.refund + stats.cancel > 40 && stats.expense > 10 && stats.close >= 2, JSON.stringify(stats));
  });
}
