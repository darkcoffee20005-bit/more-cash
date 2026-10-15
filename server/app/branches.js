// الفروع: حساب مالك واحد يملك عدة مقاهٍ (كل فرع مقهى مستقل بموظفيه ومخزونه وإيصالاته).
// إنشاء فرع (مع نسخ القائمة اختيارياً)، تبديل فرع الجهاز، وتقرير مجمّع لكل الفروع.
// يعمل على مستوى المنصة لأنه يعبر بين المقاهي، لكنه لا يقرأ إلا فروع الحساب نفسه.
import { buildReport } from '../../shared/reports.js';
import { dayRange } from '../../shared/format.js';
import { AppError, bad, getSettings, id as checkId, str } from './core.js';
import { normalizePin, validPin } from './security.js';
import { scopeDb } from '../db/scoped.js';

const MAX_BRANCHES = 20;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// إعدادات تُنسخ للفرع الجديد (الاسم والعنوان والهاتف خاصة بكل فرع)
const COPY_SETTINGS = ['tax', 'loyalty', 'paymentTypes', 'diningOptions', 'features', 'receipt', 'cashVarianceAlert', 'reportPhone', 'tzOffsetMin', 'currency'];

export const branchIds = (acc) => (Array.isArray(acc?.branches) && acc.branches.length ? acc.branches : [acc.tenantId]);

export function createBranches({ db, now, newId, appFor, forgetApp }) {
  /** المالك فقط، ومن جهاز مربوط بأحد فروعه */
  async function ownerContext(device, token) {
    const app = await appFor(device.tenantId);
    const actor = await app.ctx.services.auth.resolve(token);
    if (!actor || actor.role !== 'owner') throw new AppError(403, 'FORBIDDEN', 'branches');
    const acc = await db.collection('accounts').findOne({ _id: device.accountId });
    if (!acc) throw new AppError(401, 'NO_SHOP');
    return { app, actor, acc, ids: branchIds(acc) };
  }

  async function summaryOf(tenantId, from, to) {
    const sdb = scopeDb(db, tenantId);
    const settings = await getSettings(sdb);
    const r = dayRange(from, to, settings.tzOffsetMin);
    const receipts = await sdb.collection('receipts').find({ createdAt: { $gte: new Date(r.from), $lt: new Date(r.to) } }).project({ clientId: 0, prep: 0 }).toArray();
    const rep = buildReport(receipts, { tzOffsetMin: settings.tzOffsetMin });
    const exp = await sdb.collection('expenses').find({ day: { $gte: from, $lte: to } }).project({ amount: 1 }).toArray();
    const expenses = exp.reduce((a, x) => a + x.amount, 0);
    const s = rep.summary;
    return { net: s.net, gross: s.gross, salesCount: s.salesCount, refunds: s.refunds, profit: s.profit, expenses, netProfit: s.profit - expenses, cashNet: s.cashNet, avgSale: s.avgSale };
  }

  async function list(device, token) {
    const { ids } = await ownerContext(device, token);
    const tenants = await db.collection('tenants').find({ _id: { $in: ids } }).toArray();
    const byId = new Map(tenants.map((t) => [t._id, t]));
    return ids.filter((id) => byId.has(id)).map((id) => ({ id, name: byId.get(id).name, current: id === device.tenantId, disabled: !!byId.get(id).disabled }));
  }

  async function create(device, token, body = {}) {
    const { app, acc, ids } = await ownerContext(device, token);
    if (ids.length >= MAX_BRANCHES) throw bad('TOO_MANY_BRANCHES');
    const name = str(body.name, { field: 'name', min: 2, max: 60 });
    const pin = normalizePin(body.pin);
    if (!validPin(pin)) throw bad('WEAK_PIN');
    const tenantId = newId();
    await db.collection('tenants').insertOne({ _id: tenantId, name, ownerAccountId: acc._id, branchOf: acc.tenantId, createdAt: now() });
    try {
      const target = await appFor(tenantId);
      const copyMenu = body.copyMenu !== false;
      await target.ctx.services.auth.setup({ storeName: name, ownerName: acc.name, pin, seed: !copyMenu });
      if (copyMenu) await copyCatalog(app.ctx.db, target.ctx.db);
      await db.collection('accounts').updateOne({ _id: acc._id }, { $set: { branches: [...ids, tenantId] } });
    } catch (e) {
      // لا نترك فرعاً نصف منشأ
      await db.collection('tenants').deleteOne({ _id: tenantId }).catch(() => {});
      for (const c of ['settings', 'employees', 'categories', 'modifiers', 'discounts', 'items', 'variants', 'stock_moves', 'audit', 'counters']) {
        await db.collection(c).deleteMany({ tenantId }).catch(() => {});
      }
      forgetApp(tenantId);
      throw e;
    }
    return { id: tenantId, name };
  }

  /** تبديل فرع هذا الجهاز: يُسجَّل خروج الموظف الحالي ويُطلب رمز الدخول في الفرع الآخر */
  async function switchTo(device, token, body = {}) {
    const { ids } = await ownerContext(device, token);
    const target = checkId(body.tenantId, 'tenantId');
    if (!ids.includes(target)) throw new AppError(403, 'FORBIDDEN', 'branch');
    await db.collection('devices').updateOne({ _id: device._id }, { $set: { tenantId: target } });
    const t = await db.collection('tenants').findOne({ _id: target });
    return { shop: { id: target, name: t?.name ?? '' } };
  }

  async function report(device, token, { from, to } = {}) {
    const { ids } = await ownerContext(device, token);
    if (!DATE.test(from ?? '') || !DATE.test(to ?? '') || from > to) throw new AppError(400, 'INVALID_RANGE');
    const tenants = new Map((await db.collection('tenants').find({ _id: { $in: ids } }).toArray()).map((t) => [t._id, t]));
    const rows = [];
    for (const id of ids) {
      if (!tenants.has(id)) continue;
      rows.push({ id, name: tenants.get(id).name, current: id === device.tenantId, ...(await summaryOf(id, from, to)) });
    }
    const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
    const totals = { net: sum('net'), gross: sum('gross'), salesCount: sum('salesCount'), refunds: sum('refunds'), profit: sum('profit'), expenses: sum('expenses'), netProfit: sum('netProfit'), cashNet: sum('cashNet') };
    totals.avgSale = totals.salesCount ? Math.round(totals.net / totals.salesCount) : 0;
    return { from, to, rows, totals };
  }

  return { list, create, switchTo, report };
}

/** نسخ القائمة (تصنيفات، إضافات، خصومات، أصناف بأحجامها ووصفاتها، ومكونات) بمعرّفات جديدة، والمخزون يبدأ من صفر */
async function copyCatalog(from, to) {
  const ids = new Map();
  const map = (old) => { if (!ids.has(old)) ids.set(old, crypto.randomUUID()); return ids.get(old); };
  const strip = ({ _id, tenantId, ...rest }) => rest;
  for (const name of ['categories', 'modifiers', 'discounts']) {
    for (const d of await from.collection(name).find({ active: { $ne: false } }).toArray()) {
      await to.collection(name).insertOne({ ...strip(d), _id: map(d._id) });
    }
  }
  const items = await from.collection('items').find({ active: { $ne: false } }).toArray();
  const variants = await from.collection('variants').find({ active: { $ne: false } }).toArray();
  for (const it of items) {
    await to.collection('items').insertOne({
      ...strip(it), _id: map(it._id), categoryId: it.categoryId ? (ids.get(it.categoryId) ?? null) : null,
      modifierIds: (it.modifierIds ?? []).filter((m) => ids.has(m)).map((m) => ids.get(m)),
    });
  }
  const itemIds = new Set(items.map((i) => i._id));
  for (const v of variants.filter((x) => itemIds.has(x.itemId))) map(v._id);
  for (const v of variants.filter((x) => itemIds.has(x.itemId))) {
    await to.collection('variants').insertOne({
      ...strip(v), _id: ids.get(v._id), itemId: ids.get(v.itemId), stock: 0,
      recipe: (v.recipe ?? []).filter((r) => ids.has(r.variantId)).map((r) => ({ variantId: ids.get(r.variantId), qty: r.qty })),
    });
  }
  const src = await getSettings(from);
  const patch = Object.fromEntries(COPY_SETTINGS.filter((k) => k in src).map((k) => [k, src[k]]));
  await to.collection('settings').updateOne({ _id: 'store' }, { $set: patch });
}
