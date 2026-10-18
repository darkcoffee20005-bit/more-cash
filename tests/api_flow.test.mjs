// تدفقات العمل الكاملة عبر واجهة API (الدالة handle نفسها التي يستخدمها خادم HTTP).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MemoryDb } from '../server/db/memory.js';
import { ensureIndexes } from '../server/db/indexes.js';
import { createApp } from '../server/app/index.js';
import { calculateTicket, unitPrice } from '../shared/calc.js';

async function boot({ seed = true, readInvoice = null } = {}) {
  const db = new MemoryDb({ newId: randomUUID });
  await ensureIndexes(db);
  let clock = new Date('2026-10-14T07:00:00Z'); // 10:00 بتوقيت بغداد
  const app = createApp({ db, now: () => clock, log: { error() {}, warn() {}, info() {} }, readInvoice });
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

  // مقهى عدّل طرقه (اسم مختلف أو طريقة معطلة) لا تُمس إعداداته
  const custom = [
    { id: 'cash', name: 'نقد', kind: 'cash', active: true }, { id: 'card', name: 'ماستركارد', kind: 'card', active: true },
    { id: 'zain', name: 'زين كاش', kind: 'other', active: true }, { id: 'fib', name: 'FIB', kind: 'other', active: false },
  ];
  await db.collection('settings').updateOne({ _id: store._id }, { $set: { paymentTypes: custom } });
  const again = await ok('owner', 'GET', '/api/pos/bootstrap');
  assert.deepEqual(again.settings.paymentTypes.map((p) => p.name), ['نقد', 'ماستركارد', 'زين كاش', 'FIB']);
});

test('استلام مشتريات: إدخال يدوي متعدد الأسطر، وقراءة فاتورة تُعاد للمراجعة قبل أي إضافة', async () => {
  let seen = null;
  const readInvoice = async ({ stock }) => {
    seen = stock;
    const bean = stock.find((x) => x.name === 'بن إسبريسو');
    return { supplier: 'مخازن الرافدين', date: '2026-10-14', total: 95000, lines: [
      { description: 'بن برازيلي', invoiceQty: 2, invoiceUnit: 'كيلو', lineTotal: 80000, matchId: bean.id, stockQty: 2000 },
      { description: 'مناديل', invoiceQty: 5, invoiceUnit: 'باكيت', lineTotal: 15000, matchId: 'غير-موجود', stockQty: 5 },
    ] };
  };
  const { ok, call } = await boot({ readInvoice });
  const items = await ok('owner', 'GET', '/api/admin/inventory/stock-items');
  const bean = items.find((x) => x.name === 'بن إسبريسو');
  const milk = items.find((x) => x.name === 'حليب كامل');
  assert.equal(bean.unit, 'غ');

  // الفاتورة: لا يتغير المخزون بالقراءة، والسطر غير المطابق يبقى بلا مادة
  const before = (await ok('owner', 'GET', '/api/admin/inventory')).rows.find((r) => r.variantId === bean.id).stock;
  const scan = await ok('owner', 'POST', '/api/admin/inventory/scan', { image: 'A'.repeat(200), mediaType: 'image/jpeg' });
  assert.ok(seen.some((x) => x.id === bean.id), 'قائمة المخزون أُرسلت للمطابقة');
  assert.equal(scan.supplier, 'مخازن الرافدين');
  assert.deepEqual(scan.lines.map((l) => [l.variantId, l.qty]), [[bean.id, 2000], [null, null]]);
  assert.equal((await ok('owner', 'GET', '/api/admin/inventory')).rows.find((r) => r.variantId === bean.id).stock, before);
  assert.equal((await call('owner', 'POST', '/api/admin/inventory/scan', { image: 'x', mediaType: 'image/jpeg' })).body.error, 'INVALID_IMAGE');

  // التأكيد بعد المراجعة: يضيف الكميات ويحدّث التكلفة بالمتوسط المرجح، ومرة واحدة فقط مهما تكرر الطلب
  const body = { supplier: 'مخازن الرافدين', lines: [{ id: 'l-bean-1', variantId: bean.id, qty: 2000, total: 80000 }, { id: 'l-milk-1', variantId: milk.id, qty: 12000, total: 30000 }] };
  const r = await ok('owner', 'POST', '/api/admin/inventory/receive', body);
  assert.equal(r.received, 2);
  assert.equal((await ok('owner', 'POST', '/api/admin/inventory/receive', body)).received, 0, 'التكرار لا يضاعف المخزون');
  const inv = await ok('owner', 'GET', '/api/admin/inventory');
  const beanRow = inv.rows.find((x) => x.variantId === bean.id);
  assert.equal(beanRow.stock, before + 2000);
  assert.equal(beanRow.costMilli, Math.round((5000 * 30000 + 2000 * 40000) / 7000), 'متوسط مرجح: 30 د.ع/غ القديم و40 د.ع/غ الجديد');
  const hist = await ok('owner', 'GET', `/api/admin/inventory/${bean.id}/history`);
  assert.ok(hist.some((h) => h.reason === 'receive' && h.note === 'مشتريات من مخازن الرافدين'));
  assert.equal((await call('owner', 'POST', '/api/admin/inventory/receive', { lines: [{ id: 'l-z', variantId: bean.id, qty: 0 }] })).status, 400);
  assert.equal((await call('owner', 'POST', '/api/admin/inventory/receive', { lines: [null] })).status, 400, 'سطر فارغ = 400 لا 500');

  // الدفعة كاملة أو لا شيء: سطر لمادة غير متتبعة يرفض الدفعة قبل أي كتابة
  const latteVariant = (await ok('owner', 'GET', '/api/pos/bootstrap')).catalog.items.find((i) => i.name === 'لاتيه').variants[0].id;
  const beanNow = (await ok('owner', 'GET', '/api/admin/inventory')).rows.find((x) => x.variantId === bean.id).stock;
  const mixed = await call('owner', 'POST', '/api/admin/inventory/receive', { lines: [{ id: 'l-ok', variantId: bean.id, qty: 100 }, { id: 'l-bad', variantId: latteVariant, qty: 1 }] });
  assert.equal(mixed.body.error, 'VARIANT_NOT_TRACKED');
  assert.equal((await ok('owner', 'GET', '/api/admin/inventory')).rows.find((x) => x.variantId === bean.id).stock, beanNow, 'لم يُضف شيء');

  // إعادة المحاولة بعد حذف سطر من الوسط: كل سطر بمفتاحه فلا يُتخطى أي سطر
  const cups = items.find((x) => x.name === 'كوب 8 أونصة');
  const tea = items.find((x) => x.name === 'شاي سيلاني');
  await ok('owner', 'POST', '/api/admin/inventory/receive', { lines: [{ id: 'r-a', variantId: cups.id, qty: 10 }] });
  const retry = await ok('owner', 'POST', '/api/admin/inventory/receive', { lines: [{ id: 'r-a', variantId: cups.id, qty: 10 }, { id: 'r-c', variantId: tea.id, qty: 500 }] });
  assert.equal(retry.received, 1, 'السطر الجديد أُضيف رغم أن موضعه تغيّر');
});

test('قراءة الفاتورة بدون مفتاح API: رسالة واضحة والإدخال اليدوي يبقى متاحاً', async () => {
  const { call } = await boot();
  const r = await call('owner', 'POST', '/api/admin/inventory/scan', { image: 'A'.repeat(200), mediaType: 'image/jpeg' });
  assert.equal(r.status, 503);
  assert.equal(r.body.error, 'SCAN_NOT_CONFIGURED');
});

test('سجل العمليات: الاسترجاع وتغيير السعر يظهران للمالك فقط', async () => {
  const { ok, call } = await boot();
  const { catalog, settings } = await ok('owner', 'GET', '/api/pos/bootstrap');
  await ok('owner', 'POST', '/api/shifts/open', { startingCash: 0 });
  const water = findItem(catalog, 'ماء');
  const lines = [{ variantId: water.variants[0].id, qty: 2 }];
  const total = clientTotal(catalog, settings, lines);
  const sale = (await ok('owner', 'POST', '/api/sales', { clientId: randomUUID(), lines, discountIds: [], diningOption: 'takeaway', clientTotal: total, payments: [{ typeId: 'cash', amount: total, tendered: total }] })).receipt;
  await ok('owner', 'POST', `/api/receipts/${sale.id}/refund`, { clientId: randomUUID(), lines: [{ index: 0, qty: 1 }], reason: 'خطأ في الطلب' });
  const item = (await ok('owner', 'GET', '/api/admin/items')).find((i) => i.name === 'ماء');
  await ok('owner', 'POST', '/api/admin/items', { ...item, variants: item.variants.map((v) => ({ ...v, price: 750 })) });
  await ok('owner', 'POST', '/api/admin/employees', { name: 'زينب', role: 'manager', pin: '2580' });

  const log = await ok('owner', 'GET', '/api/admin/audit', null, { from: '2026-10-14', to: '2026-10-14' });
  const refund = log.find((x) => x.action === 'receipt.refund');
  assert.equal(refund.data.reason, 'خطأ في الطلب');
  assert.equal(refund.byName, 'أحمد');
  const price = log.find((x) => x.action === 'item.update');
  assert.deepEqual(price.data.priceChanges.map((c) => [c.from, c.to]), [[500, 750]]);
  const onlyRefunds = await ok('owner', 'GET', '/api/admin/audit', null, { from: '2026-10-14', to: '2026-10-14', group: 'receipt' });
  assert.ok(onlyRefunds.length >= 1 && onlyRefunds.every((x) => x.action.startsWith('receipt.')));
  await ok('mgr', 'POST', '/api/auth/pin', { pin: '2580' });
  assert.equal((await call('mgr', 'GET', '/api/admin/audit', null, { from: '2026-10-14', to: '2026-10-14' })).status, 403, 'المدير لا يرى السجل');
});

test('المصروفات: صافي الربح، الدفع من الدرج، التكرار، والصلاحيات', async () => {
  const { ok, call } = await boot();
  const { catalog, settings } = await ok('owner', 'GET', '/api/pos/bootstrap');
  await ok('owner', 'POST', '/api/shifts/open', { startingCash: 100000 });
  const latte = findItem(catalog, 'لاتيه');
  const milk = catalog.modifiers.find((m) => m.name === 'نوع الحليب').options[0].id;
  const lines = [{ variantId: latte.variants[0].id, qty: 4, modifierOptionIds: [milk] }];
  const total = clientTotal(catalog, settings, lines);
  await ok('owner', 'POST', '/api/sales', { clientId: randomUUID(), lines, discountIds: [], diningOption: 'takeaway', clientTotal: total, payments: [{ typeId: 'cash', amount: total, tendered: total }] });

  const rent = { clientId: 'exp-rent', amount: 50000, category: 'rent', note: 'إيجار يوم' };
  await ok('owner', 'POST', '/api/admin/expenses', rent);
  await ok('owner', 'POST', '/api/admin/expenses', rent);
  await ok('owner', 'POST', '/api/admin/expenses', { clientId: 'exp-ice', amount: 3000, category: 'supplies', note: 'ثلج', fromDrawer: true });
  const list = await ok('owner', 'GET', '/api/admin/expenses', null, { from: '2026-10-14', to: '2026-10-14' });
  assert.equal(list.rows.length, 2, 'المصروف المكرر سُجّل مرة واحدة');
  assert.equal(list.total, 53000);
  const cur = await ok('owner', 'GET', '/api/shifts/current');
  assert.equal(cur.live.expectedCash, 100000 + total - 3000, 'المدفوع من الدرج يُنقص النقد المتوقع');

  const d = await ok('owner', 'GET', '/api/admin/reports/daily', null, { date: '2026-10-14' });
  assert.equal(d.summary.expenses, 53000);
  assert.equal(d.summary.netProfit, d.summary.profit - 53000);
  const rep = await ok('owner', 'GET', '/api/admin/reports', null, { from: '2026-10-14', to: '2026-10-14' });
  assert.equal(rep.summary.netProfit, rep.summary.profit - 53000);

  assert.equal((await call('owner', 'POST', '/api/admin/expenses', { clientId: 'exp-f', amount: 1, category: 'other', date: '2026-10-20' })).body.error, 'INVALID_DATE', 'لا مصروف بتاريخ مستقبلي');
  assert.equal((await call('owner', 'POST', '/api/admin/expenses', { clientId: 'exp-y', amount: 1, category: 'other', date: '2026-10-13', fromDrawer: true })).body.error, 'DRAWER_ONLY_TODAY');
  await ok('owner', 'POST', '/api/admin/employees', { name: 'سارة', role: 'cashier', pin: '1470' });
  await ok('cash', 'POST', '/api/auth/pin', { pin: '1470' });
  assert.equal((await call('cash', 'POST', '/api/admin/expenses', { clientId: 'exp-c', amount: 1, category: 'other' })).status, 403, 'الكاشير لا يسجل مصروفات');

  await ok('owner', 'DELETE', `/api/admin/expenses/${list.rows.find((x) => x.category === 'rent').id}`);
  assert.equal((await ok('owner', 'GET', '/api/admin/expenses', null, { from: '2026-10-14', to: '2026-10-14' })).total, 3000);
  const log = await ok('owner', 'GET', '/api/admin/audit', null, { from: '2026-10-14', to: '2026-10-14', group: 'expense' });
  assert.deepEqual(log.map((x) => x.action).sort(), ['expense.create', 'expense.create', 'expense.delete']);
});

test('بيع بلا إنترنت: يُسجَّل بوقته الفعلي ضمن الوردية، ولا يتكرر عند إعادة الإرسال', async () => {
  const { ok, tick } = await boot();
  const { catalog, settings } = await ok('owner', 'GET', '/api/pos/bootstrap');
  const shift = await ok('owner', 'POST', '/api/shifts/open', { startingCash: 0 });
  const water = findItem(catalog, 'ماء');
  const lines = [{ variantId: water.variants[0].id, qty: 1 }];
  const total = clientTotal(catalog, settings, lines);
  const body = (offlineAt) => ({ clientId: randomUUID(), lines, discountIds: [], diningOption: 'takeaway', clientTotal: total, payments: [{ typeId: 'cash', amount: total, tendered: total }], offlineAt });
  tick(2 * 3600_000); // وصل بعد ساعتين من البيع الفعلي
  const soldAt = new Date(new Date(shift.openedAt).getTime() + 30 * 60_000).toISOString();
  const b = body(soldAt);
  const r = (await ok('owner', 'POST', '/api/sales', b)).receipt;
  assert.equal(new Date(r.createdAt).toISOString(), soldAt, 'وقت البيع الفعلي');
  assert.equal(r.offline, true);
  assert.equal((await ok('owner', 'POST', '/api/sales', b)).duplicate, true, 'إعادة الإرسال لا تكرر');
  // وقت قبل فتح الوردية أو في المستقبل: يُتجاهل ويُستخدم وقت الوصول
  const early = (await ok('owner', 'POST', '/api/sales', body('2026-10-13T00:00:00Z'))).receipt;
  assert.notEqual(new Date(early.createdAt).toISOString(), '2026-10-13T00:00:00.000Z');
  assert.equal(early.offline, undefined);
});

test('إلغاء من شاشة التحضير: قبل التحضير تعود المكونات، والطلب الملغى كاملاً يختفي من الشاشة', async () => {
  const { ok, call } = await boot();
  const { catalog, settings } = await ok('owner', 'GET', '/api/pos/bootstrap');
  await ok('owner', 'POST', '/api/shifts/open', { startingCash: 0 });
  const big = findItem(catalog, 'لاتيه').variants.find((v) => v.name === 'كبير'); // بن 18غ، حليب 300مل، كوب
  const milkOpt = catalog.modifiers.find((m) => m.name === 'نوع الحليب').options[0].id;
  const croissant = findItem(catalog, 'كرواسون').variants[0];
  const lines = [{ variantId: big.id, qty: 2, modifierOptionIds: [milkOpt] }, { variantId: croissant.id, qty: 1 }];
  const total = clientTotal(catalog, settings, lines);
  const sell = async () => (await ok('owner', 'POST', '/api/sales', { clientId: randomUUID(), lines, discountIds: [], clientTotal: total, payments: [{ typeId: 'cash', amount: total }] })).receipt;
  const stock = async (n) => (await ok('owner', 'GET', '/api/admin/inventory')).rows.find((r) => r.name.startsWith(n)).stock;
  const coffee0 = await stock('بن إسبريسو');
  const croissant0 = await stock('كرواسون');

  // طلب لم يبدأ تحضيره: إلغاء كامل مع إرجاع المكونات والصنف الجاهز
  const a = await sell();
  assert.equal(await stock('بن إسبريسو'), coffee0 - 36);
  const kds = await ok('owner', 'GET', '/api/kds');
  const card = kds.find((o) => o.id === a.id);
  assert.equal(card.paymentTypeId, 'cash');
  assert.equal(card.lines[0].total + card.lines[1].total, total, 'مبالغ الأسطر تكفي لعرض المبلغ المسترجع');
  const body = { clientId: randomUUID(), lines: [{ index: 0, qty: 2 }, { index: 1, qty: 1 }], reason: 'ألغى الزبون الطلب', source: 'kds', restock: true, restockIngredients: true };
  const r = (await ok('owner', 'POST', `/api/receipts/${a.id}/refund`, body)).receipt;
  assert.equal(r.totals.total, total);
  assert.equal(await stock('بن إسبريسو'), coffee0, 'عادت مكونات المشروب');
  assert.equal(await stock('كرواسون'), croissant0, 'عاد الصنف الجاهز');
  assert.equal((await ok('owner', 'POST', `/api/receipts/${a.id}/refund`, body)).duplicate, true, 'النقرة المكررة لا تُرجع مرتين');
  assert.equal(await stock('بن إسبريسو'), coffee0);
  assert.equal((await ok('owner', 'GET', '/api/kds')).some((o) => o.id === a.id), false, 'الملغى كاملاً يختفي من الشاشة');
  assert.equal((await ok('owner', 'GET', `/api/receipts/${a.id}`)).prep.status, 'cancelled');

  // طلب بدأ تحضيره: المكونات صُرفت فلا تعود حتى لو طُلب ذلك؛ إلغاء جزئي يبقيه على الشاشة
  const b = await sell();
  await ok('owner', 'POST', `/api/kds/${b.id}/advance`, { from: 'new' });
  await ok('owner', 'POST', `/api/receipts/${b.id}/refund`, { clientId: randomUUID(), lines: [{ index: 0, qty: 1 }], reason: 'طلب خاطئ', source: 'kds', restockIngredients: true });
  assert.equal(await stock('بن إسبريسو'), coffee0 - 36, 'لا إرجاع لمكونات مشروب قيد التحضير');
  const still = (await ok('owner', 'GET', '/api/kds')).find((o) => o.id === b.id);
  assert.equal(still.lines[0].refundedQty, 1, 'يبقى على الشاشة والسطر الملغى مشطوب');

  // سجل العمليات يذكر أن الإلغاء من شاشة التحضير؛ والكاشير لا يلغي
  const log = await ok('owner', 'GET', '/api/admin/audit', null, { from: '2026-10-14', to: '2026-10-14', group: 'receipt' });
  assert.ok(log.some((x) => x.data?.source === 'kds'));
  await ok('owner', 'POST', '/api/admin/employees', { name: 'سارة', role: 'cashier', pin: '2468' });
  await ok('sara', 'POST', '/api/auth/pin', { pin: '2468' });
  assert.equal((await call('sara', 'POST', `/api/receipts/${b.id}/refund`, { clientId: randomUUID(), lines: [{ index: 1, qty: 1 }], reason: 'خطأ' })).status, 403);
});

test('إلغاء طلب مسلَّم لم يستلمه الزبون: الكاشير يلغي من ورديته فقط، المشروب هدر، ويظهر الإلغاء وسببه في التقرير', async () => {
  const { ok, call } = await boot();
  const { catalog, settings } = await ok('owner', 'GET', '/api/pos/bootstrap');
  await ok('owner', 'POST', '/api/admin/employees', { name: 'سارة', role: 'cashier', pin: '2468' });
  await ok('sara', 'POST', '/api/auth/pin', { pin: '2468' });
  await ok('sara', 'POST', '/api/shifts/open', { startingCash: 0 });
  const big = findItem(catalog, 'لاتيه').variants.find((v) => v.name === 'كبير');
  const milkOpt = catalog.modifiers.find((m) => m.name === 'نوع الحليب').options[0].id;
  const lines = [{ variantId: big.id, qty: 1, modifierOptionIds: [milkOpt] }];
  const total = clientTotal(catalog, settings, lines);
  const sale = (await ok('sara', 'POST', '/api/sales', { clientId: randomUUID(), lines, discountIds: [], clientTotal: total, payments: [{ typeId: 'cash', amount: total }] })).receipt;
  for (const from of ['new', 'preparing', 'ready']) await ok('sara', 'POST', `/api/kds/${sale.id}/advance`, { from });
  const kds = await ok('sara', 'GET', '/api/kds');
  assert.equal(kds.find((o) => o.id === sale.id).prep.status, 'served', 'المسلَّم يظهر في «سُلّم مؤخراً»');
  const coffee = (await ok('owner', 'GET', '/api/admin/inventory')).rows.find((r) => r.name === 'بن إسبريسو').stock;

  assert.equal((await call('sara', 'POST', `/api/receipts/${sale.id}/refund`, { clientId: randomUUID(), lines: [{ index: 0, qty: 1 }], reason: 'خطأ' })).status, 403, 'الاسترجاع العام للمدير');
  const res = await ok('sara', 'POST', `/api/receipts/${sale.id}/refund`, { clientId: randomUUID(), lines: [{ index: 0, qty: 1 }], reason: 'لم يستلمه الزبون — تركه وخرج', cancel: true, restockIngredients: true });
  assert.equal(res.receipt.cancel, true);
  assert.equal(res.receipt.totals.total, total, 'يُرجع المبلغ');
  assert.ok(res.receipt.wasteCost > 0, 'تكلفة المشروب هدر');
  assert.equal(res.receipt.totals.cost, 0, 'لا تُطرح من تكلفة البضاعة');
  assert.equal((await ok('owner', 'GET', '/api/admin/inventory')).rows.find((r) => r.name === 'بن إسبريسو').stock, coffee, 'المكونات لا تعود بعد التحضير');
  const after = await ok('sara', 'GET', `/api/receipts/${sale.id}`);
  assert.equal(after.cancelled.reason, 'لم يستلمه الزبون — تركه وخرج');
  assert.equal(after.cancelled.full, true);
  assert.equal((await ok('sara', 'GET', '/api/kds')).some((o) => o.id === sale.id), false);
  const list = await ok('sara', 'GET', '/api/receipts');
  assert.equal(list.find((r) => r.id === sale.id).cancel, true);

  const d = await ok('owner', 'GET', '/api/admin/reports/daily', null, { date: '2026-10-14' });
  assert.equal(d.cancelled.length, 1);
  assert.equal(d.cancelled[0].saleNumber, sale.number);
  assert.equal(d.cancelled[0].reason, 'لم يستلمه الزبون — تركه وخرج');
  assert.equal(d.summary.wasteCost, res.receipt.wasteCost);
  assert.equal(d.summary.net, 0);
  assert.equal(d.summary.profit, -res.receipt.wasteCost, 'الهدر خسارة على الربح');
  const log = await ok('owner', 'GET', '/api/admin/audit', null, { from: '2026-10-14', to: '2026-10-14', group: 'receipt' });
  assert.ok(log.some((x) => x.action === 'receipt.cancel' && x.data.wasteCost === res.receipt.wasteCost));

  // طلب من وردية سابقة: الكاشير لا يلغيه، والمدير يستطيع
  const old = (await ok('sara', 'POST', '/api/sales', { clientId: randomUUID(), lines, discountIds: [], clientTotal: total, payments: [{ typeId: 'cash', amount: total }] })).receipt;
  const x = await ok('sara', 'GET', '/api/shifts/current');
  await ok('sara', 'POST', '/api/shifts/close', { actualCash: x.live.expectedCash });
  await ok('sara', 'POST', '/api/shifts/open', { startingCash: 0 });
  assert.equal((await call('sara', 'POST', `/api/receipts/${old.id}/refund`, { clientId: randomUUID(), lines: [{ index: 0, qty: 1 }], reason: 'لم يستلمه', cancel: true })).status, 403);
  assert.equal((await call('owner', 'POST', `/api/receipts/${old.id}/refund`, { clientId: randomUUID(), lines: [{ index: 0, qty: 1 }], reason: 'لم يستلمه', cancel: true })).status, 200);
});
