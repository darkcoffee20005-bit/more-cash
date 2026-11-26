// الموقع التعريفي: طلب «احجز عرضك» من الزائر، ومتابعة المزوّد، ومحتوى «يثقون بنا» وآراء العملاء.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDb } from '../server/db/memory.js';
import { ensureIndexes } from '../server/db/indexes.js';
import { createPlatform } from '../server/app/platform.js';

async function setup() {
  const db = new MemoryDb({ newId: () => crypto.randomUUID() });
  await ensureIndexes(db);
  const p = createPlatform({ db, passwordIterations: 1000, admins: ['boss@cafe.iq'], support: '9647700000000', log: { error() {}, warn() {}, info() {} } });
  const jar = {};
  const call = async (dev, method, path, body, query) => {
    const c = (jar[dev] ??= {});
    const r = await p.handle({ method, path, body, query, token: c.token ?? null, deviceToken: c.deviceToken ?? null, platformToken: c.platformToken ?? null, ip: dev });
    if (r.setToken !== undefined) c.token = r.setToken;
    if (r.setPlatform !== undefined) c.platformToken = r.setPlatform;
    if (r.setDevice !== undefined) c.deviceToken = r.setDevice;
    return r;
  };
  return { db, call };
}
const LEAD = { name: 'علي', shop: 'كوفي الكرادة', type: 'cafe', branches: 2, phone: '٠٧٧٠ ١٢٣ ٤٥٦٧', city: 'بغداد', note: 'نريد عرض يوم السبت' };

test('طلب عرض: يُحفظ مرة واحدة، والرقم يُطبَّع، والروبوت لا يُحفظ', async () => {
  const { db, call } = await setup();
  const id = crypto.randomUUID();
  assert.equal((await call('v1', 'POST', '/api/leads', { ...LEAD, clientId: id })).status, 200);
  assert.equal((await call('v1', 'POST', '/api/leads', { ...LEAD, clientId: id })).status, 200, 'إعادة الإرسال آمنة');
  const rows = await db.collection('leads').find({}).toArray();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].phone, '07701234567');
  assert.equal((await call('v1', 'POST', '/api/leads', { ...LEAD, phone: '12', clientId: crypto.randomUUID() })).body.error, 'INVALID_PHONE');
  assert.equal((await call('v1', 'POST', '/api/leads', { ...LEAD, shop: '', clientId: crypto.randomUUID() })).body.error, 'REQUIRED');
  await call('v1', 'POST', '/api/leads', { ...LEAD, website: 'spam.example', clientId: crypto.randomUUID() });
  assert.equal(await db.collection('leads').countDocuments({}), 1, 'فخ الروبوت');
});

test('حد الطلبات لكل عنوان', async () => {
  const { call } = await setup();
  for (let i = 0; i < 5; i++) assert.equal((await call('spam', 'POST', '/api/leads', { ...LEAD, clientId: crypto.randomUUID() })).status, 200);
  assert.equal((await call('spam', 'POST', '/api/leads', { ...LEAD, clientId: crypto.randomUUID() })).body.error, 'TOO_MANY_ATTEMPTS');
  assert.equal((await call('other', 'POST', '/api/leads', { ...LEAD, clientId: crypto.randomUUID() })).status, 200);
});

test('المزوّد يتابع الطلبات ويحرر محتوى الموقع، والزائر يقرؤه', async () => {
  const { call } = await setup();
  await call('v', 'POST', '/api/leads', { ...LEAD, clientId: 'lead-1' });
  assert.equal((await call('x', 'GET', '/api/platform/leads')).status, 401, 'بلا دخول المزوّد');
  await call('a', 'POST', '/api/account/signup', { shopName: 'مقهى المزوّد', ownerName: 'يوسف', email: 'boss@cafe.iq', password: 'qahwa-2026!', pin: '1357' });
  assert.equal((await call('a', 'POST', '/api/platform/login', { email: 'boss@cafe.iq', password: 'qahwa-2026!' })).status, 200);
  const l = (await call('a', 'GET', '/api/platform/leads')).body;
  assert.equal(l.counts.new, 1);
  assert.equal(l.leads[0].typeName, 'كافيه / كوفي شوب');
  assert.equal(l.leads[0].ip, undefined, 'العنوان لا يُعرض');
  const u = await call('a', 'POST', '/api/platform/leads/lead-1', { status: 'contacted', adminNote: 'موعد الأحد' });
  assert.equal(u.body.status, 'contacted');
  assert.equal((await call('a', 'POST', '/api/platform/leads/lead-1', { status: 'maybe' })).body.error, 'INVALID_CHOICE');

  assert.deepEqual((await call('v', 'GET', '/api/site')).body, { whatsapp: '9647700000000', trusted: [], testimonials: [], plans: { month: 50000, year: 500000 } });
  await call('a', 'PUT', '/api/platform/site', { trusted: [{ name: 'كوفي النخلة', city: 'البصرة' }], testimonials: [{ name: 'سارة', shop: 'كوفي النخلة', quote: 'الدرج صار يطابق كل يوم.' }] });
  const site = (await call('v', 'GET', '/api/site')).body;
  assert.equal(site.trusted[0].name, 'كوفي النخلة');
  assert.equal(site.testimonials[0].quote, 'الدرج صار يطابق كل يوم.');
});

test('الأسعار وواتساب موحّدة بين الموقع وصفحة الاشتراك، وربط طلب العرض بمقهى العميل', async () => {
  const { call } = await setup();
  await call('a', 'POST', '/api/account/signup', { shopName: 'مقهى المزوّد', ownerName: 'يوسف', email: 'boss@cafe.iq', password: 'qahwa-2026!', pin: '1357' });
  await call('a', 'POST', '/api/platform/login', { email: 'boss@cafe.iq', password: 'qahwa-2026!' });
  const cfg = (await call('a', 'PUT', '/api/platform/config', { price: '', details: 'كل شي مشمول', methods: [], whatsapp: '9647711111111', plans: { month: 60000, year: 600000 } })).body;
  assert.deepEqual(cfg.plans, { month: 60000, year: 600000 });
  const site = (await call('v', 'GET', '/api/site')).body;
  assert.deepEqual(site.plans, { month: 60000, year: 600000 }, 'الموقع يقرأ سعر لوحة المزوّد');
  assert.equal(site.whatsapp, '9647711111111', 'واتساب اللوحة يتقدّم على متغير البيئة');
  assert.equal((await call('v', 'GET', '/api/support')).body.whatsapp, '9647711111111');
  assert.equal((await call('a', 'PUT', '/api/platform/config', { methods: [], plans: { month: 5, year: 600000 } })).body.error, 'INVALID_NUMBER');
  // حفظ بلا أسعار يبقي الأسعار السابقة
  assert.deepEqual((await call('a', 'PUT', '/api/platform/config', { methods: [], details: 'x' })).body.plans, { month: 60000, year: 600000 });

  // عميل جديد من الموقع يشترك: نربط طلبه بمقهاه
  await call('v', 'POST', '/api/leads', { ...LEAD, clientId: 'lead-9' });
  await call('c', 'POST', '/api/account/signup', { shopName: 'كوفي الرصافة', ownerName: 'علي', email: 'ali@rusafa.iq', password: 'rusafa-2026!', pin: '2468' });
  const shop = (await call('a', 'GET', '/api/platform/shops')).body.rows.find((r) => r.name === 'كوفي الرصافة');
  const linked = (await call('a', 'POST', '/api/platform/leads/lead-9', { tenantId: shop.id, adminNote: 'اشترك سنوي' })).body;
  assert.equal(linked.status, 'won', 'الربط بمقهى يعني اشترك');
  assert.equal((await call('a', 'GET', '/api/platform/leads')).body.leads.find((l) => l.id === 'lead-9').shopName, 'كوفي الرصافة');
  assert.equal((await call('a', 'POST', '/api/platform/leads/lead-9', { tenantId: 'no-such-shop' })).status, 404);
  assert.equal((await call('a', 'POST', '/api/platform/leads/lead-9', { tenantId: null })).body.tenantId, null, 'فك الربط');
});
