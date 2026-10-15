// اختبار الواجهة بلا متصفح: الإجراءات الحقيقية (نفس ما تطلقه النقرات) + الخادم الحقيقي في الذاكرة،
// ورسم كل شاشة ونافذة إلى HTML للتأكد من خلوها من الأخطاء والقيم الفارغة.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoBackend, DEMO_PINS } from '../demo/backend.js';

globalThis.location = { hash: '' };
globalThis.history = { replaceState: (_s, _t, url) => { location.hash = url; } };
const { views, navigate } = await import('../public/js/app.js');
const { state, runAction } = await import('../public/js/ui.js');

const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/[⁦⁩]/g, '').replace(/\s+/g, ' ');
const screen = () => views.app(state) + (state.modal ? views.modal(state) : '');
const clean = (html, where) => {
  assert.doesNotMatch(html, /undefined|NaN|\[object Object\]|null د\.ع/, `قيم فارغة في ${where}`);
};
const el = (dataset = {}, extra = {}) => ({ dataset, value: '', checked: false, ...extra });
async function go(hash) { location.hash = hash; await navigate(); }
async function login(pin) {
  state.view = { pin: '' };
  for (const k of pin) await runAction('pin-key', el({ k }));
  if (pin.length < 6) await runAction('pin-submit');
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(state.employee, `الدخول بالرمز ${pin}`);
}

const { backend } = await createDemoBackend();
globalThis.MORECASH_BACKEND = backend;
state.ready = true;

test('الصفحة الرئيسية، إنشاء حساب مقهى جديد، ثم الدخول للمقهى التجريبي', async () => {
  let html = screen();
  assert.match(text(html), /كاشير يعرف القهوة/);
  assert.match(html, /href="#\/signup"/);
  clean(html, 'الرئيسية');
  await go('#/login'); html = screen(); clean(html, 'الدخول'); assert.match(text(html), /تسجيل الدخول/);
  await go('#/signup'); html = screen(); clean(html, 'إنشاء حساب'); assert.match(text(html), /إنشاء الحساب وفتح المقهى/);

  await runAction('signup', el(), {}, { shopName: 'قهوة دجلة', ownerName: 'زهراء', email: 'zahraa@dijla.iq', password: 'dijla-coffee-1', pin: '4826', pin2: '4826', seed: true });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(state.shop.name, 'قهوة دجلة');
  assert.equal(state.employee.name, 'زهراء');
  assert.ok(state.catalog.items.length > 10, 'قائمة جاهزة للمقهى الجديد');
  await go('#/admin/settings');
  html = screen(); clean(html, 'إعدادات المالك');
  assert.match(text(html), /حساب المقهى/);
  assert.match(text(html), /zahraa@dijla\.iq/);

  await runAction('leave-ask');
  assert.equal(state.modal.type, 'leave-device');
  clean(screen(), 'نافذة الخروج');
  await runAction('leave-confirm');
  assert.equal(state.shop, null);
  assert.match(text(screen()), /كاشير يعرف القهوة/);

  await runAction('demo-enter');
  assert.equal(state.shop.name, 'مقهى مور');
  assert.equal(state.employee, null);
});

test('شاشة الرمز ثم الكاشير: طلب بإضافات وخصم وعميل ودفع مقسّم', async () => {
  let html = screen();
  assert.match(text(html), /أدخل رمزك/);
  clean(html, 'الدخول');

  await login(DEMO_PINS.cashier);
  assert.equal(state.employee.role, 'cashier');
  await go('#/pos');
  html = screen();
  clean(html, 'البيع');
  assert.match(text(html), /قهوة ساخنة/);
  assert.doesNotMatch(html, /href="#\/admin"/, 'الكاشير لا يرى الإدارة');
  // تنبيه المخزون المنخفض ظاهر للكاشير (بلا رابط للمخزون)، ويُخفى حتى تتغير القائمة
  assert.ok(state.catalog.lowStock.length > 0, 'بيانات التجربة فيها مواد منخفضة');
  assert.match(html, /class="low-banner/);
  assert.doesNotMatch(html, /href="#\/admin\/inventory"/);
  await runAction('low-dismiss');
  assert.doesNotMatch(screen(), /class="low-banner/);
  assert.match(screen(), /class="splitter"/, 'مقبض تغيير حجم نافذة الطلب');

  const latte = state.catalog.items.find((i) => i.name === 'لاتيه');
  await runAction('pos-item', el({ id: latte.id }));
  assert.equal(state.modal.type, 'item');
  assert.equal(state.modal.options.length, 1, 'الحليب الإلزامي مختار مسبقاً');
  html = screen(); clean(html, 'نافذة الصنف');
  assert.match(text(html), /نوع الحليب/);
  const milk = state.catalog.modifiers.find((m) => m.name === 'نوع الحليب');
  const oat = milk.options.find((o) => o.name === 'حليب شوفان');
  const extras = state.catalog.modifiers.find((m) => m.name === 'إضافات');
  await runAction('item-variant', el({ id: latte.variants[1].id }));
  await runAction('item-option', el({ group: milk.id, id: oat.id }));
  await runAction('item-option', el({ group: extras.id, id: extras.options[0].id }));
  await runAction('item-qty', el({ d: '1' }));
  assert.equal(state.modal.options.length, 2, 'الحليب الواحد استُبدل لا أُضيف');
  await runAction('item-save');
  const water = state.catalog.items.find((i) => i.name === 'ماء');
  await runAction('pos-item', el({ id: water.id }));
  await runAction('pos-item', el({ id: water.id }));
  assert.equal(state.pos.cart.lines.length, 2, 'الماء المكرر دُمج');
  html = screen(); clean(html, 'التذكرة');
  // 2 × (6000 + 1000 + 750) + 2 × 500 = 16,500
  assert.match(text(html), /دفع 16,500 د\.ع/);

  const morning = state.catalog.discounts.find((d) => d.name === 'عرض الصباح');
  await runAction('pos-discounts');
  html = screen(); clean(html, 'الخصومات');
  assert.doesNotMatch(text(html), /خصم الموظفين/, 'الخصم المقيد مخفي عن الكاشير');
  await runAction('ticket-discount', el({ id: morning.id }));
  await runAction('close-modal');
  assert.match(text(screen()), /دفع 14,850 د\.ع/);

  await runAction('pos-customer');
  await runAction('customer-search', el({}, { value: 'علي' }));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(state.modal.results.length, 1);
  await runAction('customer-pick', el({ id: state.modal.results[0].id }));
  assert.equal(state.pos.cart.customer.name, 'علي حسن');

  await runAction('pos-charge');
  html = screen(); clean(html, 'الدفع');
  assert.equal(state.modal.total, 14850);
  await runAction('pay-type', el({ id: 'qi' }));
  await runAction('pay-amount', el({}, { value: '4850' }));
  await runAction('pay-add');
  assert.equal(state.modal.payments.length, 1);
  await runAction('pay-type', el({ id: 'cash' }));
  assert.doesNotMatch(screen(), /id="pay-tendered"/, 'لا حقل لإدخال المستلم يدوياً');
  await runAction('pay-bill', el({ v: '5000' }));
  assert.match(text(screen()), /ناقص 5,000 د\.ع/);
  assert.match(screen(), /data-action="pay-confirm" disabled/, 'لا تأكيد والمستلم ناقص');
  await runAction('pay-bill', el({ v: '5000' }));
  assert.deepEqual(state.modal.bills, [5000, 5000], 'الفئة تُضاف ما دام المستلم ناقصاً');
  await runAction('pay-bill', el({ v: '25000' }));
  assert.deepEqual(state.modal.bills, [25000], 'وبعد الاكتمال تبدأ اختياراً جديداً');
  assert.match(text(screen()), /الباقي للعميل 15,000 د\.ع/);
  await runAction('pay-exact');
  assert.deepEqual(state.modal.bills, []);
  await runAction('pay-bill', el({ v: '10000' }));
  html = screen(); clean(html, 'الدفع المقسّم');
  assert.match(text(html), /المتبقي 10,000 د\.ع/);
  await runAction('pay-confirm');
  assert.equal(state.modal.stage, 'done');
  html = screen(); clean(html, 'تم الدفع');
  assert.match(text(html), /تم الدفع · إيصال #\d+/);
  assert.equal(state.pos.cart.lines.length, 0);
  await runAction('pay-print');
  assert.equal(state.modal.type, 'receipt-preview', 'المعاينة بدل نافذة الطباعة في النسخة التجريبية');
  clean(screen(), 'معاينة الإيصال');
  assert.match(text(screen()), /علي حسن/);
});

test('التذاكر المفتوحة، التحضير، الوردية، العملاء، الإيصالات', async () => {
  await runAction('close-modal');
  await runAction('pos-tickets');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(state.modal.list.length, 2);
  clean(screen(), 'التذاكر');
  await runAction('ticket-open', el({ id: state.modal.list[0].id }));
  assert.ok(state.pos.cart.ticket);
  assert.ok(state.pos.cart.lines.length > 0);
  await runAction('pos-save');
  assert.equal(state.pos.cart.lines.length, 0, 'التحديث يحفظ ويفرغ السلة');

  await go('#/kds');
  let html = screen(); clean(html, 'التحضير');
  const first = state.view.kds[0];
  await runAction('kds-advance', el({ id: first.id, from: first.prep.status }));

  await go('#/shift');
  html = screen(); clean(html, 'الوردية');
  assert.match(text(html), /النقد المتوقع في الدرج/);

  await go('#/customers');
  html = screen(); clean(html, 'العملاء');
  assert.match(text(html), /نور الهدى/);

  await go('#/receipts');
  html = screen(); clean(html, 'الإيصالات');
  const sale = state.view.receipts.list.find((r) => r.type === 'sale');
  await runAction('receipt-open', el({ id: sale.id }));
  await new Promise((r) => setTimeout(r, 0));
  html = screen(); clean(html, 'تفاصيل الإيصال');
  assert.doesNotMatch(html, /data-action="refund-start"/, 'الكاشير لا يرى زر الاسترجاع');
});

test('المدير: استرجاع جزئي، إغلاق وردية، ولوحة الإدارة بكل أقسامها', async () => {
  await runAction('lock');
  assert.equal(state.employee, null);
  await login(DEMO_PINS.owner);
  await go('#/receipts');
  const sale = state.view.receipts.list.find((r) => r.type === 'sale' && r.itemsCount > 1);
  await runAction('receipt-open', el({ id: sale.id }));
  await new Promise((r) => setTimeout(r, 0));
  await runAction('refund-start');
  await runAction('refund-qty', el({ i: '0', d: '1' }));
  clean(screen(), 'نافذة الاسترجاع');
  await runAction('refund-submit', el(), {}, { reason: 'بارد', paymentTypeId: 'cash', restock: false });
  assert.equal(state.modal, null);
  assert.equal(state.view.receipts.detail.refunds.length, 1);

  for (const sub of ['dashboard', 'daily', 'reports', 'shifts', 'items', 'categories', 'modifiers', 'discounts', 'inventory', 'employees', 'settings']) {
    await go(`#/admin/${sub}`);
    const html = screen();
    clean(html, `الإدارة/${sub}`);
    assert.ok(html.length > 1500, `قسم ${sub} مرسوم`);
  }
  // التقرير اليومي: مبيعات اليوم + الموارد المصروفة، معاينة الطباعة، والمشاركة (نسخ عند غياب navigator.share)
  await go('#/admin/daily');
  const daily = state.view.admin.daily;
  assert.ok(daily.summary.salesCount > 0, 'مبيعات اليوم في التقرير');
  assert.ok(daily.consumption.some((c) => c.ingredient && c.used > 0), 'موارد مصروفة من الوصفات');
  assert.match(text(screen()), /الموارد المصروفة اليوم/);
  await runAction('daily-print');
  assert.equal(state.modal.type, 'receipt-preview');
  assert.match(text(screen()), /التقرير اليومي/);
  await runAction('close-modal');
  let copied = '';
  const nav = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (t) => { copied = t; } } }, configurable: true });
  await runAction('daily-share');
  Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true });
  assert.match(copied, /صافي المبيعات/);
  assert.match(copied, /الموارد المصروفة/);

  await go('#/admin/reports');
  for (const k of ['items', 'categories', 'employees', 'payments', 'modifiers', 'discounts', 'dining', 'days']) {
    await runAction('report-tab', el({ k }));
    clean(screen(), `تقرير ${k}`);
  }
  await runAction('report-preset', el({ k: 'week' }));
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(state.view.admin.report.summary.salesCount > 100, 'تقرير الأسبوع يحوي بيانات');
  const s = state.view.admin.report.summary;
  assert.equal(s.gross - s.refunds - s.discounts, s.net, 'معادلة صافي المبيعات');

  // تحرير صنف وإضافة مكون للوصفة
  await go('#/admin/items');
  const latte = state.view.admin.items.find((i) => i.name === 'لاتيه');
  await runAction('item-edit', el({ id: latte.id }));
  clean(screen(), 'محرر الصنف');
  assert.match(text(screen()), /الكميات التقريبية لكل وحدة مباعة/);
  await runAction('v-field', el({ i: '0', k: 'price' }, { value: '5250' }));
  await runAction('item-submit');
  assert.equal(state.modal, null);
  assert.equal(state.view.admin.items.find((i) => i.name === 'لاتيه').variants[0].price, 5250);

  // استلام مخزون
  await go('#/admin/inventory');
  const milk = state.view.admin.inventory.rows.find((r) => r.name === 'حليب كامل');
  await runAction('inv-adjust', el({ id: milk.variantId }));
  clean(screen(), 'تعديل المخزون');
  await runAction('inv-adjust-submit', el(), {}, { qty: '6000', cost: '2.75', note: 'المورد' });
  assert.equal(state.view.admin.inventory.rows.find((r) => r.name === 'حليب كامل').stock, milk.stock + 6000);
  assert.match(screen(), /class="alert-low"/, 'تنبيه واضح بالمواد تحت الحد');

  // استلام مشتريات متعددة يدوياً مع مراجعة قبل التأكيد
  await runAction('rcv-open');
  assert.equal(state.modal.type, 'receive');
  const bean = state.view.admin.stockItems.find((x) => x.name === 'بن إسبريسو');
  const cups = state.view.admin.stockItems.find((x) => x.name === 'كوب 8 أونصة');
  assert.match(screen(), /data-action="rcv-submit" disabled/, 'سطر فارغ يمنع التأكيد');
  await runAction('rcv-field', el({ i: '0', k: 'variantId' }, { value: bean.id }));
  await runAction('rcv-field', el({ i: '0', k: 'qty' }, { value: '١٠٠٠' }));
  await runAction('rcv-field', el({ i: '0', k: 'total' }, { value: '40000' }));
  await runAction('rcv-add');
  await runAction('rcv-field', el({ i: '1', k: 'variantId' }, { value: cups.id }));
  await runAction('rcv-field', el({ i: '1', k: 'qty' }, { value: '200' }));
  let rcv = screen(); clean(rcv, 'استلام المشتريات');
  assert.match(text(rcv), /التكلفة: 40 د\.ع لكل غ/);
  assert.match(text(rcv), /تأكيد وإضافة للمخزون \(2\)/);
  const beanBefore = state.view.admin.inventory.rows.find((r) => r.variantId === bean.id).stock;
  await runAction('rcv-submit');
  assert.equal(state.modal, null);
  assert.equal(state.view.admin.inventory.rows.find((r) => r.variantId === bean.id).stock, beanBefore + 1000);

  // الإعدادات: تفعيل ضريبة مضافة 10% ثم إعادتها
  await go('#/admin/settings');
  const st = state.view.admin.settings;
  const form = { name: st.name, address: '', phone: '', header: '', footer: 'شكراً', showCustomer: true, taxMode: 'added', taxRate: '10', taxName: 'ضريبة',
    loyaltyEnabled: true, loyaltyRate: '5', cashVarianceAlert: '1000', dining: 'محلي، سفري', kds: true, openTickets: true };
  st.paymentTypes.forEach((p, i) => { form[`pt_name_${i}`] = p.name; form[`pt_kind_${i}`] = p.kind; form[`pt_active_${i}`] = p.active; });
  await runAction('settings-save', el(), {}, form);
  assert.equal(state.settings.tax.rateBp, 1000);
  assert.equal(state.settings.diningOptions.length, 2);

  // إغلاق الوردية
  await go('#/shift');
  const expected = state.view.shift.live.expectedCash;
  await runAction('shift-close', el(), {}, { actualCash: String(expected), note: '' });
  assert.equal(state.shift, null);
  await go('#/pos');
  assert.match(text(screen()), /فتح وردية جديدة/);
  clean(screen(), 'بوابة الوردية');
});
