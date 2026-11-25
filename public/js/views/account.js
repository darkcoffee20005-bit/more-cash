// الصفحة الرئيسية، إنشاء حساب المقهى، تسجيل الدخول، شاشة رمز الموظف، وإعدادات الحساب.
import { esc } from '../../../shared/format.js';
import { get, post } from '../api.js';
import { icon } from '../icons.js';
import { mark, wordmark } from '../brand.js';
import { bookView, siteView } from './site.js';
import { busy, can, field, modalFrame, on, openModal, render, set, state, toast } from '../ui.js';

const DEMO = () => !!globalThis.MORECASH_BACKEND;
export const DEMO_ACCOUNT = { email: 'demo@morecash.app', password: 'morecash-demo' };
// النسخة التجريبية تعمل في ذاكرة المتصفح فقط: أي حساب يُنشأ فيها يضيع عند التحديث،
// لذا روابط "إنشاء حساب" فيها تذهب للموقع الحقيقي (نفس النطاق على Vercel، أو الرابط الكامل من GitHub Pages)
const LIVE_URL = 'https://more-cashpro.vercel.app';
const latinDigits = (v) => String(v ?? '').trim().replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0));
const DEMO_PAGE = () => !!globalThis.MORECASH_DEMO_PAGE; // تضبطه صفحة التجربة المنشورة فقط (demo/main.js)
const signupHref = () => {
  if (!DEMO_PAGE()) return '#/signup';
  return globalThis.location?.hostname?.endsWith('vercel.app') ? '/#/signup' : `${LIVE_URL}/#/signup`;
};
const DEMO_PINS = [['المالك', '1234'], ['المدير', '2580'], ['الكاشير', '1470'], ['الباريستا', '3690']];

// ---------------------------------------------------------------- إنشاء حساب ودخول
// بلا تصحيح ولا حرف كبير تلقائي: عند «إظهار» يصير الحقل نصاً فيغيّر الآيباد ما يُكتب
const pw = (name, id, auto) => `<div class="pw-wrap"><input name="${name}" id="${id}" type="password" required minlength="8" maxlength="128" autocomplete="${auto}" autocapitalize="none" autocorrect="off" spellcheck="false"><button type="button" data-action="pw-toggle" data-for="${id}">إظهار</button></div><p class="pw-hint small" id="${id}-hint" hidden></p>`;
/** تنبيه فوري: لوحة مفاتيح عربية أو Caps Lock — أشهر سببين لـ«كلمة المرور خطأ» */
function pwHint(input, e) {
  const hint = document.getElementById(`${input.id}-hint`);
  if (!hint) return;
  const msgs = [];
  if (/[\u0600-\u06FF]/.test(input.value.replace(/[٠-٩۰-۹]/g, ''))) msgs.push('فيها حروف عربية — تأكد من لغة لوحة المفاتيح.');
  if (e?.getModifierState?.('CapsLock')) msgs.push('زر الأحرف الكبيرة (Caps Lock) مفعّل.');
  hint.textContent = msgs.join(' ');
  hint.hidden = !msgs.length;
}

function side(title, lead, points) {
  return `<aside class="acc-side">${wordmark()}
    <div><h2>${title}</h2><p class="lead">${lead}</p></div>
    <ul>${points.map((p) => `<li>${icon('check', 'sm')}<span>${p}</span></li>`).join('')}</ul>
  </aside>`;
}

// ---------------------------------------------------------------- نسيت كلمة المرور / مقهى موقوف
let support = undefined; // رقم واتساب الدعم من الخادم (SUPPORT_WHATSAPP)
async function loadSupport() {
  if (support !== undefined) return support;
  try { support = (await get('/api/support')).whatsapp ?? null; } catch { support = null; }
  render();
  return support;
}
const waLink = (text) => (support ? `https://wa.me/${support}?text=${encodeURIComponent(text)}` : null);

function forgot() {
  loadSupport();
  const wa = waLink('مرحباً، نسيت كلمة مرور حساب مقهاي في مور كاش. البريد المسجّل: ');
  return `<div class="auth-panel" style="height:100%"><div class="card pad stack" style="max-width:520px">
    <h1>نسيت كلمة المرور؟</h1>
    <p>لا تحتاج كلمة المرور على الأجهزة المربوطة بمقهاك: شاشة الرمز تكفي. تُطلب كلمة المرور فقط لربط جهاز جديد.</p>
    <p>لاستعادتها تواصل مع مزوّد الخدمة: يعطيك كلمة مرور مؤقتة تدخل بها ثم تغيّرها من الإدارة ← الإعدادات.</p>
    ${wa ? `<a class="btn primary lg block" href="${wa}" target="_blank" rel="noopener">تواصل مع الدعم على واتساب</a>` : support === undefined ? '<p class="muted small">…</p>' : '<p class="muted small">تواصل مع الجهة التي زوّدتك بالبرنامج.</p>'}
    <a class="btn ghost block" href="#/login">العودة لتسجيل الدخول</a></div></div>`;
}

export function disabledView(s) {
  loadSupport();
  const wa = waLink(`مرحباً، حساب مقهى "${s.shop?.name ?? ''}" في مور كاش موقوف. أرجو المساعدة.`);
  return `<div class="auth-panel" style="height:100%"><div class="card pad stack" style="max-width:520px">
    <div class="row">${icon('alert')}<h1 style="font-size:1.4rem">الحساب موقوف مؤقتاً</h1></div>
    <p>حساب <b>${esc(s.shop?.name ?? '')}</b> موقوف من مزوّد الخدمة، فلا يمكن البيع حالياً. بياناتك ومبيعاتك محفوظة كما هي.</p>
    ${wa ? `<a class="btn primary lg block" href="${wa}" target="_blank" rel="noopener">تواصل مع الدعم على واتساب</a>` : '<p class="muted small">تواصل مع الجهة التي زوّدتك بالبرنامج لإعادة التفعيل.</p>'}
    <button class="btn block" data-action="reload">إعادة المحاولة</button></div></div>`;
}

function demoSignupNotice() {
  return `<div class="auth-panel" style="height:100%"><div class="card pad stack" style="max-width:520px">
    <h1>إنشاء حساب مقهاك</h1>
    <p>هذه <b>نسخة تجريبية</b> تعمل داخل المتصفح فقط، وأي حساب يُنشأ فيها يضيع عند تحديث الصفحة.</p>
    <p>لإنشاء حساب حقيقي تُحفظ فيه مبيعاتك افتح الموقع الرسمي:</p>
    <a class="btn primary lg block" href="${signupHref()}">أنشئ حسابك على ${LIVE_URL.replace('https://', '')}</a>
    <a class="btn ghost block" href="#/">العودة للتجربة</a></div></div>`;
}

function signup(s) {
  return `<div class="acc">${side('افتح حساب مقهاك', 'دقيقتان، وبعدها تبيع أول كوب.', [
    'قائمة كوفي جاهزة بالأسعار والإضافات والوصفات، تعدّلها كما تريد.',
    'رمز دخول سريع لك ولكل موظف بدل كلمة المرور.',
    'يعمل على التابلت والحاسوب والهاتف.',
  ])}
    <main class="acc-main"><form class="acc-form" data-form="signup" data-keep novalidate>
      <div><h1>إنشاء حساب</h1><p class="sub">لديك حساب؟ <a href="#/login">سجّل الدخول</a></p></div>
      <fieldset><legend>المقهى</legend>
        ${field('اسم المقهى', '<input name="shopName" id="su-shop" required minlength="2" maxlength="60" autocomplete="organization">')}
        ${field('اسمك', '<input name="ownerName" id="su-owner" required minlength="2" maxlength="40" autocomplete="name">')}
      </fieldset>
      <fieldset><legend>الدخول للحساب</legend>
        ${field('البريد الإلكتروني', '<input name="email" id="su-email" type="email" required dir="ltr" autocomplete="email" inputmode="email" autocapitalize="none" autocorrect="off" spellcheck="false">')}
        ${field('كلمة المرور', pw('password', 'su-pass', 'new-password'), '8 أحرف على الأقل، ولا تكون أرقاماً فقط. اكتبها بالإنجليزي واحفظها')}
        ${field('تأكيد كلمة المرور', pw('password2', 'su-pass2', 'new-password'))}
      </fieldset>
      <fieldset><legend>رمزك السريع للكاشير</legend>
        <div class="grid-2">
          ${field('الرمز (4–6 أرقام)', '<input name="pin" id="su-pin" required inputmode="numeric" pattern="[0-9٠-٩۰-۹]{4,6}" maxlength="6" type="password" autocomplete="off">')}
          ${field('تأكيد الرمز', '<input name="pin2" id="su-pin2" required inputmode="numeric" pattern="[0-9٠-٩۰-۹]{4,6}" maxlength="6" type="password" autocomplete="off">')}
        </div>
      </fieldset>
      <label class="check"><input type="checkbox" name="seed" checked> ابدأ بقائمة كوفي جاهزة</label>
      <button class="btn primary lg block" type="submit" ${s.busy ? 'disabled' : ''}>إنشاء الحساب وفتح المقهى</button>
    </form></main></div>`;
}

function login(s) {
  return `<div class="acc">${side('أهلاً من جديد', 'سجّل دخول هذا الجهاز مرة واحدة، وبعدها يدخل الموظفون برموزهم.', [
    'الجهاز يبقى مرتبطاً بمقهاك حتى تسجّل خروجه.',
    'كلمة المرور للمالك فقط، والموظفون لا يحتاجونها.',
  ])}
    <main class="acc-main"><form class="acc-form" data-form="login" data-keep>
      <div><h1>تسجيل الدخول</h1><p class="sub">ليس لديك حساب؟ <a href="${signupHref()}">أنشئ حساب مقهاك</a></p></div>
      ${DEMO() ? `<div class="demo-note">للتجربة: <b dir="ltr">${DEMO_ACCOUNT.email}</b> وكلمة المرور <b dir="ltr">${DEMO_ACCOUNT.password}</b></div>` : ''}
      ${field('البريد الإلكتروني', '<input name="email" id="li-email" type="email" required dir="ltr" autocomplete="username" inputmode="email" autocapitalize="none" autocorrect="off" spellcheck="false">')}
      ${field('كلمة المرور', pw('password', 'li-pass', 'current-password'))}
      <button class="btn primary lg block" type="submit" ${s.busy ? 'disabled' : ''}>تسجيل الدخول</button>
      <a class="small" href="#/forgot" style="text-align:center">نسيت كلمة المرور؟</a>
    </form></main></div>`;
}

// ---------------------------------------------------------------- رمز الموظف
function pin(s) {
  const p = s.view.pin ?? '';
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'];
  return `<div class="acc">
    <aside class="acc-side">${wordmark()}
      <div><p class="lead" style="display:block;margin:0 0 6px">أهلاً بك في</p><div class="shop-name">${esc(s.shop?.name ?? '')}</div></div>
      <div class="foot"><button class="link-btn" data-action="leave-ask">ليس مقهاك؟ سجّل خروج هذا الجهاز</button></div>
    </aside>
    <main class="acc-main"><div class="pin-card">
      <div><h1>أدخل رمزك</h1><p class="muted">رمز الموظف من 4 إلى 6 أرقام</p></div>
      ${s.shop?.subscription?.status === 'expired' ? `<div class="alert-low">${icon('alert')}<div><b>انتهى الاشتراك</b><div class="small">التقارير متاحة والبيع موقوف. <button class="link-btn" data-action="sub-open">تجديد الاشتراك</button></div></div></div>` : ''}
      ${DEMO() ? `<div class="demo-note">رموز التجربة: ${DEMO_PINS.map(([r, c]) => `${r} <b>${c}</b>`).join('، ')}</div>` : ''}
      <div class="pin-dots ${s.view.pinShake ? 'shake' : ''}" aria-label="عدد الأرقام المدخلة ${p.length}">
        ${Array.from({ length: Math.max(4, p.length) }, (_, i) => `<span class="${i < p.length ? 'on' : ''}"></span>`).join('')}
      </div>
      <div class="keypad">${keys.map((k) => (k === 'clear' ? '<button class="muted-key" data-action="pin-clear">مسح</button>'
        : k === 'back' ? `<button class="muted-key" data-action="pin-back" aria-label="حذف رقم">${icon('back')}</button>`
          : `<button data-action="pin-key" data-k="${k}">${k}</button>`)).join('')}</div>
      <button class="btn primary lg block" data-action="pin-submit" ${p.length < 4 || s.busy ? 'disabled' : ''}>دخول</button>
      <button class="btn block" data-action="kiosk-open">${icon('clock', 'sm')} الحضور والانصراف</button>
    </div></main></div>`;
}

/** شاشة ما قبل دخول الموظف: الرئيسية/إنشاء حساب/دخول، أو رمز الموظف إن كان الجهاز مرتبطاً بمقهى */
export function gateView(s) {
  if (s.shop) return pin(s);
  if (s.authPage === 'signup') return DEMO_PAGE() ? demoSignupNotice() : signup(s);
  if (s.authPage === 'login') return login(s);
  if (s.authPage === 'forgot') return forgot(s);
  if (s.authPage === 'book') return bookView(s);
  return siteView(s);
}

// ---------------------------------------------------------------- إعدادات الحساب (للمالك)
export function accountCard(s, account) {
  if (s.employee?.role !== 'owner') return '';
  return `<section class="card pad stack account-card" aria-labelledby="acc-h"><h2 id="acc-h">حساب المقهى</h2>
    <p class="muted">البريد المستخدم للدخول: <b dir="ltr">${esc(account?.email ?? '…')}</b></p>
    <form class="stack" data-form="account-password" data-keep>
      <div class="grid-2">
        ${field('كلمة المرور الحالية', '<input name="current" id="ap-current" type="password" required autocomplete="current-password">')}
        ${field('كلمة المرور الجديدة', '<input name="next" id="ap-next" type="password" required minlength="8" autocomplete="new-password">', 'تغييرها يسجّل خروج الأجهزة الأخرى')}
      </div>
      <div class="row wrap"><button class="btn" type="submit" ${s.busy ? 'disabled' : ''}>تغيير كلمة المرور</button>
        <span class="spacer"></span><button type="button" class="btn danger" data-action="leave-ask">تسجيل خروج هذا الجهاز</button></div>
    </form></section>`;
}

export const modals = {
  'leave-device': () => modalFrame({
    title: 'تسجيل خروج هذا الجهاز',
    body: '<p>سيُفصل هذا الجهاز عن المقهى. لإعادة ربطه يلزم البريد وكلمة مرور الحساب. بيانات المقهى تبقى محفوظة.</p>',
    foot: '<button class="btn ghost" data-action="close-modal">إلغاء</button><span class="spacer"></span><button class="btn danger solid" data-action="leave-confirm" autofocus>تسجيل الخروج</button>',
  }),
};

// ---------------------------------------------------------------- الإجراءات
function afterShopReady(cb) {
  history.replaceState(null, '', '#/');
  return cb();
}

export function initAccount({ loadSession }) {
  for (const t of ['input', 'keyup']) {
    globalThis.document?.addEventListener(t, (e) => { if (e.target?.matches?.('.pw-wrap input')) pwHint(e.target, e); });
  }
  on({
    'pw-toggle': (el) => {
      const input = document.getElementById(el.dataset.for);
      if (!input) return;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      el.textContent = show ? 'إخفاء' : 'إظهار';
    },
    signup: (_el, _e, d) => busy(async () => {
      const missing = ['shopName', 'ownerName', 'email', 'password', 'pin'].find((k) => !String(d[k] ?? '').trim());
      if (missing) { toast('أكمل كل الحقول', 'bad'); document.querySelector(`[name="${missing}"]`)?.focus(); return; }
      if (d.password !== d.password2) { toast('كلمتا المرور غير متطابقتين', 'bad'); document.getElementById('su-pass2')?.focus(); return; }
      if (latinDigits(d.pin) !== latinDigits(d.pin2)) { toast('الرمزان غير متطابقين', 'bad'); return; }
      const r = await post('/api/account/signup', { shopName: d.shopName, ownerName: d.ownerName, email: d.email, password: d.password, pin: d.pin, seed: d.seed });
      state.shop = r.shop;
      toast(`أهلاً بك في ${r.shop.name}`, 'ok');
      await afterShopReady(() => loadSession(r.employee));
    }),
    login: (_el, _e, d) => busy(async () => {
      const r = await post('/api/account/login', { email: d.email, password: d.password });
      afterShopReady(() => set({ shop: r.shop, employee: null, view: { pin: '' } }));
      if (r.mustChangePassword) toast('دخلت بكلمة مرور مؤقتة. غيّرها من الإدارة ← الإعدادات بعد إدخال رمزك.', 'bad');
    }),
    'demo-enter': () => busy(async () => {
      const r = await post('/api/account/login', DEMO_ACCOUNT);
      afterShopReady(() => set({ shop: r.shop, employee: null, view: { pin: '' } }));
    }),
    'leave-ask': () => openModal({ type: 'leave-device' }),
    'leave-confirm': () => busy(async () => {
      await post('/api/account/logout', {});
      history.replaceState(null, '', '#/');
      set({ shop: null, employee: null, modal: null, view: {}, authPage: '' });
    }),
    'account-password': (el, _e, d) => busy(async () => {
      await post('/api/account/password', { current: d.current, next: d.next });
      el.reset?.();
      toast('تم تغيير كلمة المرور', 'ok');
    }),
  });
}

export async function loadAccount() {
  if (!can('admin.settings') || state.employee?.role !== 'owner') return null;
  return get('/api/account').catch(() => null);
}

export { mark };
