// تدفقات العمل الكاملة عبر واجهة API (الدالة handle نفسها التي يستخدمها خادم HTTP).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MemoryDb } from '../server/db/memory.js';
import { ensureIndexes } from '../server/db/indexes.js';
import { createApp } from '../server/app/index.js';
import { calculateTicket, unitPrice } from '../shared/calc.js';

async function boot({ seed = true } = {}) {
  const db = new MemoryDb({ newId: randomUUID });
  await ensureIndexes(db);
  let clock = new Date('2026-10-14T07:00:00Z'); // 10:00 بتوقيت بغداد
  const app = createApp({ db, now: () => clock, log: { error() {}, warn() {}, info() {} } });
  const tokens = {};
  const call = async (who, method, path, body, query) => {
    const r = await app.handle({ method, path, body, query, token: tokens[who] ?? null, ip: who });
    if (r.setToken !== undefined) tokens[who] = r.setToken;
    return r;
  };
  const ok = async (who, method, path, body, query) => {
    const r = await call(who, method, path, body, query);
    assert.equal(r.status, 200, `${method} ${path} → ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const setup = await call('owner', 'POST', '/api/setup', { storeName: 'مقهى الزيتون', ownerName: 'أحمد', pin: '1357', seed });
  assert.equal(setup.status, 200);
  await ok('owner', 'POST', '/api/auth/pin', { pin: '1357' });
  return { app, db, call, ok, tokens, tick: (ms) => { clock = new Date(clock.getTime() + ms); } };
}

const findItem = (cat, name) => cat.items.find((i) => i.name === name);

function priceOf(cat, line) {
  const item = cat.items.find((i) => i.variants.some((v) => v.id === line.variantId));
  const v = item.variants.find((x) => x.id === line.variantId);
  const mods = cat.modifiers.flatMap((m) => m.options).filter((o) => (line.modifierOptionIds ?? []).includes(o.id)).map((o) => o.price);
  return unitPrice(v.price, mods);
}

function clientTotal(cat, settings, lines, discountIds = [], pointsRedeemed = 0) {
  const disc = (ids) => ids.map((id) => cat.discounts.find((d) => d.id === id));
  return calculateTicket(lines.map((l) => ({ qty: l.qty, unitPrice: priceOf(cat, l), discounts: disc(l.discountIds ?? []) })),
    { discounts: disc(discountIds), pointsRedeemed, tax: settings.tax }).total;
}

test('الإعداد مرة واحدة، الدخول بالرمز، وقفل المحاولات', async () => {
  const { call, ok } = await boot();
  assert.equal((await call('x', 'POST', '/api/setup', { storeName: 'أخرى', ownerName: 'س', pin: '2468' })).status, 409);
  assert.equal((await call('anon', 'GET', '/api/pos/bootstrap')).status, 401);
  const state = await ok('owner', 'GET', '/api/state');
  assert.equal(state.employee.role, 'owner');
  for (let i = 0; i < 5; i++) assert.equal((await call('bad', 'POST', '/api/auth/pin', { pin: '0000' })).status, 401);
  const locked = await call('bad', 'POST', '/api/auth/pin', { pin: '1357' });
  assert.equal(locked.status, 429, 'قفل بعد 5 محاولات خاطئة حتى بالرمز الصحيح');
  assert.equal((await call('weak', 'POST', '/api/setup', {})).status, 409);
});

test('دورة بيع كاملة: وردية ← بيع بإضافات وخصم وعميل ← دفع مقسّم ← مخزون ونقاط ← تحضير ← استرجاع ← إغلاق', async () => {
  const { ok, call, db } = await boot();
  // موظف كاشير
  await ok('owner', 'POST', '/api/admin/employees', { name: 'سارة', role: 'cashier', pin: '2468' });
  assert.equal((await call('owner', 'POST', '/api/admin/employees', { name: 'مكرر', role: 'cashier', pin: '2468' })).status, 409, 'رمز مكرر مرفوض');
  await ok('sara', 'POST', '/api/auth/pin', { pin: '2468' });
  assert.equal((await call('sara', 'GET', '/api/admin/dashboard')).status, 403, 'الكاشير لا يرى لوحة الإدارة');

  let boot1 = await ok('sara', 'GET', '/api/pos/bootstrap');
  assert.equal(boot1.shift, null);
  const { catalog, settings } = boot1;
  const latte = findItem(catalog, 'لاتيه');
  const croissant = findItem(catalog, 'كرواسون');
  const milkMod = catalog.modifiers.find((m) => m.name === 'نوع الحليب');
  const extras = catalog.modifiers.find((m) => m.name === 'إضافات');
  const oat = milkMod.options.find((o) => o.name === 'حليب شوفان');
  const shot = extras.options.find((o) => o.name === 'شوت إضافي');
  const morning = catalog.discounts.find((d) => d.name === 'عرض الصباح');
  const staff = catalog.discounts.find((d) => d.name === 'خصم الموظفين');

  const lines = [
    { variantId: latte.variants[1].id, qty: 2, modifierOptionIds: [oat.id, shot.id] },   // كبير 6000 + 1000 + 750 = 7750 × 2
    { variantId: croissant.variants[0].id, qty: 1 },                                      // 2500
  ];
  const sell = (body) => call('sara', 'POST', '/api/sales', { diningOption: 'takeaway', ...body });

  assert.equal((await sell({ clientId: randomUUID(), lines, clientTotal: 18000, payments: [{ typeId: 'cash', amount: 18000 }] })).body.error, 'NO_OPEN_SHIFT');
  await ok('sara', 'POST', '/api/shifts/open', { startingCash: 50000 });
  assert.equal((await call('sara', 'POST', '/api/shifts/open', { startingCash: 1 })).status, 409, 'وردية واحدة مفتوحة');

  // تحقق الخادم: إضافة إلزامية ناقصة، سعر مختلف، خصم مقيد
  assert.equal((await sell({ clientId: randomUUID(), lines: [{ variantId: latte.variants[0].id, qty: 1 }], clientTotal: 5000, payments: [{ typeId: 'cash', amount: 5000 }] })).body.error, 'MODIFIER_REQUIRED');
  assert.equal((await sell({ clientId: randomUUID(), lines, clientTotal: 100, payments: [{ typeId: 'cash', amount: 100 }] })).body.error, 'TOTAL_MISMATCH');
  assert.equal((await sell({ clientId: randomUUID(), lines, discountIds: [staff.id], clientTotal: 1, payments: [] })).body.detail, 'pos.discount_restricted');

  // عميل جديد
  const customer = await ok('sara', 'POST', '/api/customers', { name: 'علي حسن', phone: '0770 123 4567' });
  assert.equal(customer.phone, '07701234567');

  const total = clientTotal(catalog, settings, lines, [morning.id]);
  assert.equal(total, 16200, '(15,500 + 2,500) − 10%');
  const clientId = randomUUID();
  const body = { clientId, lines, discountIds: [morning.id], customerId: customer.id, clientTotal: total,
    payments: [{ typeId: 'qi', amount: 6200 }, { typeId: 'cash', amount: 10000, tendered: 20000 }] };
  const sale = (await sell(body)).body.receipt;
  assert.equal(sale.number, 1001);
  assert.equal(sale.totals.total, 16200);
  assert.equal(sale.payments[1].change, 10000);
  assert.equal(sale.lines[0].cost, 2 * (18 * 30 + 300 * 2.5 + 200), 'تكلفة الوصفة: بن + حليب + كوب');
  assert.equal(sale.pointsEarned, 810, '5% من 16,200');
  assert.equal(sale.prep.status, 'new');

  const again = await sell(body);
  assert.equal(again.body.duplicate, true, 'إعادة الإرسال تعيد نفس الإيصال');
  assert.equal(again.body.receipt.number, 1001);
  assert.equal(await db.collection('receipts').countDocuments({ type: 'sale' }), 1);

  // المخزون: البن 5000 − 36 ، الحليب 24000 − 600 ، الكرواسون 24 − 1 (مرة واحدة رغم التكرار)
  const inv = await ok('owner', 'GET', '/api/admin/inventory');
  const stock = (n) => inv.rows.find((r) => r.name === n).stock;
  assert.equal(stock('بن إسبريسو'), 4964);
  assert.equal(stock('حليب كامل'), 23400);
  assert.equal(stock('كرواسون — زبدة'), 23);

  const c1 = await ok('sara', 'GET', `/api/customers/${customer.id}`);
  assert.equal(c1.points, 810);
  assert.equal(c1.visits, 1);
  assert.equal(c1.totalSpent, 16200);

  // استبدال النقاط في بيع ثانٍ
  const water = findItem(catalog, 'ماء');
  const l2 = [{ variantId: water.variants[0].id, qty: 2 }];
  const t2 = clientTotal(catalog, settings, l2, [], 800);
  assert.equal(t2, 200);
  const sale2 = (await sell({ clientId: randomUUID(), lines: l2, customerId: customer.id, pointsRedeemed: 800, clientTotal: t2, payments: [{ typeId: 'cash', amount: 200 }] })).body.receipt;
  assert.equal(sale2.pointsRedeemed, 800);
  assert.equal((await ok('sara', 'GET', `/api/customers/${customer.id}`)).points, 810 - 800 + 10);
  assert.equal((await sell({ clientId: randomUUID(), lines: l2, customerId: customer.id, pointsRedeemed: 900, clientTotal: 0, payments: [] })).body.error, 'INSUFFICIENT_POINTS');

  // شاشة التحضير
  const kds = await ok('sara', 'GET', '/api/kds');
  assert.equal(kds.length, 2);
  assert.equal((await ok('sara', 'POST', `/api/kds/${sale.id}/advance`, { from: 'new' })).advanced, true);
  assert.equal((await ok('sara', 'POST', `/api/kds/${sale.id}/advance`, { from: 'new' })).advanced, false, 'نقرة مكررة لا تقفز مرحلتين');

  // الاسترجاع: الكاشير لا يملك الصلاحية؛ المدير يسترجع كرواسون واحد مع إعادته للمخزون
  assert.equal((await call('sara', 'POST', `/api/receipts/${sale.id}/refund`, { clientId: randomUUID(), lines: [{ index: 1, qty: 1 }], reason: 'خطأ' })).status, 403);
  const refundId = randomUUID();
  const refundBody = { clientId: refundId, lines: [{ index: 1, qty: 1 }], reason: 'طلب خاطئ', restock: true, paymentTypeId: 'cash' };
  const refund = (await call('owner', 'POST', `/api/receipts/${sale.id}/refund`, refundBody)).body.receipt;
  assert.equal(refund.type, 'refund');
  assert.equal(refund.totals.total, 2250, 'الكرواسون 2,500 بعد حصته من خصم 10%');
  assert.equal((await call('owner', 'POST', `/api/receipts/${sale.id}/refund`, refundBody)).body.duplicate, true);
  assert.equal((await call('owner', 'POST', `/api/receipts/${sale.id}/refund`, { ...refundBody, clientId: randomUUID() })).body.error, 'REFUND_QTY_EXCEEDS');
  const afterRefund = await ok('owner', 'GET', `/api/receipts/${sale.id}`);
  assert.equal(afterRefund.status, 'partially_refunded');
  assert.equal(afterRefund.refunds.length, 1);
  assert.equal((await ok('owner', 'GET', '/api/admin/inventory')).rows.find((r) => r.name === 'كرواسون — زبدة').stock, 24, 'أُعيد للمخزون');

  // استرجاع اللاتيه بالكامل على دفعتين: المجموع يساوي صافي السطر تماماً
  const r1 = (await call('owner', 'POST', `/api/receipts/${sale.id}/refund`, { clientId: randomUUID(), lines: [{ index: 0, qty: 1 }], reason: 'بارد' })).body.receipt;
  const r2 = (await call('owner', 'POST', `/api/receipts/${sale.id}/refund`, { clientId: randomUUID(), lines: [{ index: 0, qty: 1 }], reason: 'بارد' })).body.receipt;
  assert.equal(r1.totals.net + r2.totals.net, sale.lines[0].net);
  assert.equal((await ok('owner', 'GET', `/api/receipts/${sale.id}`)).status, 'refunded');

  // حركات النقد والإغلاق
  assert.equal((await call('sara', 'POST', '/api/shifts/move', { clientId: 'pin-1', type: 'pay_out', amount: 3000, note: 'ثلج' })).status, 403, 'الكاشير لا يسحب نقداً');
  await ok('owner', 'POST', '/api/shifts/move', { clientId: 'out-1', type: 'pay_out', amount: 3000, note: 'ثلج' });
  await ok('owner', 'POST', '/api/shifts/move', { clientId: 'out-1', type: 'pay_out', amount: 3000, note: 'ثلج' });
  const cur = await ok('sara', 'GET', '/api/shifts/current');
  assert.equal(cur.movements.length, 1, 'حركة السحب المكررة سُجّلت مرة واحدة');
  // 50,000 + 10,000 (نقد البيع 1) + 200 (البيع 2) − 2,250 (استرجاع نقدي) − 3,000 (سحب)
  // استرجاعا اللاتيه ذهبا لطريقة الدفع الأولى في الإيصال (بطاقة) فلا يمسّان الدرج
  assert.equal(r1.payments[0].typeId, 'qi');
  const expected = 50000 + 10000 + 200 - 2250 - 3000;
  assert.equal(cur.live.expectedCash, expected);
  assert.equal((await call('sara', 'POST', '/api/shifts/close', { actualCash: expected - 5000 })).body.error, 'VARIANCE_NOTE_REQUIRED');
  const closed = await ok('sara', 'POST', '/api/shifts/close', { actualCash: expected - 5000, note: 'خطأ في الباقي' });
  assert.equal(closed.status, 'closed');
  assert.equal(closed.difference, -5000);
  assert.equal((await call('sara', 'POST', '/api/shifts/close', { actualCash: 1 })).body.error, 'NO_OPEN_SHIFT');

  // التقرير يطابق الإيصالات
  const rep = await ok('owner', 'GET', '/api/admin/reports', null, { from: '2026-10-14', to: '2026-10-14' });
  assert.equal(rep.summary.salesCount, 2);
  assert.equal(rep.summary.refundsCount, 3);
  assert.equal(rep.summary.net, 16200 + 200 - 2250 - r1.totals.net - r2.totals.net);
  assert.equal(rep.summary.gross - rep.summary.refunds - rep.summary.discounts, rep.summary.net);
  const cashRow = rep.byPayment.find((p) => p.key === 'cash');
  assert.equal(cashRow.net, 10200 - 2250);
  assert.equal(rep.byPayment.find((p) => p.key === 'qi').net, 6200 - r1.totals.total - r2.totals.total);
});

test('التذاكر المفتوحة: حفظ، تعارض تعديل متزامن، وتحويلها لبيع يحذفها', async () => {
  const { ok, call } = await boot();
  const { catalog, settings } = await ok('owner', 'GET', '/api/pos/bootstrap');
  await ok('owner', 'POST', '/api/shifts/open', { startingCash: 0 });
  const tea = findItem(catalog, 'شاي عراقي');
  const lines = [{ variantId: tea.variants[0].id, qty: 3 }];
  const t = await ok('owner', 'POST', '/api/tickets', { name: 'طاولة 4', lines });
  assert.equal(t.version, 1);
  const t2 = await ok('owner', 'POST', '/api/tickets', { id: t.id, version: 1, name: 'طاولة 4', lines: [{ ...lines[0], qty: 4 }] });
  assert.equal(t2.version, 2);
  assert.equal((await call('owner', 'POST', '/api/tickets', { id: t.id, version: 1, name: 'طاولة 4', lines })).body.error, 'TICKET_CHANGED');
  const total = clientTotal(catalog, settings, t2.lines);
  await ok('owner', 'POST', '/api/sales', { clientId: randomUUID(), ticketId: t.id, ticketName: 'طاولة 4', lines: t2.lines, clientTotal: total, payments: [{ typeId: 'cash', amount: total }] });
  assert.equal((await ok('owner', 'GET', '/api/tickets')).length, 0);
});

test('المخزون: استلام بمتوسط مرجح، هدر، جرد، ومطابقة الدفتر', async () => {
  const ctxTick = await boot();
  const { ok, call, db } = ctxTick;
  const inv = await ok('owner', 'GET', '/api/admin/inventory');
  const milk = inv.rows.find((r) => r.name === 'حليب كامل');
  const { tick } = ctxTick;
  tick(1000);
  const recv = await ok('owner', 'POST', '/api/admin/inventory/adjust', { clientId: 'r1', variantId: milk.variantId, type: 'receive', qty: 12000, cost: '3.1' });
  assert.equal(recv.stock, 36000);
  assert.equal(recv.costMilli, 2700, '(24000×2.5 + 12000×3.1) ÷ 36000 = 2.7');
  assert.equal((await ok('owner', 'POST', '/api/admin/inventory/adjust', { clientId: 'r1', variantId: milk.variantId, type: 'receive', qty: 12000 })).applied, false, 'نفس العملية لا تتكرر');
  assert.equal((await call('owner', 'POST', '/api/admin/inventory/adjust', { clientId: 'l1', variantId: milk.variantId, type: 'loss', qty: 500 })).body.error, 'REQUIRED');
  tick(1000);
  await ok('owner', 'POST', '/api/admin/inventory/adjust', { clientId: 'l1', variantId: milk.variantId, type: 'loss', qty: 500, note: 'منتهي الصلاحية' });
  tick(1000);
  const count = await ok('owner', 'POST', '/api/admin/inventory/adjust', { clientId: 'c1', variantId: milk.variantId, type: 'count', qty: 35000 });
  assert.equal(count.delta, -500);
  const hist = await ok('owner', 'GET', `/api/admin/inventory/${milk.variantId}/history`);
  assert.deepEqual(hist.map((h) => h.reason), ['count', 'loss', 'receive', 'initial']);
  // انحراف مصطنع ثم مطابقة
  await db.collection('variants').updateOne({ _id: milk.variantId }, { $set: { stock: 1 } });
  const rec = await ok('owner', 'POST', '/api/admin/inventory/reconcile');
  assert.equal(rec.fixed.length, 1);
  assert.equal((await ok('owner', 'GET', '/api/admin/inventory')).rows.find((r) => r.name === 'حليب كامل').stock, 35000);
});

test('إدارة الكتالوج والإعدادات والضريبة', async () => {
  const { ok, call } = await boot({ seed: false });
  const cat = await ok('owner', 'POST', '/api/admin/categories', { name: 'قهوة', color: 'petrol' });
  assert.equal((await call('owner', 'POST', '/api/admin/categories', { name: 'قهوة' })).body.error, 'NAME_IN_USE');
  const ing = await ok('owner', 'POST', '/api/admin/items', { name: 'بن', forSale: false, unit: 'غ', variants: [{ cost: '25.5', initialStock: 1000, lowStock: 100 }] });
  assert.equal(ing.variants[0].costMilli, 25500);
  assert.equal(ing.variants[0].stock, 1000);
  const esp = await ok('owner', 'POST', '/api/admin/items', { name: 'إسبريسو', categoryId: cat.id, color: 'olive',
    variants: [{ name: 'سنگل', price: 2000, recipe: [{ variantId: ing.variants[0].id, qty: 9 }] }, { name: 'دبل', price: 3000, recipe: [{ variantId: ing.variants[0].id, qty: 18 }] }] });
  assert.equal(esp.variants.length, 2);
  // تعديل: حذف حجم يعطّله فقط
  await ok('owner', 'POST', '/api/admin/items', { id: esp.id, name: 'إسبريسو', categoryId: cat.id, variants: [{ id: esp.variants[0].id, name: 'سنگل', price: 2500, recipe: [{ variantId: ing.variants[0].id, qty: 9 }] }] });
  const items = await ok('owner', 'GET', '/api/admin/items');
  assert.equal(items.find((i) => i.name === 'إسبريسو').variants.length, 1);

  const s = await ok('owner', 'PUT', '/api/admin/settings', { tax: { mode: 'added', rateBp: 1500, name: 'ضريبة مبيعات' } });
  assert.equal(s.tax.rateBp, 1500);
  assert.equal(s.secret, undefined, 'السر لا يُرسل للواجهة');
  assert.equal((await call('owner', 'PUT', '/api/admin/settings', { paymentTypes: [{ id: 'card', name: 'بطاقة', kind: 'card' }] })).body.error, 'CASH_REQUIRED');

  await ok('owner', 'POST', '/api/shifts/open', { startingCash: 0 });
  const { catalog, settings } = await ok('owner', 'GET', '/api/pos/bootstrap');
  const lines = [{ variantId: esp.variants[0].id, qty: 1 }];
  const total = clientTotal(catalog, settings, lines);
  assert.equal(total, 2875, '2,500 + 15%');
  const sale = (await call('owner', 'POST', '/api/sales', { clientId: randomUUID(), lines, clientTotal: total, payments: [{ typeId: 'cash', amount: total }] })).body.receipt;
  assert.equal(sale.totals.tax, 375);
  assert.equal(sale.lines[0].cost, 230, '9غ × 25.5 = 229.5 ← 230');
});

test('الصلاحيات: الباريستا يرى التحضير فقط، والمالك الأخير لا يُعطَّل', async () => {
  const { ok, call } = await boot();
  const b = await ok('owner', 'POST', '/api/admin/employees', { name: 'حيدر', role: 'barista', pin: '9753' });
  await ok('barista', 'POST', '/api/auth/pin', { pin: '9753' });
  assert.equal((await call('barista', 'GET', '/api/kds')).status, 200);
  assert.equal((await call('barista', 'POST', '/api/sales', { clientId: randomUUID() })).status, 403);
  assert.equal((await call('barista', 'POST', '/api/shifts/open', {})).status, 403);
  const owners = (await ok('owner', 'GET', '/api/admin/employees')).filter((e) => e.role === 'owner');
  assert.equal((await call('owner', 'POST', '/api/admin/employees', { id: owners[0].id, name: 'أحمد', role: 'manager' })).body.error, 'LAST_OWNER');
  // تعطيل موظف يُنهي جلسته فوراً
  await ok('owner', 'POST', '/api/admin/employees', { id: b.id, name: 'حيدر', role: 'barista', active: false });
  assert.equal((await call('barista', 'GET', '/api/kds')).status, 401);
});

test('استكمال آثار إيصال انقطع تطبيقه', async () => {
  const { ok, db, app } = await boot();
  await ok('owner', 'POST', '/api/shifts/open', { startingCash: 0 });
  const { catalog, settings } = await ok('owner', 'GET', '/api/pos/bootstrap');
  const water = findItem(catalog, 'ماء');
  const lines = [{ variantId: water.variants[0].id, qty: 3 }];
  const sale = (await ok('owner', 'POST', '/api/sales', { clientId: randomUUID(), lines, clientTotal: clientTotal(catalog, settings, lines), payments: [{ typeId: 'cash', amount: 1500 }] })).receipt;
  // محاكاة: الخادم انطفأ قبل تطبيق الآثار
  await db.collection('stock_moves').deleteMany({ refId: sale.id });
  await db.collection('variants').updateOne({ _id: water.variants[0].id }, { $inc: { stock: 3 } });
  await db.collection('receipts').updateOne({ _id: sale.id }, { $set: { effectsPending: true } });
  await app.start();
  const stock = (await ok('owner', 'GET', '/api/admin/inventory')).rows.find((r) => r.name === 'ماء — قنينة').stock;
  assert.equal(stock, 45);
  await app.start();
  assert.equal((await ok('owner', 'GET', '/api/admin/inventory')).rows.find((r) => r.name === 'ماء — قنينة').stock, 45, 'الاستكمال لا يتكرر');
});

test('التقرير اليومي: الموارد المصروفة من الوصفات تُطرح من المخزون وتظهر مع المبيعات', async () => {
  const { ok, call } = await boot();
  const { catalog, settings } = await ok('owner', 'GET', '/api/pos/bootstrap');
  assert.deepEqual(settings.paymentTypes.map((p) => p.name), ['نقد', 'كي'], 'طرق الدفع: نقد أو كي');
  await ok('owner', 'POST', '/api/shifts/open', { startingCash: 0 });
  const latte = findItem(catalog, 'لاتيه');
  const big = latte.variants.find((v) => v.name === 'كبير'); // بن 18غ، حليب 300مل، كوب 12 أونصة
  const milkOpt = catalog.modifiers.find((m) => m.name === 'نوع الحليب').options[0].id;
  const lines = [{ variantId: big.id, qty: 2, modifierOptionIds: [milkOpt] }];
  const total = clientTotal(catalog, settings, lines);
  await ok('owner', 'POST', '/api/sales', { clientId: randomUUID(), lines, discountIds: [], diningOption: 'takeaway', clientTotal: total, payments: [{ typeId: 'qi', amount: total }] });

  const d = await ok('owner', 'GET', '/api/admin/reports/daily', null, { date: '2026-10-14' });
  assert.equal(d.summary.salesCount, 1);
  assert.equal(d.summary.net, total);
  assert.equal(d.byPayment[0].label, 'كي');
  const row = (name) => d.consumption.find((c) => c.name === name);
  assert.equal(row('بن إسبريسو').used, 36);
  assert.equal(row('حليب كامل').used, 600);
  assert.equal(row('كوب 12 أونصة').used, 2);
  assert.equal(row('بن إسبريسو').stock, 5000 - 36, 'طُرحت من المخزون');
  assert.equal(row('بن إسبريسو').unit, 'غ');
  assert.ok(d.consumptionCost > 0);
  assert.equal(d.consumption.find((c) => c.name === 'ثلج'), undefined, 'ما لم يُصرف لا يظهر');
  assert.equal((await call('owner', 'GET', '/api/admin/reports/daily', null, { date: 'أمس' })).body.error, 'INVALID_RANGE');
});

test('مقهى بطرق الدفع القديمة الافتراضية ينتقل إلى نقد أو كي', async () => {
  const { ok, db } = await boot();
  const store = (await db.collection('settings').find({}).toArray()).find((s) => s.paymentTypes);
  await db.collection('settings').updateOne({ _id: store._id }, { $set: { paymentTypes: [
    { id: 'cash', name: 'نقد', kind: 'cash', active: true }, { id: 'card', name: 'بطاقة', kind: 'card', active: true },
    { id: 'zain', name: 'زين كاش', kind: 'other', active: true }, { id: 'fib', name: 'FIB', kind: 'other', active: true },
  ] } });
  const { settings } = await ok('owner', 'GET', '/api/pos/bootstrap');
  assert.deepEqual(settings.paymentTypes.map((p) => p.id), ['cash', 'qi']);
});
