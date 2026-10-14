// الصفحة الرئيسية، إنشاء حساب المقهى، تسجيل الدخول، شاشة رمز الموظف، وإعدادات الحساب.
import { esc, money } from '../../../shared/format.js';
import { get, post } from '../api.js';
import { icon } from '../icons.js';
import { mark, wordmark } from '../brand.js';
import { busy, can, field, modalFrame, on, openModal, render, set, state, toast } from '../ui.js';

const DEMO = () => !!globalThis.MORECASH_BACKEND;
export const DEMO_ACCOUNT = { email: 'demo@morecash.app', password: 'morecash-demo' };
const DEMO_PINS = [['المالك', '1234'], ['المدير', '2580'], ['الكاشير', '1470'], ['الباريستا', '3690']];

// ---------------------------------------------------------------- الإيصال المطبوع (رمز الهوية)
function receipt() {
  const lines = [['لاتيه — وسط', 5000], ['حليب شوفان', 1000, true], ['شوت إضافي', 750, true], ['كرواسون زبدة', 3000]];
  const total = lines.reduce((a, [, p]) => a + p, 0);
  return `<div class="printer" aria-hidden="true"><div class="printer-slot"></div><div class="paper"><div class="receipt">
    <div class="rc-shop">مقهى الزيتون</div>
    <div class="rc-meta"><span>إيصال 1042</span><span>8:14 ص</span></div>
    <div class="rc-rule"></div>
    ${lines.map(([n, p, sub]) => `<div class="rc-line ${sub ? 'sub' : ''}"><span>${sub ? '+ ' : ''}${n}</span><span>${money(p, { symbol: false })}</span></div>`).join('')}
    <div class="rc-rule"></div>
    <div class="rc-line total"><span>المجموع</span><span>${money(total)}</span></div>
    <div class="rc-line"><span>نقداً</span><span>${money(10000, { symbol: false })}</span></div>
    <div class="rc-line"><span>الباقي</span><span>${money(10000 - total, { symbol: false })}</span></div>
    <div class="rc-thanks">صحتين، ونشوفكم باچر</div>
  </div></div></div>`;
}

// ---------------------------------------------------------------- الصفحة الرئيسية
const DAY = [
  ['الطلب', 'لاتيه وسط بحليب شوفان وشوت إضافي: لمستان، والسعر يُحسب وحده.'],
  ['التحضير', 'الطلب يظهر على شاشة الباريستا مع الإضافات، ويُعلَّم جاهزاً بلمسة.'],
  ['الدفع', 'نقد أو بطاقة أو محفظة، أو أكثر من طريقة في فاتورة واحدة، مع حساب الباقي.'],
  ['المخزون', 'البن والحليب والأكواب تُخصم من الوصفة مع كل كوب، وتنبيه قبل أن تنفد.'],
  ['إغلاق الوردية', 'المتوقع في الدرج مقابل الموجود، والفرق مسجّل باسم من أغلق.'],
];

function landing() {
  const demoBtn = DEMO()
    ? '<button class="btn on-dark lg" data-action="demo-enter">ادخل المقهى التجريبي</button>'
    : '<a class="btn on-dark lg" href="/demo.html">جرّب المقهى التجريبي</a>';
  return `<div class="lp">
    <div class="lp-dark">
      <header class="lp-top">${wordmark()}
        <nav aria-label="الحساب"><a class="btn on-dark ghost" href="#/login">تسجيل الدخول</a><a class="btn brass hide-sm" href="#/signup">إنشاء حساب</a></nav>
      </header>
      <section class="lp-hero">
        <div class="lp-copy">
          <h1>كاشير يعرف القهوة.</h1>
          <p>اطلب، حضّر، اقبض، وأغلق الوردية من شاشة واحدة. مور كاش مصمم لإيقاع الكوفي شوب: الإضافات بلمسة، والمخزون يُخصم من الوصفة، والحساب بالدينار بلا كسور.</p>
          <div class="row"><a class="btn brass lg" href="#/signup">أنشئ حساب مقهاك</a>${demoBtn}</div>
        </div>
        ${receipt()}
      </section>
    </div>
    <section class="lp-section" aria-labelledby="day-h">
      <h2 id="day-h">يوم كامل في المقهى، من أول كوب لآخر دينار</h2>
      <ol class="tape">${DAY.map(([t, d], i) => `<li><span class="n">${i + 1}</span><b>${t}</b><p>${d}</p></li>`).join('')}</ol>
    </section>
    <section class="lp-section" aria-labelledby="iq-h">
      <h2 id="iq-h">مبني لمقاهي العراق</h2>
      <dl class="iq">
        <div><dt>الدينار كما هو</dt><dd>كل المبالغ أعداد صحيحة بالدينار العراقي، والخصومات والضريبة تُقرَّب بطريقة واحدة ثابتة.</dd></div>
        <div><dt>زين كاش وFIB والبطاقة</dt><dd>أضف طرق الدفع التي يستخدمها زبائنك، والنقد وحده يدخل حساب الدرج.</dd></div>
        <div><dt>لكل موظف رمزه</dt><dd>مالك ومدير وكاشير وباريستا. كل واحد يدخل برمز من أربعة أرقام ويرى ما يخصه فقط.</dd></div>
        <div><dt>بيانات مقهاك لك وحدك</dt><dd>كل حساب معزول عن غيره. تدخل بالبريد وكلمة المرور مرة واحدة على كل جهاز، وبعدها يكفي رمز الموظف.</dd></div>
      </dl>
    </section>
    <section class="lp-cta"><div><h2>جاهز تفتح الدرج؟</h2><a class="btn brass lg" href="#/signup">أنشئ حساب مقهاك</a></div></section>
    <footer class="lp-foot">${wordmark()}<span>كاشير وإدارة للكوفي شوب</span></footer>
  </div>`;
}

// ---------------------------------------------------------------- إنشاء حساب ودخول
const pw = (name, id, auto) => `<div class="pw-wrap"><input name="${name}" id="${id}" type="password" required minlength="8" maxlength="128" autocomplete="${auto}"><button type="button" data-action="pw-toggle" data-for="${id}">إظهار</button></div>`;

function side(title, lead, points) {
  return `<aside class="acc-side">${wordmark()}
    <div><h2>${title}</h2><p class="lead">${lead}</p></div>
    <ul>${points.map((p) => `<li>${icon('check', 'sm')}<span>${p}</span></li>`).join('')}</ul>
  </aside>`;
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
        ${field('البريد الإلكتروني', '<input name="email" id="su-email" type="email" required dir="ltr" autocomplete="email" inputmode="email">')}
        ${field('كلمة المرور', pw('password', 'su-pass', 'new-password'), '8 أحرف على الأقل، ولا تكون أرقاماً فقط')}
      </fieldset>
      <fieldset><legend>رمزك السريع للكاشير</legend>
        <div class="grid-2">
          ${field('الرمز (4–6 أرقام)', '<input name="pin" id="su-pin" required inputmode="numeric" pattern="[0-9]{4,6}" maxlength="6" type="password" autocomplete="off">')}
          ${field('تأكيد الرمز', '<input name="pin2" id="su-pin2" required inputmode="numeric" pattern="[0-9]{4,6}" maxlength="6" type="password" autocomplete="off">')}
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
      <div><h1>تسجيل الدخول</h1><p class="sub">ليس لديك حساب؟ <a href="#/signup">أنشئ حساب مقهاك</a></p></div>
      ${DEMO() ? `<div class="demo-note">للتجربة: <b dir="ltr">${DEMO_ACCOUNT.email}</b> وكلمة المرور <b dir="ltr">${DEMO_ACCOUNT.password}</b></div>` : ''}
      ${field('البريد الإلكتروني', '<input name="email" id="li-email" type="email" required dir="ltr" autocomplete="username" inputmode="email">')}
      ${field('كلمة المرور', pw('password', 'li-pass', 'current-password'))}
      <button class="btn primary lg block" type="submit" ${s.busy ? 'disabled' : ''}>تسجيل الدخول</button>
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
      ${DEMO() ? `<div class="demo-note">رموز التجربة: ${DEMO_PINS.map(([r, c]) => `${r} <b>${c}</b>`).join('، ')}</div>` : ''}
      <div class="pin-dots ${s.view.pinShake ? 'shake' : ''}" aria-label="عدد الأرقام المدخلة ${p.length}">
        ${Array.from({ length: Math.max(4, p.length) }, (_, i) => `<span class="${i < p.length ? 'on' : ''}"></span>`).join('')}
      </div>
      <div class="keypad">${keys.map((k) => (k === 'clear' ? '<button class="muted-key" data-action="pin-clear">مسح</button>'
        : k === 'back' ? `<button class="muted-key" data-action="pin-back" aria-label="حذف رقم">${icon('back')}</button>`
          : `<button data-action="pin-key" data-k="${k}">${k}</button>`)).join('')}</div>
      <button class="btn primary lg block" data-action="pin-submit" ${p.length < 4 || s.busy ? 'disabled' : ''}>دخول</button>
    </div></main></div>`;
}

/** شاشة ما قبل دخول الموظف: الرئيسية/إنشاء حساب/دخول، أو رمز الموظف إن كان الجهاز مرتبطاً بمقهى */
export function gateView(s) {
  if (s.shop) return pin(s);
  if (s.authPage === 'signup') return signup(s);
  if (s.authPage === 'login') return login(s);
  return landing();
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
      if (d.pin !== d.pin2) { toast('الرمزان غير متطابقين', 'bad'); return; }
      const r = await post('/api/account/signup', { shopName: d.shopName, ownerName: d.ownerName, email: d.email, password: d.password, pin: d.pin, seed: d.seed });
      state.shop = r.shop;
      toast(`أهلاً بك في ${r.shop.name}`, 'ok');
      await afterShopReady(() => loadSession(r.employee));
    }),
    login: (_el, _e, d) => busy(async () => {
      const r = await post('/api/account/login', { email: d.email, password: d.password });
      afterShopReady(() => set({ shop: r.shop, employee: null, view: { pin: '' } }));
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
