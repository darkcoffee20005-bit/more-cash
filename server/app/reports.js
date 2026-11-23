// التقارير ولوحة المتابعة: تُبنى من الإيصالات في الفترة (فهرس createdAt) عبر shared/reports.js.
import { costOf } from '../../shared/calc.js';
import { dayRange, localDate } from '../../shared/format.js';
import { buildReport } from '../../shared/reports.js';
import { bad, getSettings, requirePerm } from './core.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** نقص المخزون في فترة (هدر مسجّل + فروقات جرد + تعديلات) بقيمته لحظة الحركة: موجب = خسارة تُطرح من صافي الربح */
export async function stockLossBetween(db, fromDate, toDate) {
  const moves = await db.collection('stock_moves').find({ at: { $gte: fromDate, $lt: toDate }, reason: { $in: ['loss', 'count', 'adjust'] } }).project({ value: 1 }).toArray();
  return -moves.reduce((a, m) => a + (m.value ?? 0), 0) || 0;
}

export function createReports(ctx) {
  const { db, now } = ctx;

  async function range(from, to) {
    const settings = await getSettings(db);
    if (!DATE.test(from ?? '') || !DATE.test(to ?? '')) throw bad('INVALID_RANGE');
    let r;
    try { r = dayRange(from, to, settings.tzOffsetMin); } catch { throw bad('INVALID_RANGE'); }
    if (r.to - r.from > 400 * 86400000) throw bad('RANGE_TOO_LONG');
    return { ...r, settings };
  }

  async function receiptsIn(fromDate, toDate) {
    return db.collection('receipts').find({ createdAt: { $gte: fromDate, $lt: toDate } })
      .project({ clientId: 0, effectsPending: 0, prep: 0 }).toArray();
  }

  async function report(actor, { from, to } = {}) {
    requirePerm(actor, 'admin.reports');
    const r = await range(from, to);
    const receipts = await receiptsIn(r.from, r.to);
    const rep = buildReport(receipts, { tzOffsetMin: r.settings.tzOffsetMin });
    const exp = await ctx.expenses.totalBetween(from, to);
    // صافي الربح = الربح الإجمالي − المصروفات − نقص المخزون (هدر وفروقات جرد)
    rep.summary.expenses = exp.total;
    rep.summary.stockLoss = await stockLossBetween(db, r.from, r.to);
    rep.summary.netProfit = rep.summary.profit - exp.total - rep.summary.stockLoss;
    return { from, to, ...rep };
  }

  /**
   * «إلى أين ذهبت فلوسك» في فترة: كل ما خرج نقداً (مصروفات، رواتب، سلف، مشتريات مخزون) وكل ما قلّل الربح بلا نقد
   * (تكلفة المبيعات، هدر الإلغاء، نقص المخزون، الخصومات)، والحوافز والغرامات المسجّلة. ملخص مرتبط بمصادره، لا قيود مكررة:
   * المشتريات لا تُحسب مصروفاً في صافي الربح (الربح يحسب تكلفة ما بيع فعلاً)، والحوافز تدخل الرواتب عند صرفها.
   */
  async function spending(actor, { from, to } = {}) {
    requirePerm(actor, 'admin.reports');
    const r = await range(from, to);
    const rep = buildReport(await receiptsIn(r.from, r.to), { tzOffsetMin: r.settings.tzOffsetMin });
    const exp = await db.collection('expenses').find({ day: { $gte: from, $lte: to } }).toArray();
    const sum = (list, f = (x) => x.amount) => list.reduce((a, x) => a + f(x), 0);
    const manual = exp.filter((e) => !e.ref);
    const byCategory = {};
    for (const e of manual) byCategory[e.category] = (byCategory[e.category] ?? 0) + e.amount;
    const moves = await db.collection('stock_moves').find({ at: { $gte: r.from, $lt: r.to }, reason: { $in: ['receive', 'receive_fix'] } }).toArray();
    let purchases = 0;
    let noCost = 0;
    for (const m of moves) {
      if (m.reason === 'receive') { if (m.unitCostMilli === undefined || m.unitCostMilli === null) noCost += 1; else purchases += costOf(m.delta, m.unitCostMilli); }
      else if (m.fixOf) purchases += costOf(m.fixOf.qty + m.delta, m.unitCostMilli) - costOf(m.fixOf.qty, m.fixOf.unitCostMilli ?? m.unitCostMilli);
    }
    const adj = await db.collection('hr_adjustments').find({ day: { $gte: from, $lte: to } }).toArray();
    const salaries = sum(exp.filter((e) => e.ref === 'payroll'));
    const advances = sum(exp.filter((e) => e.ref === 'advance'));
    const operating = sum(manual);
    const stockLoss = await stockLossBetween(db, r.from, r.to);
    const S = rep.summary;
    const expensesTotal = sum(exp);
    return {
      from, to,
      cash: { operating, byCategory, salaries, advances, purchases, purchasesNoCost: noCost, total: operating + salaries + advances + purchases },
      costs: { cogs: S.cogs, waste: S.wasteCost ?? 0, stockLoss, discounts: S.discounts },
      hr: { bonuses: sum(adj.filter((a) => a.type === 'bonus')), fines: sum(adj.filter((a) => a.type === 'fine')) },
      profit: { net: S.net, profit: S.profit, expenses: expensesTotal, stockLoss, netProfit: S.profit - expensesTotal - stockLoss },
    };
  }

  /** تقرير يوم واحد للمشاركة أو الطباعة: المبيعات + الموارد المصروفة (من دفتر المخزون) + النواقص */
  async function daily(actor, { date } = {}) {
    requirePerm(actor, 'admin.reports');
    const r = await range(date, date);
    const opts = { tzOffsetMin: r.settings.tzOffsetMin };
    const rep = buildReport(await receiptsIn(r.from, r.to), opts);
    const moves = await db.collection('stock_moves').find({ at: { $gte: r.from, $lt: r.to }, reason: { $in: ['sale', 'refund', 'loss'] } })
      .project({ variantId: 1, delta: 1, reason: 1 }).toArray();
    const use = new Map();
    for (const m of moves) {
      const u = use.get(m.variantId) ?? { used: 0, loss: 0 };
      if (m.reason === 'loss') u.loss -= m.delta; else u.used -= m.delta;
      use.set(m.variantId, u);
    }
    const tracked = await db.collection('variants').find({ trackStock: true, active: true }).toArray();
    const items = new Map((await db.collection('items').find({ _id: { $in: [...new Set(tracked.map((v) => v.itemId))] } }).toArray()).map((i) => [i._id, i]));
    const rows = tracked.filter((v) => items.get(v.itemId)?.active !== false).map((v) => {
      const item = items.get(v.itemId);
      const u = use.get(v._id) ?? { used: 0, loss: 0 };
      return {
        variantId: v._id, name: v.name ? `${item.name} — ${v.name}` : item.name, unit: item.unit ?? 'قطعة', ingredient: !item.forSale,
        used: u.used, loss: u.loss, cost: costOf(Math.max(0, u.used + u.loss), v.costMilli ?? 0), stock: v.stock, lowStock: v.lowStock, low: v.stock <= v.lowStock,
      };
    });
    const consumption = rows.filter((x) => x.used || x.loss)
      .sort((a, b) => Number(b.ingredient) - Number(a.ingredient) || b.cost - a.cost || a.name.localeCompare(b.name, 'ar'));
    const exp = await ctx.expenses.totalBetween(date, date);
    rep.summary.expenses = exp.total;
    rep.summary.stockLoss = await stockLossBetween(db, r.from, r.to);
    rep.summary.netProfit = rep.summary.profit - exp.total - rep.summary.stockLoss;
    const cancelled = (await db.collection('receipts').find({ type: 'refund', cancel: true, createdAt: { $gte: r.from, $lt: r.to } }).sort({ createdAt: 1 }).toArray())
      .map((x) => ({ number: x.number, saleNumber: x.refundOfNumber, at: x.createdAt, total: x.totals.total, wasteCost: x.wasteCost ?? 0, reason: x.reason, by: x.employeeName,
        items: x.lines.map((l) => `${l.qty}× ${l.itemName}${l.variantName ? ` ${l.variantName}` : ''}`).join('، ') }));
    return {
      cancelled,
      date, shopName: r.settings.name, summary: rep.summary, byPayment: rep.byPayment, byItem: rep.byItem,
      expenses: exp.rows.map((x) => ({ amount: x.amount, category: x.category, note: x.note ?? null })),
      consumption, consumptionCost: consumption.reduce((a, x) => a + x.cost, 0),
      lowStock: rows.filter((x) => x.low).sort((a, b) => a.name.localeCompare(b.name, 'ar')),
    };
  }

  /**
   * أفضل أيام العمل: متوسط صافي المبيعات وعدد الإيصالات لكل يوم من أيام الأسبوع في آخر 8 أسابيع.
   * المتوسط على عدد مرات ذلك اليوم في الفترة (حتى لو لم يُبع فيه شيء)، فلا يتضخم يوم عمل فيه مرة واحدة.
   */
  async function weekdays(settings, weeks = 8) {
    const tz = settings.tzOffsetMin;
    const today = localDate(now(), tz);
    const from = localDate(now().getTime() - (weeks * 7 - 1) * 86400000, tz);
    const r = dayRange(from, today, tz);
    const rep = buildReport(await receiptsIn(r.from, r.to), { tzOffsetMin: tz });
    const byDay = new Map(rep.byDay.map((d) => [d.key, d]));
    const out = Array.from({ length: 7 }, (_, i) => ({ weekday: i, net: 0, salesCount: 0, days: 0 }));
    for (let i = 0; i < weeks * 7; i++) {
      const key = localDate(Date.parse(`${from}T12:00:00Z`) + i * 86400000, 0);
      const wd = new Date(`${key}T12:00:00Z`).getUTCDay();
      const d = byDay.get(key);
      out[wd].days += 1;
      if (d) { out[wd].net += d.net; out[wd].salesCount += d.salesCount; }
    }
    for (const w of out) { w.avgNet = w.days ? Math.round(w.net / w.days) : 0; w.avgSales = w.days ? Math.round((w.salesCount / w.days) * 10) / 10 : 0; }
    return { from, to: today, weeks, days: out };
  }

  async function dashboard(actor) {
    requirePerm(actor, 'admin.reports');
    const settings = await getSettings(db);
    const today = localDate(now(), settings.tzOffsetMin);
    const yesterday = localDate(now().getTime() - 86400000, settings.tzOffsetMin);
    const weekAgo = localDate(now().getTime() - 6 * 86400000, settings.tzOffsetMin);
    const t = dayRange(today, today, settings.tzOffsetMin);
    const y = dayRange(yesterday, yesterday, settings.tzOffsetMin);
    const w = dayRange(weekAgo, today, settings.tzOffsetMin);
    const [todayR, yesterdayR, weekR] = await Promise.all([receiptsIn(t.from, t.to), receiptsIn(y.from, y.to), receiptsIn(w.from, w.to)]);
    const opts = { tzOffsetMin: settings.tzOffsetMin };
    const todayRep = buildReport(todayR, opts);
    const weekRep = buildReport(weekR, opts);
    const tracked = await db.collection('variants').find({ active: true, trackStock: true }).project({ stock: 1, lowStock: 1 }).toArray();
    return {
      weekdays: await weekdays(settings),
      today, todaySummary: todayRep.summary, yesterdaySummary: buildReport(yesterdayR, opts).summary,
      byHour: todayRep.byHour, topItems: todayRep.byItem.slice(0, 6), byPayment: todayRep.byPayment,
      week: fillDays(weekRep.byDay, weekAgo, 7),
      lowStock: tracked.filter((v) => v.stock <= v.lowStock).length,
      openShift: await db.collection('shifts').findOne({ status: 'open' }, { projection: { number: 1, openedAt: 1, openedByName: 1 } }),
      openTickets: await db.collection('tickets').countDocuments({}),
    };
  }

  return { report, daily, dashboard, spending };
}

function fillDays(byDay, startDate, n) {
  const map = new Map(byDay.map((d) => [d.key, d]));
  const outDays = [];
  for (let i = 0; i < n; i++) {
    const key = new Date(new Date(`${startDate}T00:00:00Z`).getTime() + i * 86400000).toISOString().slice(0, 10);
    outDays.push({ key, net: map.get(key)?.net ?? 0, salesCount: map.get(key)?.salesCount ?? 0 });
  }
  return outDays;
}
