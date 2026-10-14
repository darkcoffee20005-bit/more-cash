// تشغيل الخادم الحقيقي على منفذ محلي: ملفات الواجهة، الكوكي، حماية CSRF، وحدود الطلب.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 39000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), 'mc-'));
const proc = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_FILE: join(dir, 'db.json'), MONGODB_URI: '' }, stdio: 'pipe' });
await new Promise((resolve, reject) => {
  proc.stdout.on('data', (d) => { if (String(d).includes('يعمل')) resolve(); });
  proc.on('exit', (c) => reject(new Error(`exit ${c}`)));
  setTimeout(() => reject(new Error('timeout')), 8000);
});
test.after(async () => { await new Promise((r) => { proc.once('exit', r); proc.kill(); }); rmSync(dir, { recursive: true, force: true }); });

const json = (method, path, body, headers = {}) => fetch(base + path, {
  method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'morecash', ...headers }, body: body ? JSON.stringify(body) : undefined,
});

test('الواجهة والوحدات المشتركة تُخدم مع ترويسات الأمان', async () => {
  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(index.headers.get('x-frame-options'), 'DENY');
  assert.match(await index.text(), /مور كاش/);
  assert.equal((await fetch(`${base}/shared/calc.js`)).status, 200);
  assert.equal((await fetch(`${base}/js/views/pos.js`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await fetch(`${base}/..%2fserver%2fapp%2fcore.js`)).status !== 200, true, 'لا خروج من مجلد الواجهة');
  assert.equal((await fetch(`${base}/shared/..%2f..%2fpackage.json`)).status !== 200, true);
  assert.equal((await fetch(`${base}/admin/items`)).status, 200, 'مسارات التطبيق تعيد الصفحة');
});

test('إنشاء حساب، كوكي الجهاز والموظف، وحماية CSRF', async () => {
  const signupBody = { shopName: 'مقهى', ownerName: 'أحمد', email: 'owner@cafe.iq', password: 'qahwa-2026!', pin: '1357', seed: true };
  assert.equal((await fetch(`${base}/api/account/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403, 'بلا ترويسة مخصصة');
  assert.equal((await fetch(`${base}/api/account/signup`, { method: 'POST', headers: { 'X-Requested-With': 'morecash', 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await json('POST', '/api/account/signup', { x: 'a'.repeat(300 * 1024) })).status, 413);
  const signup = await json('POST', '/api/account/signup', signupBody);
  assert.equal(signup.status, 200);
  const cookies = signup.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  assert.match(cookies.find((c) => c.startsWith('mc_device=')), /^mc_device=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=7776000$/);
  assert.match(cookies.find((c) => c.startsWith('mc_session=')), /^mc_session=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200$/);
  const jar = cookies.map((c) => c.split(';')[0]).join('; ');
  const device = cookies.find((c) => c.startsWith('mc_device=')).split(';')[0];

  const boot = await fetch(`${base}/api/pos/bootstrap`, { headers: { cookie: jar } });
  assert.equal(boot.status, 200);
  assert.equal(boot.headers.get('cache-control'), 'no-store');
  assert.ok((await boot.json()).catalog.items.length > 10);
  assert.equal((await fetch(`${base}/api/pos/bootstrap`)).status, 401, 'بلا جهاز مرتبط');
  assert.equal((await fetch(`${base}/api/pos/bootstrap`, { headers: { cookie: device } })).status, 401, 'الجهاز وحده لا يكفي: يلزم رمز موظف');

  const out = await json('POST', '/api/auth/logout', {}, { cookie: jar });
  assert.match(out.headers.get('set-cookie'), /mc_session=; .*Max-Age=0/);
  assert.equal((await fetch(`${base}/api/pos/bootstrap`, { headers: { cookie: jar } })).status, 401, 'الجلسة أُلغيت على الخادم');
  const state = await (await fetch(`${base}/api/state`, { headers: { cookie: device } })).json();
  assert.equal(state.shop.name, 'مقهى');
  const pin = await json('POST', '/api/auth/pin', { pin: '1357' }, { cookie: device });
  assert.equal(pin.status, 200);

  const leave = await json('POST', '/api/account/logout', {}, { cookie: device });
  assert.equal(leave.headers.getSetCookie().length, 2);
  assert.equal((await (await fetch(`${base}/api/state`, { headers: { cookie: device } })).json()).shop, null);
});
