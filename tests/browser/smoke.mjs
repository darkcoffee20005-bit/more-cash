// فحص في متصفح حقيقي (Chromium عبر Playwright): يشغّل الخادم، ينفّذ دورة بيع كاملة بالنقر، ويلتقط صوراً.
// التشغيل: node tests/browser/smoke.mjs [مجلد_الصور]   (يتطلب playwright مثبتاً)
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch { playwright = require('/opt/npm-tools/node_modules/playwright'); }

const shots = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? join(tmpdir(), 'mc-shots');
mkdirSync(shots, { recursive: true });
const PORT = 40500 + Math.floor(Math.random() * 400);
const dir = mkdtempSync(join(tmpdir(), 'mcb-'));
// --vercel: يختبر نسخة النشر على Vercel (out/ + api/index.js) بدل خادم Node
const VERCEL = process.argv.includes('--vercel');
const server = spawn(process.execPath, [VERCEL ? 'scripts/vercel_dev.mjs' : 'server/index.js'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_FILE: join(dir, 'db.json'), MONGODB_URI: '', MORECASH_ALLOW_MEMORY: '1' }, stdio: 'pipe' });
await new Promise((r, j) => { server.stdout.on('data', (d) => String(d).includes('يعمل') && r()); setTimeout(() => j(new Error('server timeout')), 8000); });

const browser = await playwright.chromium.launch();
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'ar-IQ' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|ERR_FAILED/.test(m.text())) errors.push(`console: ${m.text()}`); });
  page.on('requestfailed', (r) => { if (!/fonts\.(googleapis|gstatic)/.test(r.url())) errors.push(`requestfailed: ${r.url()}`); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const shot = async (name) => { await page.waitForTimeout(260); await page.screenshot({ path: join(shots, `${name}.png`) }); };

  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForSelector('.lp-hero');
  await page.waitForTimeout(3200); // الإيصال يُطبع
  await shot('00-landing');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('00-landing-phone');
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) errors.push('landing overflow at 390px');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.click('.lp-copy a[href="#/signup"]');
  await page.waitForSelector('form[data-form="signup"]');
  await shot('01-signup');
  await page.fill('#su-shop', 'مقهى الزيتون');
  await page.fill('#su-owner', 'أحمد');
  await page.fill('#su-email', 'ahmed@zaytoon.iq');
  await page.fill('#su-pass', 'qahwa-2026!');
  await page.fill('#su-pin', '1357');
  await page.fill('#su-pin2', '1357');
  await page.click('form[data-form="signup"] button[type=submit]');
  await page.waitForSelector('#shift-start');
  await shot('02-open-shift');
  await page.fill('#shift-start', '50000');
  await page.click('form[data-form="open-shift"] button[type=submit]');
  await page.waitForSelector('.tile');
  await shot('03-pos-empty');

  await page.click('.tile:has-text("لاتيه")');
  await page.waitForSelector('.modal .opt');
  await page.click('.modal .opt:has-text("كبير")');
  await page.click('.modal .opt:has-text("حليب شوفان")');
  await page.click('.modal .opt:has-text("شوت إضافي")');
  await shot('04-item-modal');
  await page.click('[data-action="item-save"]');
  await page.click('.tile:has-text("كرواسون")');
  await page.click('[data-action="item-save"]');
  await page.click('.tile:has-text("ماء")');
  await page.click('[data-action="pos-customer"]');
  await page.fill('#cust-name', 'علي حسن');
  await page.fill('#cust-phone', '07701234567');
  await page.click('form[data-form="customer-create"] button');
  await page.waitForSelector('.customer-chip.set');
  await shot('05-pos-ticket');
  const due = await page.textContent('.charge .amount');
  await page.click('[data-action="pos-charge"]');
  await page.waitForSelector('.pay');
  await page.click('[data-action="pay-quick"] >> nth=1');
  await shot('06-payment');
  await page.click('[data-action="pay-confirm"]');
  await page.waitForSelector('.done');
  await shot('07-done');
  await page.click('[data-action="pay-new"]');

  await page.goto(`http://127.0.0.1:${PORT}/#/kds`);
  await page.waitForSelector('.kds-card');
  await shot('08-kds');
  await page.goto(`http://127.0.0.1:${PORT}/#/receipts`);
  await page.waitForSelector('tr.click');
  await page.click('tr.click >> nth=0');
  await page.waitForSelector('.receipt-paper');
  await shot('09-receipts');
  await page.goto(`http://127.0.0.1:${PORT}/#/shift`);
  await page.waitForSelector('#shift-counted');
  await shot('10-shift');
  await page.goto(`http://127.0.0.1:${PORT}/#/admin/dashboard`);
  await page.waitForSelector('.kpis');
  await shot('11-dashboard');
  await page.goto(`http://127.0.0.1:${PORT}/#/admin/items`);
  await page.waitForSelector('tr.click');
  await page.click('tr.click:has-text("لاتيه")');
  await page.waitForSelector('.modal');
  await shot('12-item-editor');
  await page.keyboard.press('Escape');
  await page.goto(`http://127.0.0.1:${PORT}/#/admin/inventory`);
  await page.waitForSelector('td');
  await shot('13-inventory');
  await page.goto(`http://127.0.0.1:${PORT}/#/admin/reports`);
  await page.waitForSelector('tfoot');
  await shot('14-reports');

  // الوضع الداكن وعرض الهاتف
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`http://127.0.0.1:${PORT}/#/pos`);
  await page.waitForSelector('.tile');
  await shot('15-pos-dark');
  await page.setViewportSize({ width: 400, height: 860 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForTimeout(100);
  await shot('16-pos-phone');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  if (overflow) errors.push('horizontal overflow at 400px');
  await page.click('[data-action="lock"]');
  await page.waitForSelector('.keypad');
  await page.setViewportSize({ width: 1280, height: 800 });
  await shot('17-pin');
  // جهاز جديد: الدخول بالبريد وكلمة المرور ثم رمز الموظف
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'ar-IQ' });
  const p2 = await ctx2.newPage();
  p2.on('pageerror', (e) => errors.push(`pageerror(2): ${e.message}`));
  await p2.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await p2.goto(`http://127.0.0.1:${PORT}/#/login`);
  await p2.waitForSelector('form[data-form="login"]');
  await p2.fill('#li-email', 'ahmed@zaytoon.iq');
  await p2.fill('#li-pass', 'wrong-password');
  await p2.click('form[data-form="login"] button[type=submit]');
  await p2.waitForSelector('.toast.bad');
  await p2.waitForTimeout(200);
  await p2.screenshot({ path: join(shots, '18-login-error.png') });
  await p2.fill('#li-pass', 'qahwa-2026!');
  await p2.click('form[data-form="login"] button[type=submit]');
  await p2.waitForSelector('.keypad');
  for (const k of '1357') await p2.click(`[data-k="${k}"]`);
  await p2.click('[data-action="pin-submit"]');
  await p2.waitForSelector('.tile');
  await p2.screenshot({ path: join(shots, '19-second-device.png') });
  console.log(`charged ${due}; screenshots in ${shots}`);
} finally {
  await browser.close();
  await new Promise((r) => { server.once('exit', r); server.kill(); });
  rmSync(dir, { recursive: true, force: true });
}
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
console.log('browser smoke: OK');
