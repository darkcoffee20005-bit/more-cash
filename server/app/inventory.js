// المخزون: دفتر حركات (stock_moves) بمفتاح فريد لكل حركة + رصيد مخزّن على الحجم يُحدَّث بـ $inc.
// المفتاح الفريد يجعل كل حركة تُطبَّق مرة واحدة مهما تكررت المحاولة؛ والرصيد قابل لإعادة البناء من الدفتر.
import { costOf, parseMilli, weightedCost } from '../../shared/calc.js';
import { audit, bad, id as checkId, int, isDup, notFound, oneOf, requirePerm, str } from './core.js';

export const MOVE_REASON = Object.freeze({
  initial: 'رصيد افتتاحي', sale: 'بيع', refund: 'استرجاع', receive: 'استلام', loss: 'هدر/تالف', count: 'جرد', adjust: 'تعديل',
});

export function createInventory(ctx) {
  const { db, now } = ctx;
  const moves = () => db.collection('stock_moves');
  const variants = () => db.collection('variants');

  /** يطبّق حركة مرة واحدة فقط. يعيد true إن طُبّقت الآن، false إن كانت مطبّقة سابقاً. */
  async function applyMove({ key, variantId, delta, reason, refId = null, by = null, costMilli = null, note = null }) {
    if (!Number.isSafeInteger(delta) || delta === 0) return false;
    try {
      await moves().insertOne({ _id: ctx.newId(), key, variantId, delta, reason, refId, note, by: by?.id ?? null, byName: by?.name ?? null, at: now(), costMilli });
    } catch (e) {
      if (isDup(e)) return false;
      throw e;
    }
    const set = costMilli !== null ? { costMilli } : {};
    await variants().updateOne({ _id: variantId }, { $inc: { stock: delta }, ...(Object.keys(set).length ? { $set: set } : {}) });
    return true;
  }

  async function list(actor) {
    requirePerm(actor, 'admin.inventory');
    const vs = await variants().find({ active: true, trackStock: true }).toArray();
    const items = new Map((await db.collection('items').find({ _id: { $in: [...new Set(vs.map((v) => v.itemId))] } }).toArray()).map((i) => [i._id, i]));
    const rows = vs.filter((v) => items.get(v.itemId)?.active !== false).map((v) => {
      const item = items.get(v.itemId);
      return {
        variantId: v._id, itemId: v.itemId, name: v.name ? `${item.name} — ${v.name}` : item.name, unit: item.unit ?? 'قطعة',
        ingredient: !item.forSale, stock: v.stock, lowStock: v.lowStock, costMilli: v.costMilli,
        value: v.stock > 0 ? costOf(v.stock, v.costMilli) : 0, low: v.stock <= v.lowStock,
      };
    });
    rows.sort((a, b) => Number(b.low) - Number(a.low) || Number(b.ingredient) - Number(a.ingredient) || a.name.localeCompare(b.name, 'ar'));
    return { rows, totalValue: rows.reduce((a, r) => a + r.value, 0), lowCount: rows.filter((r) => r.low).length };
  }

  async function adjust(actor, input = {}) {
    requirePerm(actor, 'admin.inventory');
    const clientId = checkId(input.clientId, 'clientId');
    const type = oneOf(input.type, ['receive', 'loss', 'count', 'adjust'], 'type');
    const v = await variants().findOne({ _id: checkId(input.variantId, 'variantId') });
    if (!v || !v.trackStock) throw notFound('VARIANT_NOT_TRACKED');
    const note = str(input.note, { field: 'note', max: 120, optional: true });
    let delta;
    let costMilli = null;
    if (type === 'receive') {
      const qty = int(input.qty, { field: 'qty', min: 1, max: 10_000_000 });
      delta = qty;
      if (input.cost !== undefined && input.cost !== '') costMilli = weightedCost(v.stock, v.costMilli, qty, parseMilli(input.cost));
    } else if (type === 'loss') {
      delta = -int(input.qty, { field: 'qty', min: 1, max: 10_000_000 });
      if (!note) throw bad('REQUIRED', 'note');
    } else if (type === 'count') {
      delta = int(input.qty, { field: 'qty', min: 0, max: 10_000_000 }) - v.stock;
    } else {
      if (!Number.isSafeInteger(input.qty) || input.qty === 0) throw bad('INVALID_NUMBER', 'qty');
      delta = input.qty;
      if (!note) throw bad('REQUIRED', 'note');
    }
    const applied = delta === 0 ? false : await applyMove({ key: `adj:${clientId}`, variantId: v._id, delta, reason: type, by: actor, costMilli, note });
    if (applied) await audit({ ...ctx, actor }, `inventory.${type}`, { variantId: v._id, delta, note });
    const after = await variants().findOne({ _id: v._id });
    return { applied, delta, stock: after.stock, costMilli: after.costMilli };
  }

  async function history(actor, variantId, limit = 100) {
    requirePerm(actor, 'admin.inventory');
    const rows = await moves().find({ variantId: checkId(variantId, 'variantId') }).sort({ at: -1 }).limit(Math.min(limit, 500)).toArray();
    return rows.map((m) => ({ at: m.at, delta: m.delta, reason: m.reason, reasonName: MOVE_REASON[m.reason] ?? m.reason, note: m.note, byName: m.byName, refId: m.refId }));
  }

  /** يعيد بناء الأرصدة من الدفتر ويصحح أي اختلاف (بعد انقطاع مفاجئ مثلاً) */
  async function reconcile(actor) {
    requirePerm(actor, 'admin.inventory');
    const all = await moves().find({}).project({ variantId: 1, delta: 1 }).toArray();
    const sums = new Map();
    for (const m of all) sums.set(m.variantId, (sums.get(m.variantId) ?? 0) + m.delta);
    const fixed = [];
    for (const v of await variants().find({ trackStock: true }).toArray()) {
      const expected = sums.get(v._id) ?? 0;
      if (v.stock !== expected) {
        await variants().updateOne({ _id: v._id }, { $set: { stock: expected } });
        fixed.push({ variantId: v._id, was: v.stock, now: expected });
      }
    }
    if (fixed.length) await audit({ ...ctx, actor }, 'inventory.reconcile', { fixed });
    return { checked: sums.size, fixed };
  }

  return { applyMove, list, adjust, history, reconcile };
}
