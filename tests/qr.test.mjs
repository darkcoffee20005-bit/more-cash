// «اطلب من الطاولة»: رمز سري لكل طاولة، الطلب من شبكة المقهى فقط، قرار الكاشير (قبول/رفض/حظر)،
// والطلب المقبول يدخل تذكرة الطاولة وشاشة التحضير مرة واحدة فقط (لا يتكرر عند الدفع).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDb } from '../server/db/memory.js';
import { ensureIndexes } from '../server/db/indexes.js';
import { createPlatform } from '../server/app/platform.js';
import { ipKey } from '../server/app/qr-links.js';

const CAFE = '203.0.113.5';
const HOME = '198.51.100.7';

test('مفتاح الشبكة: IPv4 كما هو، وIPv6 بأول 64 بت', () => {
  assert.equal(ipKey('203.0.113.5'), '203.0.113.5');
  assert.equal(ipKey('::ffff:203.0.113.5'), '203.0.113.5');
  assert.equal(ipKey('2001:db8:aa:1:1111:2222:3333:4444'), ipKey('2001:0db8:00aa:0001::9'), 'نفس الشبكة، جهاز آخر');
  assert.notEqual(ipKey('2001:db8:aa:1::1'), ipKey('2001:db8:aa:2::1'));
  assert.equal(ipKey(''), null);
});

async function setup() {
  const db = new MemoryDb({ newId: () => crypto.randomUUID() });
  await ensureIndexes(db);
  const p = createPlatform({ db, passwordIterations: 1000, log: { error: console.error, warn() {}, info() {} } });
  const jar = {};
  const call = async (dev, method, path, body, query, ip = CAFE) => {
    const c = (jar[dev] ??= {});
    const r = await p.handle({ method, path, body, query, token: c.token ?? null, deviceToken: c.deviceToken ?? null, ip });
    if (r.setToken !== undefined) c.token = r.setToken;
    if (r.setDevice !== undefined) c.deviceToken = r.setDevice;
    return r;
  };
  const ok = async (...a) => { const r = await call(...a); assert.equal(r.status, 200, `${a[1]} ${a[2]} → ${r.status} ${JSON.stringify(r.body)}`); return r.body; };
  await ok('pos', 'POST', '/api/account/signup', { shopName: 'مقهى الزيتون', ownerName: 'أحمد', email: 'a@z.iq', password: 'qahwa-2026!', pin: '1357', seed: true });
  await ok('pos', 'PUT', '/api/admin/floor', { tables: [{ id: 't1', kind: 'table', name: 'طاولة 1', shape: 'rect', x: 10, y: 10, w: 100, h: 80, seats: 4 }, { id: 't2', kind: 'table', name: 'طاولة 2', shape: 'round', x: 200, y: 10, w: 90, h: 90, seats: 2 }] });
  return { db, call, ok };
}

test('الطلب من الطاولة: من الشبكة فقط، قبول للتذكرة والتحضير، دفع بلا تكرار، رفض وحظر وتغيير الرمز', async () => {
  const { db, call, ok } = await setup();
  const links = await ok('pos', 'GET', '/api/admin/qr-links');
  assert.equal(links.length, 2);
  const t1 = links.find((l) => l.tableId === 't1').token;
  const guest = (path, q = {}, ip = CAFE) => call('guest', 'GET', path, null, { t: t1, ...q }, ip);
  const order = (body, ip = CAFE) => call('guest', 'POST', '/api/qr/order', { t: t1, guestId: 'g-ali', clientId: crypto.randomUUID(), ...body }, null, ip);

  assert.equal((await guest('/api/qr/menu')).body.error, 'QR_DISABLED', 'الميزة مطفأة افتراضياً');
  await ok('pos', 'PUT', '/api/admin/settings', { features: { kds: true, openTickets: true, qr: true } });
  assert.equal((await guest('/api/qr/menu', {}, HOME)).body.error, 'QR_NOT_ON_NETWORK', 'من خارج المقهى');
  assert.equal((await call('guest', 'GET', '/api/qr/menu', null, { t: 'f'.repeat(36) })).body.error, 'QR_UNKNOWN_TABLE');
  const menu = (await guest('/api/qr/menu')).body;
  assert.equal(menu.table.name, 'طاولة 1');
  assert.equal(menu.items[0].variants[0].cost, undefined, 'لا تكاليف للزبون');
  const latte = menu.items.find((i) => i.name === 'لاتيه');
  const v = latte.variants[0];
  const groups = menu.modifiers.filter((m) => latte.modifierIds.includes(m.id));
  const req = groups.filter((m) => m.required).map((m) => m.options[0]);
  const opt = groups.find((m) => !m.required)?.options[0];
  const picks = [...req, ...(opt ? [opt] : [])];
  const extra = picks.reduce((a, o) => a + o.price, 0);

  // الطلب مسعّر من الخادم (سعر الجهاز يُتجاهل)
  const r1 = await order({ name: 'علي', lines: [{ variantId: v.id, qty: 2, modifierOptionIds: picks.map((o) => o.id), note: 'سكر قليل', unitPrice: 1 }] });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  const o1 = r1.body;
  assert.equal(o1.status, 'pending');
  assert.equal(o1.total, (v.price + extra) * 2);
  assert.equal((await order({ lines: [{ variantId: v.id, qty: 1 }] })).body.error, 'MODIFIER_REQUIRED', 'الإضافة الإلزامية');
  assert.equal((await order({ lines: [{ variantId: v.id, qty: 1 }] }, HOME)).body.error, 'QR_NOT_ON_NETWORK');
  assert.equal((await order({ lines: [{ variantId: v.id, qty: 50 }] })).body.error, 'INVALID_NUMBER', 'كمية غير معقولة');

  // الكاشير يقبل: تذكرة الطاولة + شاشة التحضير
  const pending = await ok('pos', 'GET', '/api/pos/qr');
  assert.equal(pending.length, 1);
  const acc = await ok('pos', 'POST', `/api/pos/qr/${o1.id}/accept`);
  assert.equal(acc.status, 'accepted');
  assert.equal((await call('pos', 'POST', `/api/pos/qr/${o1.id}/accept`)).body.error, 'QR_ALREADY_DECIDED', 'القرار مرة واحدة');
  const tickets = await ok('pos', 'GET', '/api/tickets');
  const ticket = tickets.find((t) => t.tableId === 't1');
  assert.equal(ticket.lines[0].sentQty, 2, 'السطر معلّم أنه بالمطبخ');
  let kds = await ok('pos', 'GET', '/api/kds');
  const k = kds.find((x) => x.qr);
  assert.equal(k.ticketName, 'طاولة 1');
  await ok('pos', 'POST', `/api/kds/${k.id}/advance`, { from: 'new', to: 'ready' });
  assert.equal((await guest('/api/qr/status', { g: 'g-ali' })).body[0].status, 'accepted', 'الزبون يرى القبول');

  // الدفع من التذكرة: لا يظهر الطلب في التحضير مرة ثانية
  await ok('pos', 'POST', '/api/shifts/open', { startingCash: 0 });
  const unit = v.price + extra;
  const sale = await ok('pos', 'POST', '/api/sales', { clientId: crypto.randomUUID(), ticketId: ticket.id, ticketName: ticket.name, diningOption: 'dine_in',
    lines: ticket.lines.map((l) => ({ variantId: l.variantId, qty: l.qty, modifierOptionIds: l.modifierOptionIds, note: l.note, sentQty: l.sentQty })),
    discountIds: [], clientTotal: unit * 2, payments: [{ typeId: 'cash', amount: unit * 2, tendered: unit * 2 }] });
  assert.equal(sale.receipt.prep?.status ?? 'served', 'served');
  kds = await ok('pos', 'GET', '/api/kds');
  assert.equal(kds.filter((x) => !x.qr && x.number === sale.receipt.number && x.prep.status !== 'served').length, 0, 'لا تكرار في التحضير');
  assert.equal((await ok('pos', 'GET', '/api/tickets')).filter((t) => t.tableId === 't1').length, 0, 'الطاولة تحررت');

  // رفض ثم حظر
  const L1 = [{ variantId: v.id, qty: 1, modifierOptionIds: req.map((o) => o.id) }];
  const o2 = (await order({ lines: L1 })).body;
  await ok('pos', 'POST', `/api/pos/qr/${o2.id}/reject`, { reason: 'خلص الحليب' });
  const o3 = (await order({ lines: L1 })).body;
  await ok('pos', 'POST', `/api/pos/qr/${o3.id}/block`);
  assert.equal((await order({ lines: L1 })).body.error, 'QR_BLOCKED');
  const st = (await guest('/api/qr/status', { g: 'g-ali' })).body;
  assert.ok(st.some((x) => x.status === 'rejected' && x.reason === 'خلص الحليب'));
  assert.equal((await ok('pos', 'GET', '/api/pos/qr-blocks')).length, 1);
  // زبون آخر من نفس الطاولة غير متأثر
  assert.equal((await call('guest', 'POST', '/api/qr/order', { t: t1, guestId: 'g-zahra', clientId: crypto.randomUUID(), lines: L1 })).status, 200);

  // رمز جديد: القديم يتوقف
  await ok('pos', 'POST', '/api/admin/qr-links/rotate', { tableId: 't1' });
  assert.equal((await guest('/api/qr/menu')).body.error, 'QR_UNKNOWN_TABLE');
  void db;
});
