// خريطة الطاولات (التذكرة تُحفظ على طاولة، ولا تذكرتان على طاولة واحدة) وشاشة الحضور المشتركة على جهاز الكاشير.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MemoryDb } from '../server/db/memory.js';
import { ensureIndexes } from '../server/db/indexes.js';
import { createApp } from '../server/app/index.js';

async function boot() {
  const db = new MemoryDb({ newId: randomUUID });
  await ensureIndexes(db);
  let clock = new Date('2026-10-14T05:00:00Z'); // 8:00 صباحاً بتوقيت بغداد
  const app = createApp({ db, now: () => clock, log: { error: (e) => process.env.DEBUG_LOG && console.error(e), warn() {}, info() {} } });
  const tokens = {};
  const call = async (who, method, path, body, query, ip = who) => {
    const r = await app.handle({ method, path, body, query, token: tokens[who] ?? null, ip });
    if (r.setToken !== undefined) tokens[who] = r.setToken;
    return r;
  };
  const ok = async (who, method, path, body, query, ip) => {
    const r = await call(who, method, path, body, query, ip);
    assert.equal(r.status, 200, `${method} ${path} → ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  assert.equal((await call('owner', 'POST', '/api/setup', { storeName: 'مقهى الزيتون', ownerName: 'أحمد', pin: '1357', seed: true })).status, 200);
  await ok('owner', 'POST', '/api/auth/pin', { pin: '1357' });
  return { call, ok, db, tick: (ms) => { clock = new Date(clock.getTime() + ms); } };
}
const errOf = async (p) => (await p).body.error;
const T = (id, name, x, y, extra = {}) => ({ id, kind: 'table', name, shape: 'rect', x, y, w: 120, h: 90, seats: 4, ...extra });

test('خريطة الطاولات: يرسمها المدير، والتذكرة تُحفظ على طاولة باسمها، والطاولة المشغولة لا تُحجز مرتين، وتتحرر بالبيع', async () => {
  const { ok, call } = await boot();
  await ok('owner', 'POST', '/api/admin/employees', { name: 'سارة', role: 'cashier', pin: '2468' });
  await ok('owner', 'POST', '/api/admin/employees', { name: 'زينب', role: 'manager', pin: '2580' });
  await ok('sara', 'POST', '/api/auth/pin', { pin: '2468' });
  await ok('mgr', 'POST', '/api/auth/pin', { pin: '2580' });
  const tables = [T('t1', 'طاولة 1', 40, 40), T('t2', 'طاولة 2', 200, 40, { shape: 'round', w: 100, h: 100 }), { id: 'bar', kind: 'zone', name: 'البار', shape: 'rect', x: 0, y: 500, w: 400, h: 80 }];
  assert.equal((await call('sara', 'PUT', '/api/admin/floor', { tables })).status, 403, 'الكاشير لا يعدّل الخريطة');
  assert.equal(await errOf(call('mgr', 'PUT', '/api/admin/floor', { tables: [T('t1', 'أ', 950, 0)] })), 'INVALID_NUMBER', 'خارج اللوحة');
  assert.equal(await errOf(call('mgr', 'PUT', '/api/admin/floor', { tables: [T('t1', 'أ', 0, 0), T('t2', 'أ', 300, 0)] })), 'NAME_IN_USE');
  await ok('mgr', 'PUT', '/api/admin/floor', { tables });
  const { settings, catalog } = await ok('sara', 'GET', '/api/pos/bootstrap');
  assert.equal(settings.floor.tables.length, 3, 'الكاشير يستلم الخريطة مع الإعدادات');

  const water = catalog.items.find((i) => i.name === 'ماء').variants[0];
  const lines = [{ variantId: water.id, qty: 1, modifierOptionIds: [] }];
  const t = await ok('sara', 'POST', '/api/tickets', { name: 'أي اسم', tableId: 't1', lines, displayTotal: 500 });
  assert.equal(t.name, 'طاولة 1', 'اسم التذكرة = اسم الطاولة');
  assert.equal(t.tableId, 't1');
  assert.equal(await errOf(call('sara', 'POST', '/api/tickets', { name: 'x', tableId: 't1', lines })), 'TABLE_TAKEN');
  assert.equal(await errOf(call('sara', 'POST', '/api/tickets', { name: 'x', tableId: 'bar', lines })), 'UNKNOWN_TABLE', 'المنطقة ليست طاولة');
  // تحديث التذكرة على نفس الطاولة مسموح، ونقلها لطاولة أخرى يحرر الأولى
  const moved = await ok('sara', 'POST', '/api/tickets', { id: t.id, version: t.version, name: 'x', tableId: 't2', lines });
  assert.equal(moved.name, 'طاولة 2');
  await ok('sara', 'POST', '/api/tickets', { name: 'x', tableId: 't1', lines, displayTotal: 500 });
  // تذكرة بلا طاولة لا تتعارض مع غيرها
  await ok('sara', 'POST', '/api/tickets', { name: 'سفري — علي', lines });
  await ok('sara', 'POST', '/api/tickets', { name: 'سفري — نور', lines });
  // بيع التذكرة يحذفها فتتحرر الطاولة
  await ok('owner', 'POST', '/api/shifts/open', { startingCash: 0 });
  const list = await ok('sara', 'GET', '/api/tickets');
  const t2 = list.find((x) => x.tableId === 't2');
  await ok('sara', 'POST', '/api/sales', { clientId: randomUUID(), diningOption: 'dine_in', ticketId: t2.id, ticketName: t2.name, lines: t2.lines, clientTotal: 500, payments: [{ typeId: 'cash', amount: 500 }] });
  await ok('sara', 'POST', '/api/tickets', { name: 'x', tableId: 't2', lines });
});

test('شاشة الحضور المشتركة: بلا جلسة، اسم + رمز، تبديل حضور/انصراف، لا تكرار، قفل المحاولات، والحضور المنسي يُغلق للمراجعة', async () => {
  const { ok, call, tick, db } = await boot();
  const sara = await ok('owner', 'POST', '/api/admin/employees', { name: 'سارة', role: 'cashier', pin: '2468', salary: 600000 });
  const ali = await ok('owner', 'POST', '/api/admin/employees', { name: 'علي', role: 'barista', pin: '1122' });
  // القائمة بلا جلسة وبلا رواتب
  const list = await ok('kiosk', 'GET', '/api/hr/kiosk');
  assert.ok(list.some((e) => e.id === sara.id && e.clockedIn === null));
  assert.equal(JSON.stringify(list).includes('600000'), false, 'لا رواتب في شاشة الحضور');
  // رمز موظف آخر لا يسجّل لسارة
  assert.equal(await errOf(call('kiosk', 'POST', '/api/hr/kiosk/clock', { clientId: randomUUID(), employeeId: sara.id, pin: '1122' })), 'WRONG_PIN');
  const body = { clientId: randomUUID(), employeeId: sara.id, pin: '2468' };
  const r1 = await ok('kiosk', 'POST', '/api/hr/kiosk/clock', body);
  assert.equal(r1.action, 'in');
  assert.equal(r1.name, 'سارة');
  assert.equal((await ok('kiosk', 'POST', '/api/hr/kiosk/clock', body)).duplicate, true, 'إعادة الإرسال لا تكرر');
  assert.equal(await errOf(call('kiosk', 'GET', '/api/hr/record/me')), 'NOT_AUTHENTICATED', 'شاشة الحضور لا تفتح جلسة');
  tick(8 * 3600_000);
  const r2 = await ok('kiosk', 'POST', '/api/hr/kiosk/clock', { clientId: randomUUID(), employeeId: sara.id, pin: '2468' });
  assert.equal(r2.action, 'out');
  assert.equal(r2.attendance.minutes, 480);
  // علي نسي الانصراف أمس: حضوره المنسي يُغلق بلا ساعات ويُعلَّم، ثم يُسجَّل حضور جديد
  await ok('kiosk', 'POST', '/api/hr/kiosk/clock', { clientId: randomUUID(), employeeId: ali.id, pin: '1122' });
  tick(20 * 3600_000);
  const r3 = await ok('kiosk', 'POST', '/api/hr/kiosk/clock', { clientId: randomUUID(), employeeId: ali.id, pin: '1122' });
  assert.equal(r3.action, 'in');
  assert.equal(r3.autoClosed, true);
  const old = (await db.collection('attendance').find({ employeeId: ali.id }).toArray()).find((a) => a.fixed);
  assert.equal(old.open, false);
  assert.equal(new Date(old.outAt).getTime(), new Date(old.inAt).getTime(), 'بلا ساعات حتى يصححه المدير');
  // قفل بعد محاولات خاطئة متتالية من نفس الجهاز
  let locked = false;
  for (let i = 0; i < 8 && !locked; i++) locked = (await call('kiosk', 'POST', '/api/hr/kiosk/clock', { clientId: randomUUID(), employeeId: sara.id, pin: '9999' }, null, 'bad-ip')).body.error === 'TOO_MANY_ATTEMPTS';
  assert.ok(locked, 'المحاولات الخاطئة تُقفل');
});
