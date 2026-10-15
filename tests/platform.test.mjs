// المنصة متعددة المقاهي: إنشاء حساب، دخول، ربط الجهاز، وعزل البيانات بين المقاهي.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDb } from '../server/db/memory.js';
import { ensureIndexes } from '../server/db/indexes.js';
import { createPlatform } from '../server/app/platform.js';

async function setup(opts = {}) {
  const db = new MemoryDb({ newId: () => crypto.randomUUID() });
  await ensureIndexes(db);
  let clock = new Date('2026-10-14T09:00:00Z');
  const p = createPlatform({ db, now: () => clock, passwordIterations: 1000, log: { error() {}, warn() {}, info() {} }, ...opts });
  const jar = {}; // جهاز → {token, deviceToken}
  const call = async (dev, method, path, body, query) => {
    const c = (jar[dev] ??= {});
    const r = await p.handle({ method, path, body, query, token: c.token ?? null, deviceToken: c.deviceToken ?? null, platformToken: c.platformToken ?? null, ip: dev });
    if (r.setToken !== undefined) c.token = r.setToken;
    if (r.setPlatform !== undefined) c.platformToken = r.setPlatform;
    if (r.setDevice !== undefined) c.deviceToken = r.setDevice;
    return r;
  };
  const ok = async (...a) => {
    const r = await call(...a);
    assert.equal(r.status, 200, `${a[1]} ${a[2]} → ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  return { db, p, call, ok, jar, tick: (ms) => { clock = new Date(clock.getTime() + ms); } };
}

const SHOP_A = { shopName: 'مقهى الزيتون', ownerName: 'أحمد', email: 'Ahmed@Zaytoon.iq', password: 'qahwa-2026!', pin: '1357' };
const SHOP_B = { shopName: 'بن الرافدين', ownerName: 'مريم', email: 'maryam@rafidain.iq', password: 'espresso#88', pin: '1357' };

test('إنشاء حساب يجهّز المقهى ويسجّل دخول الجهاز والمالك', async () => {
  const { ok, call, jar } = await setup();
  assert.deepEqual((await ok('a', 'GET', '/api/state')).shop, null);
  assert.equal((await call('a', 'GET', '/api/pos/bootstrap')).body.error, 'NO_SHOP');

  const r = await ok('a', 'POST', '/api/account/signup', { ...SHOP_A, seed: true });
  assert.equal(r.shop.name, 'مقهى الزيتون');
  assert.equal(r.employee.role, 'owner');
  assert.equal(jar.a.deviceToken.length, 64);

  const state = await ok('a', 'GET', '/api/state');
  assert.equal(state.shop.name, 'مقهى الزيتون');
  assert.equal(state.employee.name, 'أحمد');
  const boot = await ok('a', 'GET', '/api/pos/bootstrap');
  assert.ok(boot.catalog.items.length > 10, 'القائمة الجاهزة أضيفت');
  assert.ok(!('tenantId' in boot.catalog.items[0]), 'لا يتسرب tenantId للواجهة');
  assert.equal(boot.settings.name, 'مقهى الزيتون');

  // الإعداد القديم (مقهى واحد) مغلق في المنصة
  assert.equal((await call('a', 'POST', '/api/setup', { storeName: 'x', ownerName: 'y', pin: '2468' })).status, 404);
});

test('التحقق من مدخلات الحساب، والبريد لا يتكرر', async () => {
  const { ok, call } = await setup();
  assert.equal((await call('x', 'POST', '/api/account/signup', { ...SHOP_A, email: 'not-an-email' })).body.error, 'INVALID_EMAIL');
  assert.equal((await call('x', 'POST', '/api/account/signup', { ...SHOP_A, password: '12345678' })).body.error, 'WEAK_PASSWORD');
  assert.equal((await call('x', 'POST', '/api/account/signup', { ...SHOP_A, password: 'short' })).body.error, 'WEAK_PASSWORD');
  assert.equal((await call('x', 'POST', '/api/account/signup', { ...SHOP_A, pin: '1111' })).body.error, 'WEAK_PIN');
  await ok('a', 'POST', '/api/account/signup', SHOP_A);
  const dup = await call('b', 'POST', '/api/account/signup', { ...SHOP_B, email: ' ahmed@zaytoon.IQ ' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error, 'EMAIL_IN_USE');
});

test('عزل كامل بين مقهيين (نفس رمز PIN، نفس رقم الهاتف)', async () => {
  const { ok, call } = await setup();
  await ok('a', 'POST', '/api/account/signup', { ...SHOP_A, seed: true });
  await ok('b', 'POST', '/api/account/signup', { ...SHOP_B, seed: false });

  const bootB = await ok('b', 'GET', '/api/pos/bootstrap');
  assert.equal(bootB.catalog.items.length, 0, 'قائمة المقهى الآخر لا تظهر');
  assert.equal(bootB.settings.name, 'بن الرافدين');

  const custA = await ok('a', 'POST', '/api/customers', { name: 'علي', phone: '07701234567' });
  const custB = await ok('b', 'POST', '/api/customers', { name: 'علي آخر', phone: '07701234567' });
  assert.notEqual(custA.id, custB.id);
  assert.equal((await ok('b', 'GET', '/api/customers')).length, 1);
  assert.equal((await call('b', 'GET', `/api/customers/${custA.id}`)).status, 404, 'لا وصول لعميل مقهى آخر');

  // وردية مفتوحة في كل مقهى معاً
  await ok('a', 'POST', '/api/shifts/open', { startingCash: 10000 });
  await ok('b', 'POST', '/api/shifts/open', { startingCash: 20000 });
  assert.equal((await ok('a', 'GET', '/api/shifts/current')).startingCash, 10000);

  // أول إيصال في المقهى
  const boot = await ok('a', 'GET', '/api/pos/bootstrap');
  const water = boot.catalog.items.find((i) => i.name === 'ماء');
  const sale = await ok('a', 'POST', '/api/sales', {
    clientId: crypto.randomUUID(), lines: [{ variantId: water.variants[0].id, qty: 1, modifierOptionIds: [] }],
    discountIds: [], diningOption: 'takeaway', clientTotal: water.variants[0].price, payments: [{ typeId: 'cash', amount: water.variants[0].price, tendered: water.variants[0].price }],
  });
  assert.equal(sale.receipt.number, 1001);
  assert.equal((await call('b', 'GET', `/api/receipts/${sale.receipt.id}`)).status, 404, 'لا وصول لإيصال مقهى آخر');
  assert.equal((await ok('b', 'GET', '/api/receipts')).length, 0);

  // الإعدادات منفصلة
  await ok('a', 'PUT', '/api/admin/settings', { name: 'الزيتون — الكرادة' });
  assert.equal((await ok('b', 'GET', '/api/admin/settings')).name, 'بن الرافدين');
  assert.equal((await ok('a', 'GET', '/api/state')).shop.name, 'الزيتون — الكرادة');
});

test('رمز PIN يعمل فقط داخل المقهى المرتبط بالجهاز', async () => {
  const { ok, call } = await setup();
  await ok('a', 'POST', '/api/account/signup', SHOP_A);
  await ok('b', 'POST', '/api/account/signup', { ...SHOP_B, pin: '8642' });
  await ok('b', 'POST', '/api/auth/logout', {});
  assert.equal((await call('b', 'POST', '/api/auth/pin', { pin: '1357' })).status, 401, 'رمز مقهى A مرفوض على جهاز B');
  assert.equal((await ok('b', 'POST', '/api/auth/pin', { pin: '8642' })).employee.name, 'مريم');
  // جهاز بلا حساب لا يستطيع تجربة الرموز أصلاً
  assert.equal((await call('stranger', 'POST', '/api/auth/pin', { pin: '1357' })).body.error, 'NO_SHOP');
});

test('دخول جهاز جديد بالبريد وكلمة المرور، والقفل بعد محاولات خاطئة', async () => {
  const { ok, call, tick, jar } = await setup();
  await ok('a', 'POST', '/api/account/signup', SHOP_A);

  const bad = await call('tablet', 'POST', '/api/account/login', { email: SHOP_A.email, password: 'wrong-pass' });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error, 'BAD_CREDENTIALS');
  assert.equal((await call('tablet', 'POST', '/api/account/login', { email: 'nobody@x.iq', password: 'whatever1' })).body.error, 'BAD_CREDENTIALS', 'نفس الرسالة لبريد غير موجود');

  const r = await ok('tablet', 'POST', '/api/account/login', { email: '  AHMED@zaytoon.iq', password: SHOP_A.password });
  assert.equal(r.shop.name, 'مقهى الزيتون');
  const st = await ok('tablet', 'GET', '/api/state');
  assert.equal(st.shop.name, 'مقهى الزيتون');
  assert.equal(st.employee, null, 'يبقى إدخال رمز الموظف مطلوباً');
  await ok('tablet', 'POST', '/api/auth/pin', { pin: '1357' });

  for (let i = 0; i < 5; i++) await call(`p${i}`, 'POST', '/api/account/login', { email: SHOP_A.email, password: 'nope-nope' });
  const locked = await call('p9', 'POST', '/api/account/login', { email: SHOP_A.email, password: SHOP_A.password });
  assert.equal(locked.status, 429);
  assert.equal(locked.body.error, 'ACCOUNT_LOCKED');
  tick(6 * 60_000);
  await ok('p9', 'POST', '/api/account/login', { email: SHOP_A.email, password: SHOP_A.password });

  // الخروج من الجهاز يمسح الجلستين
  await ok('tablet', 'POST', '/api/account/logout', {});
  assert.equal(jar.tablet.deviceToken, null);
  assert.equal(jar.tablet.token, null);
  assert.equal((await ok('tablet', 'GET', '/api/state')).shop, null);
});

test('تغيير كلمة المرور للمالك فقط، ويخرج الأجهزة الأخرى', async () => {
  const { ok, call } = await setup();
  await ok('a', 'POST', '/api/account/signup', SHOP_A);
  await ok('a', 'POST', '/api/admin/employees', { name: 'سارة', role: 'cashier', pin: '2468' });
  await ok('other', 'POST', '/api/account/login', { email: SHOP_A.email, password: SHOP_A.password });
  assert.equal((await ok('a', 'GET', '/api/account')).email, 'ahmed@zaytoon.iq');

  assert.equal((await call('a', 'POST', '/api/account/password', { current: 'wrong', next: 'new-pass-77' })).body.error, 'WRONG_PASSWORD');
  await ok('a', 'POST', '/api/account/password', { current: SHOP_A.password, next: 'new-pass-77' });
  assert.equal((await ok('other', 'GET', '/api/state')).shop, null, 'الجهاز الآخر خرج');
  assert.equal((await ok('a', 'GET', '/api/state')).shop.name, 'مقهى الزيتون', 'هذا الجهاز باقٍ');
  assert.equal((await call('x', 'POST', '/api/account/login', { email: SHOP_A.email, password: SHOP_A.password })).status, 401);
  await ok('x', 'POST', '/api/account/login', { email: SHOP_A.email, password: 'new-pass-77' });

  await ok('a', 'POST', '/api/auth/logout', {});
  await ok('a', 'POST', '/api/auth/pin', { pin: '2468' });
  assert.equal((await call('a', 'POST', '/api/account/password', { current: 'new-pass-77', next: 'another-99' })).status, 403, 'الكاشير لا يغيّر كلمة المرور');
});

test('لوحة مفاتيح عربية: رمز بأرقام ٠-٩ يُقبل عند التسجيل، ويعمل بعدها بأي أرقام', async () => {
  const { ok, call } = await setup();
  const r = await call('ar', 'POST', '/api/account/signup', { shopName: 'مقهى السهم', ownerName: 'علي', email: 'ali@sahm.iq', password: 'qahwa-١٢٣٤!', pin: '٤٨٢٦' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await ok('ar', 'POST', '/api/auth/logout', {});
  assert.equal((await ok('ar', 'POST', '/api/auth/pin', { pin: '4826' })).employee.role, 'owner', 'الرمز نفسه بأرقام لاتينية');
  await ok('ar', 'POST', '/api/auth/logout', {});
  assert.equal((await ok('ar', 'POST', '/api/auth/pin', { pin: '۴۸۲۶' })).employee.role, 'owner', 'وبأرقام فارسية');
  // موظف جديد برمز عربي
  await ok('ar', 'POST', '/api/admin/employees', { name: 'سارة', role: 'cashier', pin: '٥٥٨٢' });
  await ok('ar', 'POST', '/api/auth/logout', {});
  assert.equal((await ok('ar', 'POST', '/api/auth/pin', { pin: '5582' })).employee.name, 'سارة');
  // الدخول من جهاز جديد بكلمة المرور كما كُتبت
  assert.equal((await ok('ar2', 'POST', '/api/account/login', { email: 'ALI@sahm.iq ', password: 'qahwa-١٢٣٤!' })).shop.name, 'مقهى السهم');
});

test('لوحة المزوّد: قائمة المقاهي، الإيقاف والتفعيل، وكلمة مرور مؤقتة', async () => {
  const { ok, call } = await setup({ admins: ['Boss@MoreCash.iq'], support: '9647700000000' });
  await ok('boss', 'POST', '/api/account/signup', { shopName: 'مقهى المزوّد', ownerName: 'المدير', email: 'boss@morecash.iq', password: 'boss-pass-2026', pin: '9087' });
  await ok('a', 'POST', '/api/account/signup', { ...SHOP_A, seed: false });
  await ok('b', 'POST', '/api/account/signup', { ...SHOP_B, seed: false });

  // الدخول: صاحب مقهى عادي لا يدخل اللوحة حتى بكلمة مروره الصحيحة
  assert.equal((await call('x', 'POST', '/api/platform/login', { email: SHOP_A.email, password: SHOP_A.password })).status, 401);
  assert.equal((await call('x', 'POST', '/api/platform/login', { email: 'boss@morecash.iq', password: 'wrong' })).status, 401);
  assert.equal((await call('x', 'GET', '/api/platform/shops')).status, 401, 'بلا جلسة لا بيانات');
  assert.equal((await ok('x', 'GET', '/api/support')).whatsapp, '9647700000000');
  await ok('admin', 'POST', '/api/platform/login', { email: ' boss@morecash.iq', password: 'boss-pass-2026' });
  assert.equal((await ok('admin', 'GET', '/api/platform/me')).email, 'boss@morecash.iq');
  const list = await ok('admin', 'GET', '/api/platform/shops');
  assert.equal(list.totals.shops, 3);
  const a = list.rows.find((r) => r.email === 'ahmed@zaytoon.iq');
  assert.equal(a.name, 'مقهى الزيتون');
  assert.equal((await ok('admin', 'GET', '/api/platform/shops', null, { search: 'رافدين' })).rows.length, 1);
  const errs = await ok('admin', 'GET', '/api/platform/errors');
  assert.equal(errs.count24h, 0);
  assert.deepEqual(errs.recent, []);

  // الإيقاف: كل طلبات المقهى تُرفض، والحالة تعرض أنه موقوف؛ المقاهي الأخرى لا تتأثر
  assert.equal((await call('admin', 'POST', `/api/platform/shops/${a.id}/disable`, {})).body.error, 'REQUIRED', 'السبب مطلوب');
  await ok('admin', 'POST', `/api/platform/shops/${a.id}/disable`, { reason: 'لم يُدفع الاشتراك' });
  assert.equal((await call('a', 'GET', '/api/pos/bootstrap')).body.error, 'SHOP_DISABLED');
  assert.equal((await ok('a', 'GET', '/api/state')).shop.disabled, true);
  assert.equal((await call('b', 'GET', '/api/pos/bootstrap')).status, 200);
  await ok('admin', 'POST', `/api/platform/shops/${a.id}/enable`, {});
  assert.equal((await call('a', 'GET', '/api/pos/bootstrap')).status, 200, 'عاد للعمل بعد التفعيل');

  // كلمة مرور مؤقتة: القديمة تبطل، أجهزة المقهى تُفصل، والجديدة تعمل مع طلب تغييرها
  const reset = await ok('admin', 'POST', `/api/platform/shops/${a.id}/reset-password`, {});
  assert.match(reset.tempPassword, /^[a-z2-9]{5}-[a-z2-9]{5}$/);
  assert.equal((await call('a', 'GET', '/api/pos/bootstrap')).body.error, 'NO_SHOP', 'الأجهزة القديمة فُصلت');
  assert.equal((await call('a2', 'POST', '/api/account/login', { email: SHOP_A.email, password: SHOP_A.password })).status, 401);
  const login = await ok('a2', 'POST', '/api/account/login', { email: SHOP_A.email, password: reset.tempPassword });
  assert.equal(login.mustChangePassword, true);
  await ok('a2', 'POST', '/api/auth/pin', { pin: SHOP_A.pin });
  await ok('a2', 'POST', '/api/account/password', { current: reset.tempPassword, next: 'new-pass-2026' });
  assert.equal((await ok('a3', 'POST', '/api/account/login', { email: SHOP_A.email, password: 'new-pass-2026' })).mustChangePassword, false);

  await ok('admin', 'POST', '/api/platform/logout', {});
  assert.equal((await call('admin', 'GET', '/api/platform/shops')).status, 401);
});

test('لوحة المزوّد معطلة إن لم يُضبط PLATFORM_ADMINS', async () => {
  const { call } = await setup();
  assert.equal((await call('x', 'POST', '/api/platform/login', { email: 'a@b.iq', password: 'x' })).status, 404);
});

test('الفروع: فرع جديد بنسخة من القائمة، عزل البيانات، تبديل الجهاز، وتقرير مجمّع', async () => {
  const { ok, call } = await setup({ admins: ['boss@morecash.iq'] });
  await ok('a', 'POST', '/api/account/signup', { ...SHOP_A, seed: true });
  const main = await ok('a', 'GET', '/api/pos/bootstrap');
  const water = main.catalog.items.find((i) => i.name === 'ماء');
  const latte = main.catalog.items.find((i) => i.name === 'لاتيه');

  // كاشير لا يدير الفروع
  await ok('a', 'POST', '/api/admin/employees', { name: 'سارة', role: 'cashier', pin: '1470' });
  await ok('a', 'POST', '/api/auth/logout', {});
  await ok('a', 'POST', '/api/auth/pin', { pin: '1470' });
  assert.equal((await call('a', 'GET', '/api/account/branches')).status, 403);
  await ok('a', 'POST', '/api/auth/logout', {});
  await ok('a', 'POST', '/api/auth/pin', { pin: SHOP_A.pin });

  // بيع في الفرع الرئيسي
  await ok('a', 'POST', '/api/shifts/open', { startingCash: 0 });
  await ok('a', 'POST', '/api/sales', { clientId: crypto.randomUUID(), lines: [{ variantId: water.variants[0].id, qty: 2 }], discountIds: [], diningOption: 'takeaway', clientTotal: 2 * water.variants[0].price, payments: [{ typeId: 'cash', amount: 2 * water.variants[0].price, tendered: 2 * water.variants[0].price }] });

  const branch = await ok('a', 'POST', '/api/account/branches', { name: 'الزيتون — المنصور', pin: '٢٤٦٨', copyMenu: true });
  const list = await ok('a', 'GET', '/api/account/branches');
  assert.deepEqual(list.map((b) => [b.name, b.current]), [['مقهى الزيتون', true], ['الزيتون — المنصور', false]]);

  // التبديل: يُطلب رمز الفرع الجديد، والقائمة منسوخة بمعرّفات جديدة ومخزون صفر
  const sw = await ok('a', 'POST', '/api/account/branches/switch', { tenantId: branch.id });
  assert.equal(sw.shop.name, 'الزيتون — المنصور');
  assert.equal((await ok('a', 'GET', '/api/state')).employee, null, 'خرج الموظف عند التبديل');
  await ok('a', 'POST', '/api/auth/pin', { pin: '2468' });
  const b = await ok('a', 'GET', '/api/pos/bootstrap');
  const bLatte = b.catalog.items.find((i) => i.name === 'لاتيه');
  assert.ok(bLatte, 'القائمة نُسخت');
  assert.notEqual(bLatte.id, latte.id, 'بمعرّفات جديدة');
  assert.equal(bLatte.variants.length, latte.variants.length);
  assert.equal(b.settings.paymentTypes.map((p) => p.name).join(), 'نقد,كي');
  const inv = await ok('a', 'GET', '/api/admin/inventory');
  assert.ok(inv.rows.length > 0 && inv.rows.every((r) => r.stock === 0), 'المخزون يبدأ من صفر');
  assert.equal((await ok('a', 'GET', '/api/receipts')).length, 0, 'لا يرى إيصالات الفرع الرئيسي');
  assert.equal((await call('a', 'POST', '/api/sales', { clientId: crypto.randomUUID(), lines: [{ variantId: water.variants[0].id, qty: 1 }], discountIds: [], diningOption: 'takeaway', clientTotal: water.variants[0].price, payments: [{ typeId: 'cash', amount: water.variants[0].price }] })).status >= 400, true, 'أصناف الفرع الآخر غير صالحة هنا');

  // بيع في الفرع ثم التقرير المجمّع
  await ok('a', 'POST', '/api/shifts/open', { startingCash: 0 });
  const bWater = b.catalog.items.find((i) => i.name === 'ماء');
  await ok('a', 'POST', '/api/sales', { clientId: crypto.randomUUID(), lines: [{ variantId: bWater.variants[0].id, qty: 3 }], discountIds: [], diningOption: 'takeaway', clientTotal: 3 * bWater.variants[0].price, payments: [{ typeId: 'cash', amount: 3 * bWater.variants[0].price, tendered: 3 * bWater.variants[0].price }] });
  const rep = await ok('a', 'GET', '/api/account/branches/report', null, { from: '2026-10-14', to: '2026-10-14' });
  assert.equal(rep.rows.length, 2);
  assert.equal(rep.rows[0].net, 2 * water.variants[0].price);
  assert.equal(rep.rows[1].net, 3 * bWater.variants[0].price);
  assert.equal(rep.totals.net, rep.rows[0].net + rep.rows[1].net);
  assert.equal(rep.totals.salesCount, 2);

  // مقهى آخر لا يرى ولا يبدّل إلى فروع غيره
  await ok('x', 'POST', '/api/account/signup', { ...SHOP_B, seed: false });
  assert.equal((await call('x', 'POST', '/api/account/branches/switch', { tenantId: branch.id })).status, 403);
  assert.equal((await ok('x', 'GET', '/api/account/branches')).length, 1);

  // لوحة المزوّد تعرض الفرع مع بريد مالكه، والدخول من جهاز جديد يفتح الفرع الرئيسي
  await ok('admin', 'POST', '/api/account/signup', { shopName: 'المزوّد', ownerName: 'مدير', email: 'boss@morecash.iq', password: 'boss-pass-2026', pin: '9087', seed: false });
  await ok('admin', 'POST', '/api/platform/login', { email: 'boss@morecash.iq', password: 'boss-pass-2026' });
  const shops = await ok('admin', 'GET', '/api/platform/shops');
  assert.equal(shops.rows.find((r) => r.id === branch.id).email, 'ahmed@zaytoon.iq');
  assert.equal((await ok('new', 'POST', '/api/account/login', { email: SHOP_A.email, password: SHOP_A.password })).shop.name, 'مقهى الزيتون');
});
