// الاشتراكات اليدوية وموافقة المزوّد: الحساب الجديد مغلق حتى الموافقة، صفحة الاشتراك ببيانات التحويل التي يتحكم بها المزوّد،
// طلب تحويل/نقد، موافقة بمدة (مدفوع أو مجاني)، التمديد من نهاية الاشتراك، الانتهاء (قراءة فقط)، والسجل والنسخة الاحتياطية.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDb } from '../server/db/memory.js';
import { ensureIndexes } from '../server/db/indexes.js';
import { createPlatform } from '../server/app/platform.js';
import { addMonths } from '../server/app/subscriptions.js';

async function setup() {
  const db = new MemoryDb({ newId: () => crypto.randomUUID() });
  await ensureIndexes(db);
  let clock = new Date('2026-10-14T09:00:00Z');
  const p = createPlatform({ db, now: () => clock, passwordIterations: 1000, log: { error() {}, warn() {}, info() {} }, admins: ['boss@morecash.iq'], approval: true });
  const jar = {};
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
  return { db, call, ok, tick: (ms) => { clock = new Date(clock.getTime() + ms); }, now: () => clock };
}

const SHOP = { shopName: 'كوفي النخلة', ownerName: 'حسين', email: 'hussein@nakhla.iq', password: 'nakhla-2026!', pin: '1357', seed: true };
const BOSS = { shopName: 'مقهى المزوّد', ownerName: 'المزوّد', email: 'boss@morecash.iq', password: 'provider-2026!', pin: '2468', seed: true };
const errOf = async (p) => (await p).body.error;

test('addMonths: نهاية الشهر لا تقفز للشهر الذي بعده', () => {
  assert.equal(addMonths(new Date('2026-01-31T10:00:00Z'), 1).toISOString(), '2026-02-28T10:00:00.000Z');
  assert.equal(addMonths(new Date('2026-10-14T09:00:00Z'), 12).toISOString(), '2027-10-14T09:00:00.000Z');
});

test('دورة الاشتراك كاملة: مغلق حتى الموافقة، طلب تحويل بوصل، موافقة شهر، تمديد، انتهاء للقراءة فقط، وتجديد', async () => {
  const { ok, call, tick, db } = await setup();
  // المزوّد: حسابه مفتوح دائماً، ويضبط بيانات التحويل والسعر
  await ok('boss', 'POST', '/api/account/signup', BOSS);
  assert.equal((await ok('boss', 'GET', '/api/state')).shop.subscription.status, 'active');
  await ok('boss', 'GET', '/api/pos/bootstrap');
  await ok('admin', 'POST', '/api/platform/login', { email: BOSS.email, password: BOSS.password });
  const cfg = await ok('admin', 'PUT', '/api/platform/config', { price: '25,000 د.ع شهرياً', details: 'كل الخواص مع الدعم', whatsapp: '0770 123 4567',
    methods: [{ label: 'زين كاش', value: '07701234567', holder: 'حسين علي' }, { label: 'كي كارد', value: '1234-5678' }] });
  assert.equal(cfg.methods.length, 2);
  assert.equal(cfg.whatsapp, '07701234567');

  // العميل يسجّل: بانتظار الموافقة، لا بيع ولا قراءة ولا شاشة حضور
  const r = await ok('shop', 'POST', '/api/account/signup', SHOP);
  assert.equal(r.shop.subscription.status, 'pending');
  for (const [m, path] of [['GET', '/api/pos/bootstrap'], ['GET', '/api/admin/reports/daily'], ['GET', '/api/hr/kiosk'], ['POST', '/api/sales'], ['POST', '/api/auth/pin']]) {
    assert.equal(await errOf(call('shop', m, path, {})), 'SUBSCRIPTION_PENDING', `${m} ${path}`);
  }
  // صفحة الاشتراك تعرض بيانات التحويل التي ضبطها المزوّد
  const page = await ok('shop', 'GET', '/api/subscription');
  assert.equal(page.status, 'pending');
  assert.equal(page.config.price, '25,000 د.ع شهرياً');
  assert.equal(page.config.methods[0].value, '07701234567');
  // طلب تحويل: رقم الحوالة أو الوصل إلزامي، والإرسال من جديد يحدّث الطلب ولا يكرره
  assert.equal(await errOf(call('shop', 'POST', '/api/subscription/request', { method: 'transfer', phone: '07709998877' })), 'REQUIRED');
  assert.equal(await errOf(call('shop', 'POST', '/api/subscription/request', { method: 'transfer', phone: 'abc' })), 'REQUIRED');
  await ok('shop', 'POST', '/api/subscription/request', { method: 'transfer', phone: '07709998877', reference: 'ZC-1' });
  const img = Buffer.alloc(2000, 9).toString('base64');
  await ok('shop', 'POST', '/api/subscription/request', { method: 'transfer', phone: '07709998877', reference: 'ZC-778899', image: img, mediaType: 'image/jpeg', note: 'حولت الصبح' });
  assert.equal(await errOf(call('shop', 'POST', '/api/subscription/request', { method: 'transfer', phone: '07709998877', image: 'x'.repeat(700_000) })), 'IMAGE_TOO_LARGE');

  // المزوّد يرى طلباً واحداً، بلا الصورة في القائمة، ويفتح الوصل
  assert.equal((await call('nobody', 'GET', '/api/platform/requests')).status, 401, 'اللوحة للمزوّد فقط');
  const reqs = await ok('admin', 'GET', '/api/platform/requests');
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].reference, 'ZC-778899');
  assert.equal(reqs[0].shopName, 'كوفي النخلة');
  assert.equal(JSON.stringify(reqs).includes(img), false);
  assert.equal((await ok('admin', 'GET', `/api/platform/requests/${reqs[0].id}/image`)).image, img);
  const shops = await ok('admin', 'GET', '/api/platform/shops');
  assert.equal(shops.totals.pending, 1);
  assert.equal(shops.totals.requests, 1);
  assert.equal(shops.rows.find((x) => x.name === 'كوفي النخلة').pendingRequest, true);

  // الرفض يحتاج سبباً؛ الموافقة بشهر تفتح كل شيء فوراً
  assert.equal(await errOf(call('admin', 'POST', `/api/platform/requests/${reqs[0].id}/reject`, {})), 'REQUIRED');
  assert.equal(await errOf(call('admin', 'POST', `/api/platform/requests/${reqs[0].id}/approve`, { months: 0 })), 'INVALID_RANGE');
  const ap = await ok('admin', 'POST', `/api/platform/requests/${reqs[0].id}/approve`, { months: 1, note: 'وصل سليم' });
  assert.equal(new Date(ap.until).toISOString(), '2026-11-14T09:00:00.000Z');
  assert.equal(await errOf(call('admin', 'POST', `/api/platform/requests/${reqs[0].id}/approve`, { months: 1 })), 'ALREADY_DECIDED');
  const st = (await ok('shop', 'GET', '/api/state')).shop.subscription;
  assert.equal(st.status, 'active');
  assert.equal(st.daysLeft, 31);
  await ok('shop', 'POST', '/api/auth/pin', { pin: '1357' });
  await ok('shop', 'GET', '/api/pos/bootstrap');
  await ok('shop', 'POST', '/api/shifts/open', { startingCash: 0 });
  assert.equal((await ok('shop', 'GET', '/api/subscription')).requests[0].status, 'approved');

  // التمديد قبل الانتهاء يُضاف لنهاية الاشتراك لا لليوم
  tick(10 * 86400_000);
  await ok('admin', 'POST', '/api/platform/login', { email: BOSS.email, password: BOSS.password }); // جلسة المزوّد 4 ساعات
  const tenantId = shops.rows.find((x) => x.name === 'كوفي النخلة').id;
  const ex = await ok('admin', 'POST', `/api/platform/shops/${tenantId}/subscription`, { months: 1, method: 'cash', note: 'استلمت نقداً' });
  assert.equal(new Date(ex.until).toISOString(), '2026-12-14T09:00:00.000Z');

  // الانتهاء: القراءة ودخول الموظف مسموحان، والبيع وفتح الوردية والتعديل موقوفة
  tick(62 * 86400_000);
  assert.equal((await ok('shop', 'GET', '/api/state')).shop.subscription.status, 'expired');
  await ok('shop', 'POST', '/api/auth/pin', { pin: '1357' });
  await ok('shop', 'GET', '/api/admin/reports/daily', null, { date: '2026-12-20' });
  assert.equal(await errOf(call('shop', 'POST', '/api/shifts/close', { actualCash: 0 })), 'SUBSCRIPTION_EXPIRED');
  assert.equal(await errOf(call('shop', 'POST', '/api/hr/kiosk/clock', {})), 'SUBSCRIPTION_EXPIRED');
  // طلب التجديد نقداً، والموافقة تبدأ من اليوم (لا من التاريخ المنتهي)
  await ok('shop', 'POST', '/api/subscription/request', { method: 'cash', phone: '07709998877', note: 'أسلمك الأسبوع الجاي' });
  await ok('admin', 'POST', '/api/platform/login', { email: BOSS.email, password: BOSS.password });
  const renew = (await ok('admin', 'GET', '/api/platform/requests')).find((x) => x.method === 'cash');
  const ap2 = await ok('admin', 'POST', `/api/platform/requests/${renew.id}/approve`, { months: 1 });
  assert.equal(new Date(ap2.until).toISOString(), addMonths(new Date('2026-10-14T09:00:00Z').getTime() + 72 * 86400_000, 1).toISOString());
  await ok('shop', 'POST', '/api/shifts/close', { actualCash: 0 });

  // الإيقاف الفوري، والسجل يحفظ كل شيء
  tick(60_000);
  await ok('admin', 'POST', `/api/platform/shops/${tenantId}/subscription`, { action: 'stop', note: 'طلب العميل' });
  assert.equal((await ok('shop', 'GET', '/api/state')).shop.subscription.status, 'expired');
  const log = await ok('admin', 'GET', '/api/platform/audit');
  assert.deepEqual(log.map((x) => x.action).sort(), ['config.update', 'request.approve', 'request.approve', 'subscription.extend', 'subscription.stop']);
  assert.equal(log[0].action, 'subscription.stop', 'الأحدث أولاً');

  // النسخة الاحتياطية: بيانات المقهى بلا أسرار ولا بيانات مقاهٍ أخرى
  const bk = await ok('admin', 'GET', `/api/platform/shops/${tenantId}/backup`);
  assert.equal(bk.format, 'morecash-backup');
  assert.ok(bk.data.items.length > 10);
  assert.ok(bk.data.shifts.length >= 1);
  const text = JSON.stringify(bk);
  assert.equal(text.includes('pinLookup'), false);
  assert.equal(text.includes('"secret"'), false);
  assert.equal(text.includes('مقهى المزوّد'), false, 'لا بيانات من مقهى آخر');
  assert.equal((await db.collection('platform_audit').find({ action: 'backup.download' }).toArray()).length, 1);
});

test('تجربة مجانية من لوحة المزوّد بلا طلب، والفروع تتبع اشتراك المالك', async () => {
  const { ok, call, tick } = await setup();
  await ok('boss', 'POST', '/api/account/signup', BOSS);
  await ok('admin', 'POST', '/api/platform/login', { email: BOSS.email, password: BOSS.password });
  await ok('shop', 'POST', '/api/account/signup', SHOP);
  const tenantId = (await ok('admin', 'GET', '/api/platform/shops')).rows.find((x) => x.name === 'كوفي النخلة').id;
  await ok('admin', 'POST', `/api/platform/shops/${tenantId}/subscription`, { days: 30, method: 'free', note: 'تجربة الكوفي' });
  const st = (await ok('shop', 'GET', '/api/state')).shop.subscription;
  assert.equal(st.status, 'trial');
  assert.equal(st.free, true);
  await ok('shop', 'POST', '/api/auth/pin', { pin: '1357' });
  // فرع جديد للمالك يعمل باشتراكه نفسه
  const br = await ok('shop', 'POST', '/api/account/branches', { name: 'فرع الكرادة', pin: '1357' });
  assert.ok(br);
  tick(31 * 86400_000);
  assert.equal(await errOf(call('shop', 'POST', '/api/account/branches', { name: 'فرع ثاني', pin: '1357' })), 'SUBSCRIPTION_EXPIRED');
});
