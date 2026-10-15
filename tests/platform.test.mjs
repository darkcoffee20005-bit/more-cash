// المنصة متعددة المقاهي: إنشاء حساب، دخول، ربط الجهاز، وعزل البيانات بين المقاهي.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDb } from '../server/db/memory.js';
import { ensureIndexes } from '../server/db/indexes.js';
import { createPlatform } from '../server/app/platform.js';

async function setup() {
  const db = new MemoryDb({ newId: () => crypto.randomUUID() });
  await ensureIndexes(db);
  let clock = new Date('2026-10-14T09:00:00Z');
  const p = createPlatform({ db, now: () => clock, passwordIterations: 1000, log: { error() {}, warn() {}, info() {} } });
  const jar = {}; // جهاز → {token, deviceToken}
  const call = async (dev, method, path, body, query) => {
    const c = (jar[dev] ??= {});
    const r = await p.handle({ method, path, body, query, token: c.token ?? null, deviceToken: c.deviceToken ?? null, ip: dev });
    if (r.setToken !== undefined) c.token = r.setToken;
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
