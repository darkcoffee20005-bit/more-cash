// برنامج الولاء: مستويات بالصرف تزيد النقاط، نقاط ترحيب في الدفتر، والزبائن الغائبون.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MemoryDb } from '../server/db/memory.js';
import { ensureIndexes } from '../server/db/indexes.js';
import { createApp } from '../server/app/index.js';
import { tierOf, nextTier, earnPoints, DEFAULT_TIERS } from '../shared/loyalty.js';

test('حساب المستوى والنقاط (أعداد صحيحة)', () => {
  assert.equal(tierOf(0).id, 'bronze');
  assert.equal(tierOf(149_999).id, 'bronze');
  assert.equal(tierOf(150_000).id, 'silver');
  assert.equal(tierOf(2_000_000).id, 'gold');
  assert.deepEqual(nextTier(100_000), { tier: DEFAULT_TIERS[0], remaining: 50_000 });
  assert.equal(nextTier(600_000), null);
  const L = { enabled: true, rateBp: 500, tiers: DEFAULT_TIERS };
  assert.equal(earnPoints(10_000, L, 0), 500, 'برونزي: 5% من 10,000');
  assert.equal(earnPoints(10_000, L, 200_000), 625, 'فضي: 500 + 25%');
  assert.equal(earnPoints(10_000, L, 900_000), 750, 'ذهبي: 500 + 50%');
  assert.equal(earnPoints(10_000, { ...L, enabled: false }, 900_000), 0);
});

async function boot() {
  const db = new MemoryDb({ newId: randomUUID });
  await ensureIndexes(db);
  let clock = new Date('2026-10-14T07:00:00Z');
  const app = createApp({ db, now: () => clock, log: { error() {}, warn() {}, info() {} } });
  const tokens = {};
  const call = async (who, method, path, body, query) => {
    const r = await app.handle({ method, path, body, query, token: tokens[who] ?? null, ip: who });
    if (r.setToken !== undefined) tokens[who] = r.setToken;
    return r;
  };
  const ok = async (...a) => { const r = await call(...a); assert.equal(r.status, 200, `${a[1]} ${a[2]} → ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
  await ok('owner', 'POST', '/api/setup', { storeName: 'مقهى الزيتون', ownerName: 'أحمد', pin: '1357', seed: true });
  await ok('owner', 'POST', '/api/auth/pin', { pin: '1357' });
  return { db, call, ok, tick: (ms) => { clock = new Date(clock.getTime() + ms); } };
}

test('مستويات الولاء ونقاط الترحيب والغائبون عبر الخادم', async () => {
  const { db, call, ok, tick } = await boot();
  // إعدادات: نسبة 5%، ترحيب 1,000 نقطة، فضي من 20,000 (+20%)، الغياب 14 يوم
  assert.equal((await call('owner', 'PUT', '/api/admin/settings', { loyalty: { enabled: true, rateBp: 500, tiers: [{ id: 'silver', name: 'فضي', minSpent: 0, bonusBp: 1 }] } })).body.error, 'INVALID_NUMBER', 'حد المستوى لا يكون صفراً');
  await ok('owner', 'PUT', '/api/admin/settings', { loyalty: { enabled: true, rateBp: 500, welcomePoints: 1000, awayDays: 14, tiers: [{ id: 'silver', name: 'فضي', minSpent: 20_000, bonusBp: 2000 }] } });
  const c = await ok('owner', 'POST', '/api/customers', { name: 'علي', phone: '07701112222' });
  assert.equal(c.points, 1000, 'نقاط الترحيب');
  const moves = await db.collection('point_moves').find({ customerId: c.id }).toArray();
  assert.deepEqual(moves.map((m) => [m.key.split(':')[0], m.delta]), [['welcome', 1000]], 'الترحيب في الدفتر');

  await ok('owner', 'POST', '/api/shifts/open', { startingCash: 0 });
  const bs = await ok('owner', 'GET', '/api/pos/bootstrap');
  const v = bs.catalog.items.find((i) => i.name === 'ماء').variants[0];
  const sell = async (qty) => ok('owner', 'POST', '/api/sales', { clientId: randomUUID(), customerId: c.id, lines: [{ variantId: v.id, qty, modifierOptionIds: [] }], discountIds: [], diningOption: 'takeaway', clientTotal: v.price * qty, payments: [{ typeId: 'cash', amount: v.price * qty, tendered: v.price * qty }] });
  const qty = Math.ceil(20_000 / v.price);
  const first = await sell(qty); // برونزي: 5% فقط
  assert.equal(first.receipt.pointsEarned, Math.round(v.price * qty * 0.05));
  const second = await sell(2); // صار فضي: 5% + 20%
  const base = Math.round(v.price * 2 * 0.05);
  assert.equal(second.receipt.pointsEarned, base + Math.round(base * 0.2), 'زيادة المستوى الفضي');
  const fresh = await ok('owner', 'GET', `/api/customers/${c.id}`);
  assert.equal(fresh.points, 1000 + first.receipt.pointsEarned + second.receipt.pointsEarned, 'الرصيد = الدفتر');

  assert.equal((await ok('owner', 'GET', '/api/customers', null, { away: '1' })).length, 0, 'زار اليوم');
  tick(15 * 86400_000);
  await ok('owner', 'POST', '/api/auth/pin', { pin: '1357' });
  const away = await ok('owner', 'GET', '/api/customers', null, { away: '1' });
  assert.deepEqual(away.map((x) => x.name), ['علي'], 'غائب بعد 15 يوم');
});
