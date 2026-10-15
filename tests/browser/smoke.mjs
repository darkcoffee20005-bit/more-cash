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
const server = spawn(process.execPath, [VERCEL ? 'scripts/vercel_dev.mjs' : 'server/index.js'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_FILE: join(dir, 'db.json'), MONGODB_URI: '', MORECASH_ALLOW_MEMORY: '1', PLATFORM_ADMINS: 'ahmed@zaytoon.iq', SUPPORT_WHATSAPP: '9647700000000' }, stdio: 'pipe' });
await new Promise((r, j) => { server.stdout.on('data', (d) => String(d).includes('يعمل') && r()); setTimeout(() => j(new Error('server timeout')), 8000); });

const browser = await playwright.chromium.launch();
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'ar-IQ' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  let lastStep = 'start';
  // 503 متوقع مرة واحدة: تصوير فاتورة بلا ANTHROPIC_API_KEY (يُتحقق من رسالته أدناه)
  let expected503 = 0;
  page.on('response', (r) => { if (r.status() === 503 && r.url().endsWith('/api/admin/inventory/scan')) expected503 += 1; });
  page.on('console', (m) => {
    if (m.type() !== 'error' || /fonts\.g|ERR_FAILED/.test(m.text())) return;
    if (/status of 503/.test(m.text()) && expected503 > 0) { expected503 -= 1; return; }
    errors.push(`console: ${m.text()}`);
  });
  page.on('requestfailed', (r) => { if (!/fonts\.(googleapis|gstatic)/.test(r.url())) errors.push(`requestfailed: ${r.url()} (${r.failure()?.errorText} @ ${page.url()} after ${lastStep})`); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const shot = async (name) => { lastStep = name; await page.waitForTimeout(260); await page.screenshot({ path: join(shots, `${name}.png`) }); };

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
  // النقر يضيف الصنف القياسي مباشرة؛ الحجم والإضافات بالضغط على سطره
  if (await page.isVisible('.modal')) errors.push('item tap should not open the options window');
  await page.click('.line:has-text("لاتيه")');
  await page.waitForSelector('.modal [data-action="item-save"]');
  await page.waitForSelector('.modal .opt');
  await page.click('.modal .opt:has-text("كبير")');
  await page.click('.modal .opt:has-text("حليب شوفان")');
  await page.click('.modal .opt:has-text("شوت إضافي")');
  await shot('04-item-modal');
  await page.click('[data-action="item-save"]');
  await page.click('.tile:has-text("كرواسون")');
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
  await page.click('[data-action="pay-bill"] >> nth=3');
  await shot('06-payment');
  await page.click('[data-action="pay-confirm"]');
  await page.waitForSelector('.done');
  await shot('07-done');
  await page.click('[data-action="pay-new"]');
  await page.waitForLoadState('networkidle');

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

  // الآيباد: التذكرة لوحة على اليمين بالوضعين، والدفع بفئات العملة
  for (const [name, w, h] of [['ipad-landscape', 1180, 820], ['ipad-portrait', 820, 1180]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`http://127.0.0.1:${PORT}/#/pos`);
    await page.waitForSelector('.tile');
    await page.click('.tile:has-text("كرواسون")');
    await page.click('.tile:has-text("ماء")');
    const side = await page.evaluate(() => {
      const t = document.querySelector('.ticket').getBoundingClientRect();
      const c = document.querySelector('.catalog').getBoundingClientRect();
      return { ticketRight: t.left > c.left, sameRow: Math.abs(t.top - c.top) < 2 };
    });
    if (!side.ticketRight || !side.sameRow) errors.push(`${name}: ticket panel is not on the right side`);
    const fit = await page.evaluate(() => {
      const t = document.querySelector('.ticket').getBoundingClientRect().width;
      const c = document.querySelector('.catalog').getBoundingClientRect().width;
      const pay = document.querySelector('.charge').getBoundingClientRect();
      return { narrower: t < c && t > c * 0.7, payVisible: pay.bottom <= innerHeight + 1, noScroll: document.documentElement.scrollHeight <= innerHeight + 1 };
    });
    if (!fit.narrower) errors.push(`${name}: ticket should be slightly narrower than the items area`);
    if (!fit.payVisible || !fit.noScroll) errors.push(`${name}: pay button needs scrolling`);
    if (name === 'ipad-landscape') {
      // سحب المقبض يكبّر نافذة الطلب، ويبقى الحجم بعد إعادة التحميل
      const w0 = await page.evaluate(() => document.querySelector('.ticket').getBoundingClientRect().width);
      const bar = await page.locator('.splitter').boundingBox();
      await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
      await page.mouse.down();
      await page.mouse.move(bar.x - 120, bar.y + bar.height / 2, { steps: 6 });
      await page.mouse.up();
      const w1 = await page.evaluate(() => document.querySelector('.ticket').getBoundingClientRect().width);
      if (Math.abs(w1 - w0 - 120) > 8) errors.push(`splitter drag: ${w0} → ${w1}`);
      await page.waitForLoadState('networkidle');
      await page.reload();
      await page.waitForSelector('.tile');
      const w2 = await page.evaluate(() => document.querySelector('.ticket').getBoundingClientRect().width);
      if (Math.abs(w2 - w1) > 2) errors.push(`ticket width not kept after reload: ${w1} → ${w2}`);
      await page.click('.tile:has-text("كرواسون")');
      await page.click('.tile:has-text("ماء")');
      await page.dblclick('.splitter');
      if (await page.evaluate(() => localStorage.getItem('morecash.ticketW')) !== null) errors.push('double-click should reset width');
      if (!(await page.isVisible('[data-action="fullscreen"]'))) errors.push('fullscreen button missing');
    }
    await shot(`19-${name}`);
    if (name === 'ipad-landscape') {
      for (const t of ['إسبريسو', 'أمريكانو', 'كابتشينو', 'موكا', 'فلات وايت', 'قهوة تركية', 'آيس لاتيه', 'كولد برو', 'شاي عراقي', 'كوكيز', 'تشيز كيك', 'هوت شوكليت', 'ماتشا لاتيه', 'آيس أمريكانو']) {
        await page.click(`.tile:has-text("${t}")`);
      }
      const scroll = await page.evaluate(() => { const ul = document.querySelector('.ticket .lines'); const t = document.querySelector('.ticket'); return { lines: ul.scrollHeight - ul.clientHeight, ticket: t.scrollHeight - t.clientHeight, more: !document.querySelector('.more-lines').hidden }; });
      if (scroll.lines > 1 || scroll.ticket > 1) errors.push(`order panel scrolls: ${JSON.stringify(scroll)}`);
      if (!scroll.more) errors.push('long order should fold older lines into "+N"');
      await shot('19b-long-order');
      await page.click('.more-lines');
      await page.waitForSelector('.modal tr.click');
      await page.keyboard.press('Escape');
      await page.click('[data-action="pos-clear"]');
      await page.click('[data-action="pos-clear"]');
      await page.click('[data-action="ticket-toggle"]');
      await page.waitForSelector('.ticket-fab');
      await page.click('.tile:has-text("كرواسون")');
      await shot('19c-ticket-hidden');
      await page.click('.ticket-fab');
      await page.waitForSelector('.ticket .line');
      await page.click('.tile:has-text("ماء")');
    }
    await page.click('[data-action="pos-charge"]');
    await page.waitForSelector('.bills');
    await page.click('[data-action="pay-bill"] >> nth=1');
    await shot(`20-${name}-pay`);
    await page.click('[data-action="pay-confirm"]');
    await page.waitForSelector('.done');
    await page.click('[data-action="pay-new"]');
    await page.waitForLoadState('networkidle');
  }
  await page.setViewportSize({ width: 1280, height: 800 });

  // لوحة المزوّد في سياق منفصل (جلسة مستقلة)
  {
    const pc = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const pp = await pc.newPage();
    pp.on('pageerror', (e) => errors.push(`pageerror(platform): ${e.message}`));
    await pp.route(/fonts\.(googleapis|gstatic)/, (r) => r.abort());
    await pp.goto(`http://127.0.0.1:${PORT}/#/platform`);
    await pp.waitForSelector('form[data-form="platform-login"]');
    await pp.fill('#pf-email', 'ahmed@zaytoon.iq');
    await pp.fill('#pf-pass', 'qahwa-2026!');
    await pp.click('form[data-form="platform-login"] button[type=submit]');
    await pp.waitForSelector('td:has-text("مقهى الزيتون")');
    await pp.waitForTimeout(200);
    await pp.screenshot({ path: join(shots, '25-platform.png') });
    await pp.goto(`http://127.0.0.1:${PORT}/#/forgot`);
    await pp.waitForSelector('a[href^="https://wa.me/9647700000000"]');
    await pc.close();
  }

  await page.goto(`http://127.0.0.1:${PORT}/#/admin/daily`);
  await page.waitForSelector('.kpis');
  await shot('21-daily-report');

  // المخزون: تنبيه، استلام يدوي، وتصوير فاتورة (بلا مفتاح API هنا → رسالة واضحة ويبقى الإدخال اليدوي)
  await page.goto(`http://127.0.0.1:${PORT}/#/admin/inventory`);
  await page.waitForSelector('[data-action="rcv-open"]');
  await page.setInputFiles('#rcv-file', { name: 'invoice.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64') });
  await page.waitForSelector('.toast.bad');
  if (!/غير مفعّلة/.test(await page.textContent('.toast.bad'))) errors.push('scan without key: unclear message');
  await page.waitForSelector('.rcv-row');
  await page.selectOption('#rcv-v-0', { label: 'بن إسبريسو (غ)' });
  await page.fill('#rcv-q-0', '1000');
  await page.fill('#rcv-t-0', '40000');
  await shot('22-receive');
  await page.click('[data-action="rcv-submit"]');
  await page.waitForSelector('.toast.ok');
  await shot('23-inventory');
  // جرد يُنزل مادة تحت الحد → تنبيه على شاشة البيع وشارة على الإدارة
  await page.evaluate(async () => {
    const inv = await (await fetch('/api/admin/inventory')).json();
    const cake = inv.rows.find((r) => r.name.startsWith('تشيز كيك'));
    await fetch('/api/admin/inventory/adjust', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'morecash' },
      body: JSON.stringify({ clientId: crypto.randomUUID(), variantId: cake.variantId, type: 'count', qty: 2 }) }).then((r) => r.json());
  });
  // تحميل كامل للصفحة (لا تغيير hash ثم reload، فذلك يقطع طلب البيانات الجاري)
  await page.goto('about:blank');
  await page.goto(`http://127.0.0.1:${PORT}/#/pos`);
  await page.waitForSelector('.low-banner');
  if (!(await page.isVisible('.rail .badge.bad'))) errors.push('low-stock badge missing on admin');
  await shot('24-low-banner');

  // الألوان فاتحة حتى لو كان الجهاز في الوضع الداكن، وعرض الهاتف
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
