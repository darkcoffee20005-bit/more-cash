// الكتالوج: التصنيفات، الأصناف وأحجامها (variants)، الإضافات، الخصومات.
// الحذف منطقي (active:false) حتى تبقى الإيصالات القديمة والتقارير سليمة.
import { parseMilli } from '../../shared/calc.js';
import { COLORS, audit, bad, conflict, id as checkId, int, isDup, notFound, oneOf, out, requirePerm, str } from './core.js';

const MAX_VARIANTS = 8;

export function createCatalog(ctx) {
  const { db, now, newId } = ctx;
  const C = (n) => db.collection(n);

  async function guardDup(fn, code = 'NAME_IN_USE') {
    try { return await fn(); } catch (e) { if (isDup(e)) throw conflict(code); throw e; }
  }

  // ---------------------------------------------------------------- التصنيفات
  async function saveCategory(actor, input = {}) {
    requirePerm(actor, 'admin.catalog');
    const doc = {
      name: str(input.name, { field: 'name', min: 1, max: 40 }),
      color: oneOf(input.color ?? 'olive', COLORS, 'color'),
      sort: int(input.sort ?? 0, { field: 'sort', max: 9999 }),
      active: input.active !== false,
      updatedAt: now(),
    };
    return guardDup(async () => {
      if (input.id) {
        const r = await C('categories').updateOne({ _id: checkId(input.id) }, { $set: doc });
        if (!r.matchedCount) throw notFound();
        return out(await C('categories').findOne({ _id: input.id }));
      }
      const created = { _id: newId(), ...doc, createdAt: now() };
      await C('categories').insertOne(created);
      return out(created);
    });
  }

  async function listCategories() {
    return (await C('categories').find({}).sort({ sort: 1, name: 1 }).toArray()).map((c) => out(c));
  }

  // ---------------------------------------------------------------- الإضافات
  async function saveModifier(actor, input = {}) {
    requirePerm(actor, 'admin.catalog');
    if (!Array.isArray(input.options) || input.options.length === 0 || input.options.length > 20) throw bad('INVALID_LIST', 'options');
    const options = input.options.map((o) => ({
      id: o.id ? checkId(o.id, 'options.id') : newId(),
      name: str(o.name, { field: 'options.name', min: 1, max: 30 }),
      price: int(o.price ?? 0, { field: 'options.price', max: 1_000_000 }),
    }));
    const doc = {
      name: str(input.name, { field: 'name', min: 1, max: 40 }),
      selection: oneOf(input.selection ?? 'single', ['single', 'multi'], 'selection'),
      required: input.required === true,
      options,
      active: input.active !== false,
      updatedAt: now(),
    };
    return guardDup(async () => {
      if (input.id) {
        const r = await C('modifiers').updateOne({ _id: checkId(input.id) }, { $set: doc });
        if (!r.matchedCount) throw notFound();
        return out(await C('modifiers').findOne({ _id: input.id }));
      }
      const created = { _id: newId(), ...doc, createdAt: now() };
      await C('modifiers').insertOne(created);
      return out(created);
    });
  }

  async function listModifiers() {
    return (await C('modifiers').find({}).sort({ name: 1 }).toArray()).map((m) => out(m));
  }

  // ---------------------------------------------------------------- الخصومات
  async function saveDiscount(actor, input = {}) {
    requirePerm(actor, 'admin.catalog');
    const type = oneOf(input.type, ['percent', 'amount'], 'type');
    const value = type === 'percent' ? int(input.value, { field: 'value', min: 1, max: 10000 }) : int(input.value, { field: 'value', min: 1, max: 10_000_000 });
    const doc = { name: str(input.name, { field: 'name', min: 1, max: 40 }), type, value, restricted: input.restricted === true, active: input.active !== false, updatedAt: now() };
    return guardDup(async () => {
      if (input.id) {
        const r = await C('discounts').updateOne({ _id: checkId(input.id) }, { $set: doc });
        if (!r.matchedCount) throw notFound();
        await audit({ ...ctx, actor }, 'discount.update', { discountId: input.id, type, value });
        return out(await C('discounts').findOne({ _id: input.id }));
      }
      const created = { _id: newId(), ...doc, createdAt: now() };
      await C('discounts').insertOne(created);
      return out(created);
    });
  }

  async function listDiscounts() {
    return (await C('discounts').find({}).sort({ name: 1 }).toArray()).map((d) => out(d));
  }

  // ---------------------------------------------------------------- الأصناف والأحجام
  async function validateRecipe(recipe, selfIds) {
    if (!Array.isArray(recipe)) return [];
    if (recipe.length > 12) throw bad('INVALID_LIST', 'recipe');
    const outList = [];
    for (const r of recipe) {
      const vid = checkId(r.variantId, 'recipe.variantId');
      if (selfIds.includes(vid)) throw bad('RECIPE_SELF');
      const v = await C('variants').findOne({ _id: vid });
      if (!v || !v.trackStock) throw bad('RECIPE_COMPONENT_INVALID', vid);
      if (v.recipe?.length) throw bad('RECIPE_NESTED');
      outList.push({ variantId: vid, qty: int(r.qty, { field: 'recipe.qty', min: 1, max: 100000 }) });
    }
    return outList;
  }

  async function saveItem(actor, input = {}) {
    requirePerm(actor, 'admin.catalog');
    const forSale = input.forSale !== false;
    const categoryId = input.categoryId ? checkId(input.categoryId, 'categoryId') : null;
    if (categoryId && !(await C('categories').findOne({ _id: categoryId }))) throw bad('UNKNOWN_CATEGORY');
    const modifierIds = Array.isArray(input.modifierIds) ? [...new Set(input.modifierIds.map((m) => checkId(m, 'modifierIds')))] : [];
    if (modifierIds.length && (await C('modifiers').countDocuments({ _id: { $in: modifierIds } })) !== modifierIds.length) throw bad('UNKNOWN_MODIFIER');
    if (!Array.isArray(input.variants) || input.variants.length === 0 || input.variants.length > MAX_VARIANTS) throw bad('INVALID_LIST', 'variants');

    const item = {
      name: str(input.name, { field: 'name', min: 1, max: 50 }),
      categoryId,
      color: oneOf(input.color ?? 'olive', COLORS, 'color'),
      forSale,
      unit: forSale ? null : str(input.unit, { field: 'unit', min: 1, max: 10 }),
      modifierIds: forSale ? modifierIds : [],
      active: input.active !== false,
      sort: int(input.sort ?? 0, { field: 'sort', max: 9999 }),
      updatedAt: now(),
    };

    const itemId = input.id ? checkId(input.id) : newId();
    const existingVariants = input.id ? await C('variants').find({ itemId }).toArray() : [];
    const keepIds = input.variants.filter((v) => v.id).map((v) => checkId(v.id, 'variants.id'));
    if (keepIds.some((vid) => !existingVariants.some((e) => e._id === vid))) throw bad('UNKNOWN_VARIANT');

    const variants = [];
    for (const [i, v] of input.variants.entries()) {
      const recipe = forSale ? await validateRecipe(v.recipe, keepIds) : [];
      const costMilli = v.cost !== undefined ? parseMilli(v.cost) : int(v.costMilli ?? 0, { field: 'costMilli' });
      variants.push({
        _id: v.id ?? newId(),
        itemId,
        name: input.variants.length === 1 ? str(v.name ?? '', { field: 'variants.name', max: 30 }) : str(v.name, { field: 'variants.name', min: 1, max: 30 }),
        price: forSale ? int(v.price, { field: 'variants.price', max: 100_000_000 }) : 0,
        sku: str(v.sku, { field: 'variants.sku', max: 30, optional: true }),
        costMilli: recipe.length ? 0 : costMilli,
        trackStock: !forSale || (recipe.length === 0 && v.trackStock === true),
        lowStock: int(v.lowStock ?? 0, { field: 'variants.lowStock' }),
        recipe,
        sort: i,
        active: true,
        initialStock: v.id ? undefined : int(v.initialStock ?? 0, { field: 'variants.initialStock' }),
      });
    }
    if (new Set(variants.map((v) => v.name)).size !== variants.length) throw bad('DUPLICATE_VARIANT_NAME');

    return guardDup(async () => {
      if (input.id) {
        const r = await C('items').updateOne({ _id: itemId }, { $set: item });
        if (!r.matchedCount) throw notFound();
      } else {
        await C('items').insertOne({ _id: itemId, ...item, createdAt: now() });
      }
      for (const v of variants) {
        const { initialStock, _id, ...fields } = v;
        if (existingVariants.some((e) => e._id === _id)) {
          await C('variants').updateOne({ _id }, { $set: fields });
        } else {
          await C('variants').insertOne({ _id, ...fields, stock: 0 });
          if (initialStock) {
            await ctx.inventory.applyMove({ key: `initial:${_id}`, variantId: _id, delta: initialStock, reason: 'initial', refId: itemId, by: actor });
          }
        }
      }
      // الأحجام المحذوفة تُعطَّل ولا تُحذف
      const removed = existingVariants.filter((e) => !variants.some((v) => v._id === e._id)).map((e) => e._id);
      if (removed.length) await C('variants').updateMany({ _id: { $in: removed } }, { $set: { active: false } });
      return getItem(itemId);
    }, 'NAME_OR_SKU_IN_USE');
  }

  async function getItem(itemId) {
    const item = await C('items').findOne({ _id: checkId(itemId) });
    if (!item) throw notFound();
    const variants = await C('variants').find({ itemId: item._id, active: true }).sort({ sort: 1 }).toArray();
    return { ...out(item), variants: variants.map((v) => out(v)) };
  }

  async function listItems({ includeInactive = false } = {}) {
    const items = await C('items').find(includeInactive ? {} : { active: true }).sort({ forSale: -1, sort: 1, name: 1 }).toArray();
    const variants = await C('variants').find({ active: true }).sort({ sort: 1 }).toArray();
    const byItem = new Map();
    for (const v of variants) {
      if (!byItem.has(v.itemId)) byItem.set(v.itemId, []);
      byItem.get(v.itemId).push(out(v));
    }
    return items.map((i) => ({ ...out(i), variants: byItem.get(i._id) ?? [] }));
  }

  async function archive(actor, collection, docId) {
    requirePerm(actor, 'admin.catalog');
    const r = await C(collection).updateOne({ _id: checkId(docId) }, { $set: { active: false, updatedAt: now() } });
    if (!r.matchedCount) throw notFound();
    await audit({ ...ctx, actor }, `${collection}.archive`, { id: docId });
    return { ok: true };
  }

  /** كل ما تحتاجه شاشة الكاشير في طلب واحد */
  async function posCatalog() {
    const [categories, items, modifiers, discounts] = await Promise.all([
      C('categories').find({ active: { $ne: false } }).sort({ sort: 1, name: 1 }).toArray(),
      listItems(),
      C('modifiers').find({ active: { $ne: false } }).toArray(),
      C('discounts').find({ active: true }).sort({ name: 1 }).toArray(),
    ]);
    const stockOf = new Map();
    for (const it of items) for (const v of it.variants) stockOf.set(v.id, v);
    const forSale = items.filter((i) => i.forSale && i.variants.length).map((i) => ({
      ...i,
      variants: i.variants.map((v) => {
        // متوفر = المخزون كافٍ لقطعة واحدة على الأقل (من الصنف نفسه أو من مكونات وصفته)
        let available = null;
        if (v.trackStock) available = v.stock;
        else if (v.recipe.length) available = Math.min(...v.recipe.map((r) => Math.floor((stockOf.get(r.variantId)?.stock ?? 0) / r.qty)));
        return { id: v.id, name: v.name, price: v.price, sku: v.sku, available };
      }),
    }));
    // تنبيه المخزون المنخفض يظهر على شاشة البيع لكل الموظفين (أسماء وكميات فقط، بلا تكاليف)
    const lowStock = items.flatMap((i) => i.variants.filter((v) => v.trackStock && v.stock <= v.lowStock).map((v) => ({
      variantId: v.id, name: v.name ? `${i.name} — ${v.name}` : i.name, stock: v.stock, unit: i.unit ?? 'قطعة', out: v.stock <= 0,
    }))).sort((a, b) => Number(b.out) - Number(a.out) || a.stock - b.stock);
    return {
      categories: categories.map((c) => out(c)),
      items: forSale,
      lowStock,
      modifiers: modifiers.map((m) => out(m)),
      discounts: discounts.map((d) => out(d)),
    };
  }

  return { saveCategory, listCategories, saveModifier, listModifiers, saveDiscount, listDiscounts, saveItem, getItem, listItems, archive, posCatalog };
}
