// التقارير ولوحة المتابعة: تُبنى من الإيصالات في الفترة (فهرس createdAt) عبر shared/reports.js.
import { dayRange, localDate } from '../../shared/format.js';
import { buildReport } from '../../shared/reports.js';
import { bad, getSettings, requirePerm } from './core.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

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
    return { from, to, ...buildReport(receipts, { tzOffsetMin: r.settings.tzOffsetMin }) };
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
      today, todaySummary: todayRep.summary, yesterdaySummary: buildReport(yesterdayR, opts).summary,
      byHour: todayRep.byHour, topItems: todayRep.byItem.slice(0, 6), byPayment: todayRep.byPayment,
      week: fillDays(weekRep.byDay, weekAgo, 7),
      lowStock: tracked.filter((v) => v.stock <= v.lowStock).length,
      openShift: await db.collection('shifts').findOne({ status: 'open' }, { projection: { number: 1, openedAt: 1, openedByName: 1 } }),
      openTickets: await db.collection('tickets').countDocuments({}),
    };
  }

  return { report, dashboard };
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
