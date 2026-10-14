// خادم تجريبي داخل المتصفح: نفس كود الخادم (server/app) فوق قاعدة MemoryDb، مع بيانات أسبوع من المبيعات.
// يُستخدم للنسخة التجريبية المنشورة ولاختبارات الواجهة. لا يرسل شيئاً لأي شبكة.
import { MemoryDb } from '../server/db/memory.js';
import { ensureIndexes } from '../server/db/indexes.js';
import { createPlatform } from '../server/app/platform.js';
import { calculateTicket, unitPrice } from '../shared/calc.js';

export const DEMO_PINS = { owner: '1234', manager: '2580', cashier: '1470', barista: '3690' };
export const DEMO_ACCOUNT = { email: 'demo@morecash.app', password: 'morecash-demo' };

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

export async function createDemoBackend({ withHistory = true, seed = 7 } = {}) {
  const db = new MemoryDb({ newId: () => crypto.randomUUID() });
  await ensureIndexes(db);
  let offset = 0; // إزاحة الساعة لتوليد التاريخ
  // تكرارات PBKDF2 أقل في النسخة التجريبية فقط (لا كلمات مرور حقيقية هنا) كي تفتح بسرعة على الهاتف
  const app = createPlatform({ db, now: () => new Date(Date.now() + offset), passwordIterations: 2000, log: { error: console.error, warn() {}, info() {} } });
  let token = null;
  let deviceToken = null;
  const handle = async (req) => {
    const r = await app.handle({ ...req, token, deviceToken, ip: 'demo' });
    if (r.setToken !== undefined) token = r.setToken;
    if (r.setDevice !== undefined) deviceToken = r.setDevice;
    return r;
  };
  const call = async (method, path, body, query) => {
    const r = await handle({ method, path, body, query });
    if (r.status !== 200) throw new Error(`${method} ${path}: ${JSON.stringify(r.body)}`);
    return r.body;
  };

  await call('POST', '/api/account/signup', { shopName: 'مقهى مور', ownerName: 'أحمد', ...DEMO_ACCOUNT, pin: DEMO_PINS.owner, seed: true });
  await call('POST', '/api/admin/employees', { name: 'زينب', role: 'manager', pin: DEMO_PINS.manager });
  await call('POST', '/api/admin/employees', { name: 'سارة', role: 'cashier', pin: DEMO_PINS.cashier });
  await call('POST', '/api/admin/employees', { name: 'حيدر', role: 'barista', pin: DEMO_PINS.barista });
  const customers = [];
  for (const [name, phone] of [['علي حسن', '07701234567'], ['نور الهدى', '07809876543'], ['مصطفى كريم', '07501112233'], ['رقية سالم', '07712223344']]) {
    customers.push(await call('POST', '/api/customers', { name, phone }));
  }

  if (withHistory) {
    const rand = rng(seed);
    const pick = (arr) => arr[Math.floor(rand() * arr.length)];
    const { catalog, settings } = await call('GET', '/api/pos/bootstrap');
    const mods = new Map(catalog.modifiers.map((m) => [m.id, m]));
    const popular = catalog.items.filter((i) => ['لاتيه', 'كابتشينو', 'أمريكانو', 'آيس لاتيه', 'إسبريسو', 'شاي عراقي', 'كرواسون', 'موكا', 'فلات وايت', 'كولد برو', 'ماء', 'تشيز كيك'].includes(i.name));
    const morning = catalog.discounts.find((d) => d.name === 'عرض الصباح');
    const startOfToday = new Date(); startOfToday.setUTCHours(-3 + 24 * (new Date().getUTCHours() >= 21 ? 1 : 0), 0, 0, 0);

    for (let day = 6; day >= 0; day--) {
      const base = startOfToday.getTime() - day * 86400000;
      offset = base + 8 * 3600000 - Date.now(); // 8 صباحاً بتوقيت بغداد
      await call('POST', '/api/shifts/open', { startingCash: 50000 });
      // استلام صباحي من المورد كما في مقهى حقيقي
      if (day % 2 === 0) {
        const inv = await call('GET', '/api/admin/inventory');
        const plan = { 'بن إسبريسو': [1600, '29.5'], 'حليب كامل': [9000, '2.6'], 'كوب 8 أونصة': [110, '150'], 'كوب 12 أونصة': [120, '200'], 'ثلج': [6000, '0.1'], 'شاي سيلاني': [300, '20'],
          'كرواسون — زبدة': [12, '1200'], 'كرواسون — شوكولاتة': [10, '1500'], 'تشيز كيك — قطعة': [6, '2200'], 'كيكة شوكولاتة — قطعة': [6, '1800'], 'كوكيز — قطعة': [6, '500'], 'ماء — قنينة': [12, '200'] };
        for (const r of inv.rows) {
          const p = plan[r.name];
          if (p) await call('POST', '/api/admin/inventory/adjust', { clientId: crypto.randomUUID(), variantId: r.variantId, type: 'receive', qty: p[0], cost: p[1], note: 'استلام صباحي' });
        }
      }
      const isToday = day === 0;
      const hoursNow = (Date.now() - base) / 3600000;
      const count = isToday ? Math.max(6, Math.floor((Math.min(hoursNow, 23) - 8) * 3)) : 28 + Math.floor(rand() * 18);
      let t = 8 * 3600000;
      for (let n = 0; n < count; n++) {
        t += (isToday ? Math.max(5, (Math.min(hoursNow, 23) - 8) * 3600000 / count / 60000) : 20 + rand() * 18) * 60000;
        if (isToday && t > hoursNow * 3600000 - 60000) break;
        offset = base + t - Date.now();
        const lines = [];
        const k = 1 + Math.floor(rand() * 3);
        for (let j = 0; j < k; j++) {
          const item = pick(popular);
          const variant = pick(item.variants);
          const opts = [];
          for (const mid of item.modifierIds) {
            const g = mods.get(mid);
            if (g.required) opts.push(rand() < 0.75 ? g.options[0].id : pick(g.options).id);
            else if (rand() < 0.25) opts.push(pick(g.options).id);
          }
          lines.push({ variantId: variant.id, qty: rand() < 0.15 ? 2 : 1, modifierOptionIds: opts });
        }
        const discountIds = rand() < 0.12 && t < 11 * 3600000 ? [morning.id] : [];
        const customer = rand() < 0.3 ? pick(customers) : null;
        const priced = lines.map((l) => {
          const item = catalog.items.find((i) => i.variants.some((v) => v.id === l.variantId));
          const v = item.variants.find((x) => x.id === l.variantId);
          const prices = catalog.modifiers.flatMap((m) => m.options).filter((o) => l.modifierOptionIds.includes(o.id)).map((o) => o.price);
          return { qty: l.qty, unitPrice: unitPrice(v.price, prices) };
        });
        const total = calculateTicket(priced, { discounts: discountIds.map((id) => catalog.discounts.find((d) => d.id === id)), tax: settings.tax }).total;
        const type = rand() < 0.62 ? 'cash' : rand() < 0.6 ? 'card' : pick(['zain', 'fib']);
        const tendered = type === 'cash' ? Math.ceil(total / 5000) * 5000 : total;
        const sale = await call('POST', '/api/sales', {
          clientId: crypto.randomUUID(), lines, discountIds, customerId: customer?.id ?? null, diningOption: pick(['dine_in', 'takeaway', 'takeaway']),
          clientTotal: total, payments: [{ typeId: type, amount: total, tendered }],
        });
        // معظم الطلبات القديمة سُلّمت؛ آخر طلبات اليوم تبقى في شاشة التحضير
        if (!isToday || n < count - 4) {
          for (const from of ['new', 'preparing', 'ready']) await call('POST', `/api/kds/${sale.receipt.id}/advance`, { from });
        }
        if (rand() < 0.03) {
          await call('POST', `/api/receipts/${sale.receipt.id}/refund`, { clientId: crypto.randomUUID(), lines: [{ index: 0, qty: 1 }], reason: 'طلب خاطئ', restock: true });
        }
      }
      if (!isToday) {
        offset = base + 23 * 3600000 - Date.now();
        await call('POST', '/api/shifts/move', { clientId: crypto.randomUUID(), type: 'pay_out', amount: 5000 + Math.floor(rand() * 4) * 2500, note: pick(['ثلج', 'أكياس ورقية', 'أجرة توصيل']) });
        const cur = await call('GET', '/api/shifts/current');
        const diff = rand() < 0.7 ? 0 : -250 * Math.ceil(rand() * 4);
        await call('POST', '/api/shifts/close', { actualCash: cur.live.expectedCash + diff, note: diff ? 'فرق صرف' : null });
      }
    }
    // تذكرتان مفتوحتان لطاولات
    offset = 0;
    const latte = catalog.items.find((i) => i.name === 'لاتيه');
    const tea = catalog.items.find((i) => i.name === 'شاي عراقي');
    await call('POST', '/api/tickets', { name: 'طاولة 3', lines: [{ variantId: latte.variants[0].id, qty: 2, modifierOptionIds: [mods.get(latte.modifierIds[0]).options[0].id] }], displayTotal: 10000 });
    await call('POST', '/api/tickets', { name: 'طاولة 5', lines: [{ variantId: tea.variants[0].id, qty: 4 }], displayTotal: 4000 });
  }
  offset = 0;
  // تبدأ النسخة التجريبية من الصفحة الرئيسية: الجهاز غير مرتبط بأي مقهى
  await call('POST', '/api/account/logout', {});

  /** يُسند إلى globalThis.MORECASH_BACKEND */
  const backend = ({ method, path, body, query }) => handle({ method, path, body, query });
  return { backend, app, db };
}
