// المصروفات (إيجار، رواتب، كهرباء…): تُطرح من الربح الإجمالي ليظهر صافي الربح الحقيقي.
// المصروف المدفوع من درج النقد يُسجَّل أيضاً كسحب من الوردية المفتوحة حتى يبقى النقد المتوقع صحيحاً.
import { AppError, audit, bad, getSettings, id as checkId, int, isDup, notFound, oneOf, requirePerm, str } from './core.js';
import { localDate } from '../../shared/format.js';

export const EXPENSE_CATEGORIES = Object.freeze({
  rent: 'إيجار', salaries: 'رواتب', utilities: 'كهرباء وماء', supplies: 'مشتريات', maintenance: 'صيانة', other: 'أخرى',
});
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function createExpenses(ctx) {
  const { db, now, newId } = ctx;
  const C = () => db.collection('expenses');

  async function create(actor, input = {}) {
    requirePerm(actor, 'admin.reports');
    const clientId = checkId(input.clientId, 'clientId');
    const prior = await C().findOne({ clientId });
    if (prior) return view(prior);
    const amount = int(input.amount, { field: 'amount', min: 1, max: 1_000_000_000 });
    const category = oneOf(input.category, Object.keys(EXPENSE_CATEGORIES), 'category');
    const note = str(input.note, { field: 'note', max: 120, optional: true });
    const settings = await getSettings(db);
    const today = localDate(now(), settings.tzOffsetMin);
    const day = input.date ? String(input.date) : today;
    if (!DATE.test(day) || day > today) throw bad('INVALID_DATE', 'date');
    const fromDrawer = input.fromDrawer === true;
    if (fromDrawer) {
      if (day !== today) throw bad('DRAWER_ONLY_TODAY');
      // سحب من الدرج بنفس المفتاح: إعادة المحاولة لا تسحب مرتين
      await ctx.shifts.move(actor, { type: 'pay_out', clientId: `exp-${clientId}`.slice(0, 64), amount, note: `مصروف: ${EXPENSE_CATEGORIES[category]}${note ? ` — ${note}` : ''}`.slice(0, 120) });
    }
    const doc = { _id: newId(), clientId, amount, category, note, day, fromDrawer, by: actor.id, byName: actor.name, createdAt: now() };
    try {
      await C().insertOne(doc);
    } catch (e) {
      if (isDup(e)) return view(await C().findOne({ clientId }));
      throw e;
    }
    await audit({ ...ctx, actor }, 'expense.create', { amount, category: EXPENSE_CATEGORIES[category], note, fromDrawer });
    return view(doc);
  }

  async function list(actor, { from, to } = {}) {
    requirePerm(actor, 'admin.reports');
    if (!DATE.test(from ?? '') || !DATE.test(to ?? '') || from > to) throw new AppError(400, 'INVALID_RANGE');
    const rows = await C().find({ day: { $gte: from, $lte: to } }).sort({ day: -1, createdAt: -1 }).limit(1000).toArray();
    const byCategory = {};
    for (const r of rows) byCategory[r.category] = (byCategory[r.category] ?? 0) + r.amount;
    return { rows: rows.map(view), total: rows.reduce((a, r) => a + r.amount, 0), byCategory };
  }

  /** مجموع المصروفات في فترة (للتقارير) */
  async function totalBetween(from, to) {
    const rows = await C().find({ day: { $gte: from, $lte: to } }).project({ amount: 1, category: 1, note: 1, day: 1 }).toArray();
    return { total: rows.reduce((a, r) => a + r.amount, 0), rows };
  }

  async function remove(actor, expenseId) {
    requirePerm(actor, 'admin.reports');
    const doc = await C().findOne({ _id: checkId(expenseId) });
    if (!doc) throw notFound();
    await C().deleteOne({ _id: doc._id });
    // السحب من الدرج (إن وُجد) يبقى في الوردية: النقد خرج فعلاً
    await audit({ ...ctx, actor }, 'expense.delete', { amount: doc.amount, category: EXPENSE_CATEGORIES[doc.category], note: doc.note, day: doc.day });
    return { ok: true };
  }

  return { create, list, remove, totalBetween };
}

function view(d) {
  return { id: d._id, amount: d.amount, category: d.category, categoryName: EXPENSE_CATEGORIES[d.category], note: d.note, day: d.day, fromDrawer: d.fromDrawer, byName: d.byName, createdAt: d.createdAt };
}
