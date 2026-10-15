// قائمة كوفي شوب جاهزة (اختيارية عند الإعداد): تصنيفات، مشروبات بأحجام، إضافات، مكونات بوصفات، خصومات.
// الأسعار بالدينار العراقي؛ تكلفة المكونات بالمللي دينار لكل وحدة أساسية (غ / مل / قطعة).

export const DEFAULT_SETTINGS = {
  name: 'مقهاي',
  address: '',
  phone: '',
  currency: 'IQD',
  tzOffsetMin: 180,
  tax: { mode: 'none', rateBp: 0, name: 'ضريبة' },
  loyalty: { enabled: true, rateBp: 500 },
  paymentTypes: [
    { id: 'cash', name: 'نقد', kind: 'cash', active: true },
    { id: 'qi', name: 'كي', kind: 'card', active: true },
  ],
  diningOptions: [
    { id: 'dine_in', name: 'محلي' },
    { id: 'takeaway', name: 'سفري' },
    { id: 'delivery', name: 'توصيل' },
  ],
  features: { kds: true, openTickets: true },
  receipt: { header: 'أهلاً بكم', footer: 'شكراً لزيارتكم — نراكم قريباً', showCustomer: true },
  cashVarianceAlert: 1000,
};

export async function seedMenu(ctx) {
  const { db, newId, now } = ctx;
  const at = now();
  const cat = {};
  for (const [key, name, color, sort] of [
    ['hot', 'قهوة ساخنة', 'petrol', 1], ['cold', 'قهوة باردة', 'teal', 2],
    ['tea', 'شاي ومشروبات', 'sage', 3], ['bake', 'حلويات ومخبوزات', 'sand', 4],
  ]) {
    cat[key] = newId();
    await db.collection('categories').insertOne({ _id: cat[key], name, color, sort, createdAt: at });
  }

  const mod = {};
  const options = (list) => list.map(([name, price]) => ({ id: newId(), name, price }));
  for (const [key, name, selection, required, list] of [
    ['milk', 'نوع الحليب', 'single', true, [['حليب كامل', 0], ['خالي الدسم', 0], ['حليب شوفان', 1000], ['حليب لوز', 1000]]],
    ['syrup', 'النكهات', 'multi', false, [['كراميل', 500], ['فانيلا', 500], ['بندق', 500], ['موكا', 750]]],
    ['extra', 'إضافات', 'multi', false, [['شوت إضافي', 750], ['كريمة', 500], ['ديكاف', 0]]],
    ['sugar', 'السكر', 'single', false, [['بدون سكر', 0], ['سكر قليل', 0], ['سكر وسط', 0], ['سكر زيادة', 0]]],
  ]) {
    mod[key] = newId();
    await db.collection('modifiers').insertOne({ _id: mod[key], name, selection, required, options: options(list), createdAt: at });
  }

  // المكونات: أصناف غير معروضة للبيع، مخزونها يُستهلك عبر الوصفات
  const ing = {};
  for (const [key, name, unit, costMilli, stock, low] of [
    ['bean', 'بن إسبريسو', 'غ', 30000, 5000, 1000],
    ['milk', 'حليب كامل', 'مل', 2500, 24000, 4000],
    ['oat', 'حليب شوفان', 'مل', 6000, 6000, 1000],
    ['cup8', 'كوب 8 أونصة', 'قطعة', 150000, 500, 100],
    ['cup12', 'كوب 12 أونصة', 'قطعة', 200000, 500, 100],
    ['tea', 'شاي سيلاني', 'غ', 20000, 2000, 300],
    ['ice', 'ثلج', 'غ', 100, 20000, 3000],
  ]) {
    const itemId = newId();
    ing[key] = newId();
    await db.collection('items').insertOne({ _id: itemId, name, categoryId: null, color: 'slate', forSale: false, unit, modifierIds: [], active: true, sort: 100, createdAt: at });
    await db.collection('variants').insertOne({ _id: ing[key], itemId, name: '', price: 0, costMilli, trackStock: true, stock: 0, lowStock: low, recipe: [], sort: 0, active: true });
    await ctx.inventory.applyMove({ key: `initial:${ing[key]}`, variantId: ing[key], delta: stock, reason: 'initial', refId: itemId });
  }

  const R = (...parts) => parts.map(([k, qty]) => ({ variantId: ing[k], qty }));
  const espressoMods = [mod.extra, mod.sugar];
  const milkMods = [mod.milk, mod.syrup, mod.extra];
  const items = [
    ['hot', 'إسبريسو', 'petrol', espressoMods, [['سنگل', 2500, R(['bean', 9], ['cup8', 1])], ['دبل', 3500, R(['bean', 18], ['cup8', 1])]]],
    ['hot', 'أمريكانو', 'petrol', espressoMods, [['وسط', 3500, R(['bean', 18], ['cup8', 1])], ['كبير', 4500, R(['bean', 27], ['cup12', 1])]]],
    ['hot', 'لاتيه', 'olive', milkMods, [['وسط', 5000, R(['bean', 18], ['milk', 200], ['cup8', 1])], ['كبير', 6000, R(['bean', 18], ['milk', 300], ['cup12', 1])]]],
    ['hot', 'كابتشينو', 'olive', milkMods, [['وسط', 5000, R(['bean', 18], ['milk', 150], ['cup8', 1])], ['كبير', 6000, R(['bean', 18], ['milk', 220], ['cup12', 1])]]],
    ['hot', 'فلات وايت', 'olive', milkMods, [['عادي', 5500, R(['bean', 18], ['milk', 120], ['cup8', 1])]]],
    ['hot', 'موكا', 'mocha', milkMods, [['وسط', 6000, R(['bean', 18], ['milk', 200], ['cup8', 1])], ['كبير', 7000, R(['bean', 18], ['milk', 300], ['cup12', 1])]]],
    ['hot', 'قهوة تركية', 'mocha', [mod.sugar], [['عادي', 2000, R(['bean', 7], ['cup8', 1])], ['دبل', 3000, R(['bean', 14], ['cup8', 1])]]],
    ['cold', 'آيس لاتيه', 'teal', milkMods, [['وسط', 5500, R(['bean', 18], ['milk', 200], ['ice', 120], ['cup12', 1])], ['كبير', 6500, R(['bean', 27], ['milk', 280], ['ice', 150], ['cup12', 1])]]],
    ['cold', 'آيس أمريكانو', 'teal', espressoMods, [['وسط', 4000, R(['bean', 18], ['ice', 150], ['cup12', 1])], ['كبير', 5000, R(['bean', 27], ['ice', 180], ['cup12', 1])]]],
    ['cold', 'كولد برو', 'petrol', [mod.syrup], [['عادي', 5000, R(['bean', 25], ['ice', 150], ['cup12', 1])]]],
    ['cold', 'فرابتشينو كراميل', 'clay', [mod.milk, mod.extra], [['عادي', 6500, R(['bean', 18], ['milk', 180], ['ice', 200], ['cup12', 1])]]],
    ['tea', 'شاي عراقي', 'sage', [mod.sugar], [['استكان', 1000, R(['tea', 3])], ['قوري صغير', 4000, R(['tea', 12])]]],
    ['tea', 'ماتشا لاتيه', 'sage', [mod.milk, mod.syrup], [['عادي', 6500, R(['milk', 220], ['cup12', 1])]]],
    ['tea', 'هوت شوكليت', 'mocha', [mod.milk], [['عادي', 5000, R(['milk', 220], ['cup8', 1])]]],
    ['bake', 'كرواسون', 'sand', [], [['زبدة', 2500, null, 1200, 24], ['شوكولاتة', 3000, null, 1500, 18]]],
    ['bake', 'تشيز كيك', 'sand', [], [['قطعة', 5000, null, 2200, 10]]],
    ['bake', 'كيكة شوكولاتة', 'clay', [], [['قطعة', 4500, null, 1800, 12]]],
    ['bake', 'كوكيز', 'sand', [], [['قطعة', 1500, null, 500, 30]]],
    ['tea', 'ماء', 'slate', [], [['قنينة', 500, null, 200, 48]]],
  ];
  let sort = 0;
  for (const [c, name, color, modifierIds, variants] of items) {
    const itemId = newId();
    await db.collection('items').insertOne({ _id: itemId, name, categoryId: cat[c], color, forSale: true, unit: null, modifierIds, active: true, sort: sort++, createdAt: at });
    let vs = 0;
    for (const [vname, price, recipe, cost, stock] of variants) {
      const variantId = newId();
      await db.collection('variants').insertOne({
        _id: variantId, itemId, name: variants.length === 1 && vname === 'عادي' ? '' : vname, price,
        costMilli: recipe ? 0 : cost * 1000, trackStock: !recipe, stock: 0, lowStock: recipe ? 0 : 4,
        recipe: recipe ?? [], sort: vs++, active: true,
      });
      // كل رصيد يدخل عبر الدفتر حتى تبقى المطابقة صحيحة
      if (!recipe) await ctx.inventory.applyMove({ key: `initial:${variantId}`, variantId, delta: stock, reason: 'initial', refId: itemId });
    }
  }

  for (const [name, type, value, restricted] of [
    ['عرض الصباح', 'percent', 1000, false],
    ['عميل دائم', 'amount', 1000, false],
    ['خصم الموظفين', 'percent', 2000, true],
  ]) {
    await db.collection('discounts').insertOne({ _id: newId(), name, type, value, restricted, active: true, createdAt: at });
  }
}
