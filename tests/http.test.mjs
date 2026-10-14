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

test('الإعداد والدخول بالكوكي وحماية CSRF', async () => {
  assert.equal((await fetch(`${base}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403, 'بلا ترويسة مخصصة');
  assert.equal((await fetch(`${base}/api/setup`, { method: 'POST', headers: { 'X-Requested-With': 'morecash', 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  const big = await json('POST', '/api/setup', { x: 'a'.repeat(300 * 1024) });
  assert.equal(big.status, 413);
  assert.equal((await json('POST', '/api/setup', { storeName: 'مقهى', ownerName: 'أحمد', pin: '1357', seed: true })).status, 200);
  const login = await json('POST', '/api/auth/pin', { pin: '1357' });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie');
  assert.match(cookie, /mc_session=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Strict/);
  const session = cookie.split(';')[0];
  const boot = await fetch(`${base}/api/pos/bootstrap`, { headers: { cookie: session } });
  assert.equal(boot.status, 200);
  assert.equal(boot.headers.get('cache-control'), 'no-store');
  assert.ok((await boot.json()).catalog.items.length > 10);
  assert.equal((await fetch(`${base}/api/pos/bootstrap`)).status, 401);
  const out = await json('POST', '/api/auth/logout', {}, { cookie: session });
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await fetch(`${base}/api/pos/bootstrap`, { headers: { cookie: session } })).status, 401, 'الجلسة أُلغيت على الخادم');
});
