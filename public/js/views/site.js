// الموقع التعريفي لمور كاش (الصفحة الرئيسية لمن لم يربط جهازه بمقهى) وصفحة «احجز عرضك المجاني».
// المحتوى حقيقي من البرنامج: اللقطات من النسخة التجريبية، والميزات الموجودة فعلاً فقط.
// «يثقون بمور كاش» وآراء العملاء يحررها المزوّد من لوحته (GET /api/site)، وتظهر مستطيلات فارغة حتى يضيفها.
import { esc } from '../../../shared/format.js';
import { get, post } from '../api.js';
import { icon } from '../icons.js';
import { mark } from '../brand.js';
import { busy, field, on, render, state } from '../ui.js';

const LIVE_URL = 'https://more-cashpro.vercel.app';
const DEMO_PAGE = () => !!globalThis.MORECASH_DEMO_PAGE;
const SAME_ORIGIN = () => !DEMO_PAGE() || globalThis.location?.hostname?.endsWith('vercel.app');
// المحاكي (صفحة واحدة خارج الموقع) يضبط مكان الصور بنفسه
const BASE = () => globalThis.MORECASH_IMG_BASE ?? (SAME_ORIGIN() ? '' : LIVE_URL);
const img = (name) => `${BASE()}/img/site/${name}.webp`;
const href = (route) => (SAME_ORIGIN() ? `#/${route}` : `${LIVE_URL}/#/${route}`);
const PRICE = { month: 50_000, year: 500_000 };
const num = (n) => n.toLocaleString('en-US');

const S = () => state.site ?? (state.site = { info: undefined, shot: 'pos', bill: 'month', kind: 'cafe', menu: false, sent: false, clientId: null });

async function loadSite() {
  const s = S();
  if (s.info !== undefined || s.loading) return;
  s.loading = true;
  try { s.info = await get('/api/site'); } catch { s.info = null; }
  s.loading = false;
  render();
}
const wa = (text) => {
  const n = S().info?.whatsapp ?? globalThis.MORECASH_SUPPORT;
  return n ? `https://wa.me/${n}?text=${encodeURIComponent(text)}` : null;
};
const WA_HELLO = 'مرحباً، أريد أعرف أكثر عن مور كاش لمقهاي.';

// ---------------------------------------------------------------- المحتوى
const MODULES = [
  ['sale', 'نقاط البيع', 'كاشير سريع على الآيباد', ['أصناف بصورها أو إيموجي بلونها', 'الحجم والإضافات بلمسة، والسعر يُحسب وحده', 'دفع نقد أو كي أو الاثنين بنفس الطلب', 'خصومات ونقاط للزبائن']],
  ['table', 'الطاولات', 'خريطة صالتك كما هي', ['ترسم الطاولات وأماكنها بالسحب', 'المشغولة تبين بمبلغها، والفارغة تنختار بلمسة', 'تذكرة مفتوحة لكل طاولة لحد الدفع']],
  ['cup', 'شاشة التحضير', 'الطلب يوصل للباريستا لحظة الدفع', ['الطلبات بالترتيب ومع وقت الانتظار', 'الإلغاء بسبب واضح وباسم الموظف', 'ما انحضّر وانلغى ينحسب هدراً']],
  ['box', 'المخزون والوصفات', 'تعرف شكد عندك قبل لا يخلص', ['كل بيعة تخصم مكونات وصفتها تلقائياً', 'تنبيه قبل النفاد بحد لكل مادة', 'جرد وهدر، والرصيد ما ينزل تحت الصفر']],
  ['camera', 'المشتريات', 'استلام البضاعة بدقة', ['استلام يدوي أو بتصوير فاتورة المورد', 'الدفع من درج الوردية أو من خارجه', 'تصحيح الغلط بحركة واضحة، بلا حذف']],
  ['cash', 'الورديات والدرج', 'الدرج يطابق آخر اليوم', ['المتوقع بالدرج مقابل الموجود', 'كل سحب وإدخال بسببه واسم صاحبه', 'إغلاق الوردية بتقرير جاهز']],
  ['clock', 'الحضور والدوام', 'شاشة حضور على جهاز الكاشير', ['الموظف يدوس اسمه ويكتب رمزه', 'جدول دوام: التأخير والغياب والإضافي تلقائياً', 'إجازات برصيد سنوي وموافقة المدير']],
  ['wallet', 'الرواتب', 'راتب كل شهر بلا نقاش', ['قسيمة مفصّلة تنطبع أو تنرسل واتساب', 'السحب من الراتب ينخصم بنهاية الشهر', 'الصرف ينسجل مصروفاً ويقفل الشهر']],
  ['chart', 'التقارير وصافي الربح', 'ربحك الحقيقي كل يوم', ['صافي الربح بعد التكلفة والمصاريف والرواتب', '«وين راحت فلوسك؟» بصفحة وحدة', 'تقرير يومي للطباعة 80 مم أو واتساب']],
  ['star', 'العملاء والولاء', 'زبونك معروف برقمه', ['سجل كل زبون ومشترياته', 'نقاط تنجمع مع كل طلب وتنصرف خصماً', 'خصومات جاهزة بلمسة']],
  ['branch', 'الفروع', 'أكثر من مقهى بحساب واحد', ['كل فرع بمخزونه وموظفيه', 'تبديل الفرع على الجهاز للمالك', 'تقرير مجمّع لكل الفروع']],
  ['wifi', 'بلا إنترنت', 'البيع ما يوقف أبداً', ['المبيعات تنحفظ على الجهاز', 'تنرسل وحدها أول ما يرجع الاتصال', 'وكل بيعة تنحسب لورديتها الصحيحة']],
];

const AUDIENCE = [
  ['cup', 'الكافيهات والكوفي شوب', ['إضافات الحليب والشوتات بلمسة', 'الوصفة تخصم البن والحليب والكوب', 'نقاط تخلي الزبون يرجع']],
  ['table', 'المطاعم', ['خريطة طاولات وتذكرة لكل طاولة', 'شاشة تحضير للمطبخ بالترتيب', 'تقسيم الدفع بين نقد وكي']],
  ['bolt', 'الخدمة السريعة', ['طلب ودفع بثواني، والطابور يمشي', 'الصنف الخلصان يطلع «نفد» ويمنع بيعه', 'تقرير الساعات الأكثر زحمة']],
  ['bean', 'المخابز والحلويات', ['مخزون المكونات والهدر اليومي', 'استلام البضاعة وتكلفتها الحقيقية', 'ربح كل صنف بعد تكلفته']],
];

const SHOTS = [
  ['pos', 'البيع', 'شاشة البيع', 'أصناف مربعة واضحة ونافذة طلب بأسطر فيها − و +، مصممة للآيباد بلا تمرير.'],
  ['floor', 'الطاولات', 'خريطة الطاولات', 'احفظ الطلب على طاولته: المشغولة تبين بمبلغها، والفارغة تختارها بلمسة.'],
  ['kds', 'التحضير', 'شاشة التحضير', 'الباريستا يشوف الطلبات بالترتيب ومن شكد دقيقة تنتظر، ويبدأ التحضير بلمسة.'],
  ['inventory', 'المخزون', 'المخزون', 'قيمة المخزون، والمواد تحت حد التنبيه، والرصيد والتكلفة لكل مادة.'],
  ['dashboard', 'المتابعة', 'لوحة المتابعة', 'صافي المبيعات والربح، والمبيعات حسب الساعة، وأفضل أيام العمل.'],
  ['hr-team', 'الموظفون', 'الموظفون والأداء', 'الساعات والأيام والتأخير والإضافي والمبيعات لكل موظف.'],
  ['hr-payroll', 'الرواتب', 'كشف الرواتب', 'المستحق والخصومات والسحوبات لكل موظف، وصرف بلمسة يقفل الشهر.'],
  ['daily', 'التقرير اليومي', 'التقرير اليومي', 'مبيعات اليوم والموارد المصروفة والإلغاءات، للطباعة أو المشاركة.'],
];

const PAINS = [
  'فرق بنقد الدرج آخر اليوم، وما تعرف وين راح',
  'الحليب والبن يخلصون بنص الدوام بلا إنذار',
  'الحضور والسحوبات بالدفتر، والراتب كل شهر فيه نقاش',
  'تبيع كل يوم… بس ما تعرف ربحك الحقيقي',
];

const WHY = [
  ['bolt', 'سرعة بكل طلب', 'مصمم لإيقاع الكوفي شوب: الطلب بلمستين والدفع بلمسة.'],
  ['shield', 'حسابات مضمونة', 'كل تحديث يمر بفحوصات آلية ومحاكاة أيام عمل كاملة قبل ما يوصلك.'],
  ['chart', 'أرقام تفهمها', 'صافي ربحك ووين راحت فلوسك، بالدينار وبدون كسور.'],
  ['wifi', 'يشتغل بلا إنترنت', 'انقطاع الإنترنت ما يوقف البيع، وكل شي يتزامن وحده.'],
  ['lock', 'بياناتك إلك وحدك', 'كل مقهى معزول تماماً، ولكل موظف رمزه وصلاحياته.'],
];

const KINDS = { cafe: 'الكافيهات', restaurant: 'المطاعم', quick: 'الخدمة السريعة' };
const PLAN_FEATURES = {
  cafe: ['نقاط البيع والإضافات', 'المخزون والوصفات', 'العملاء والنقاط', 'الموظفون والحضور والرواتب', 'التقارير وصافي الربح', 'العمل بلا إنترنت'],
  restaurant: ['نقاط البيع وخريطة الطاولات', 'شاشة التحضير للمطبخ', 'المخزون والوصفات والمشتريات', 'الموظفون والحضور والرواتب', 'التقارير وصافي الربح', 'العمل بلا إنترنت'],
  quick: ['كاشير سريع ودفع مقسّم', 'شاشة التحضير', 'منع بيع الصنف الخلصان', 'الورديات والدرج', 'التقارير حسب الساعة', 'العمل بلا إنترنت'],
};

const FAQ = [
  ['شنو الأجهزة اللي أحتاجها؟', 'آيباد أو أي تابلت أو حاسبة بمتصفح حديث. طابعة الإيصالات 80 مم اختيارية، والتقرير اليومي ينرسل واتساب حتى بدون طابعة.'],
  ['إذا انقطع الإنترنت، شيصير؟', 'البيع يستمر عادي. المبيعات تنحفظ على الجهاز وتنرسل وحدها أول ما يرجع الاتصال، وكل بيعة تنحسب لورديتها الصحيحة.'],
  ['شلون أدفع الاشتراك؟', 'بالتحويل أو نقداً. بعد ما تسوي حسابك ترسل طلب الاشتراك من داخل البرنامج، ونفعّله لك أول ما نأكد الدفع.'],
  ['هل أكو عقد أو التزام طويل؟', 'لا. تختار شهري أو سنوي، وتجدد وقت ما تريد. وإذا انتهى الاشتراك تبقى بياناتك وتقاريرك محفوظة.'],
  ['عندي أكثر من فرع، يجمعها البرنامج؟', 'إي. كل فرع بمخزونه وموظفيه، والمالك يبدّل بين الفروع ويشوف تقرير مجمّع لكلها.'],
  ['بياناتي آمنة؟', 'كل مقهى معزول تماماً عن غيره، والدخول من جهاز جديد يحتاج بريد المالك وكلمة مروره، ولكل موظف رمزه وصلاحياته، وكل عملية حساسة تنسجل.'],
  ['شكد ياخذ التشغيل؟', 'تسوي الحساب وتضيف أصنافك وتبدي تبيع بنفس اليوم. وإذا تحب، نساعدك بالإعداد بعرض مجاني.'],
  ['أقدر أجرّب قبل ما أشترك؟', 'إي. احجز عرضك المجاني ونوريك البرنامج على مقهاك، أو جرّب النسخة التجريبية بنفسك.'],
  ['شلون الدعم الفني؟', 'دعم بالعربي على واتساب، وتحديثات مستمرة بدون كلفة إضافية.'],
];

// ---------------------------------------------------------------- أجزاء مشتركة
function nav(s) {
  const links = [['modules', 'المنصة'], ['inside', 'من داخل البرنامج'], ['audience', 'لمن مور كاش'], ['pricing', 'الأسعار'], ['faq', 'الأسئلة']];
  return `<header class="st-nav ${s.menu ? 'open' : ''}"><div class="st-wrap st-nav-in">
    <a class="st-logo" href="#/" aria-label="مور كاش — الرئيسية">${mark()}<span>مور كاش</span></a>
    <nav class="st-links" aria-label="أقسام الموقع">${links.map(([id, t]) => `<button type="button" data-action="st-go" data-to="${id}">${t}</button>`).join('')}</nav>
    <div class="st-nav-cta">
      <a class="st-btn ghost sm hide-xs" href="${href('login')}">تسجيل الدخول</a>
      <a class="st-btn dark sm" href="${href('book')}">احجز عرضك</a>
      <button type="button" class="st-burger" data-action="st-menu" aria-label="القائمة" aria-expanded="${s.menu}">${icon(s.menu ? 'x' : 'list')}</button>
    </div></div>
    <div class="st-drawer">${links.map(([id, t]) => `<button type="button" data-action="st-go" data-to="${id}">${t}</button>`).join('')}<a href="${href('login')}">تسجيل الدخول</a></div>
  </header>`;
}

const eyebrow = (t) => `<p class="st-eyebrow"><span></span>${t}<span></span></p>`;
const head = (eb, h, p = '') => `<div class="st-head">${eyebrow(eb)}<h2>${h}</h2>${p ? `<p>${p}</p>` : ''}</div>`;

function waFloat() {
  const link = wa(WA_HELLO);
  return link ? `<a class="st-wa" href="${link}" target="_blank" rel="noopener" aria-label="تواصل واتساب">${icon('chat')}</a>` : '';
}

function footer() {
  const link = wa(WA_HELLO);
  return `<footer class="st-foot"><div class="st-wrap">
    <div class="st-final">
      <span class="st-final-mark">${mark()}</span>
      <h2>جاهز تفتح الدرج؟</h2>
      <p>احجز عرضك المجاني، ونوريك مور كاش على مقهاك.</p>
      <div class="st-cta-row"><a class="st-btn dark lg" href="${href('book')}">احجز عرضك المجاني</a>${link ? `<a class="st-btn light lg" href="${link}" target="_blank" rel="noopener">${icon('chat', 'sm')} تواصل واتساب</a>` : ''}</div>
    </div>
    <div class="st-foot-row">
      <a class="st-logo" href="#/">${mark()}<span>مور كاش</span></a>
      <span class="st-foot-tag">كاشير وإدارة للمقاهي والمطاعم</span>
      <span class="spacer"></span>
      <a href="${href('login')}">تسجيل الدخول</a><a href="${href('signup')}">إنشاء حساب</a><a href="${href('book')}">احجز عرضك</a>
      <span class="st-copy">© ${new Date().getFullYear()} مور كاش</span>
    </div>
  </div></footer>`;
}

// ---------------------------------------------------------------- الصفحة الرئيسية
function hero() {
  const link = wa(WA_HELLO);
  // النسخة التجريبية (المقهى يعمل داخل المتصفح): الزر الثاني يدخل المقهى التجريبي مباشرة
  const second = globalThis.MORECASH_BACKEND ? '<button type="button" class="st-btn light lg" data-action="demo-enter">ادخل المقهى التجريبي</button>'
    : link ? `<a class="st-btn light lg" href="${link}" target="_blank" rel="noopener">${icon('chat', 'sm')} تواصل واتساب</a>`
      : `<a class="st-btn light lg" href="${SAME_ORIGIN() ? '/demo.html' : `${LIVE_URL}/demo.html`}">جرّب النسخة التجريبية</a>`;
  return `<section class="st-hero"><div class="st-wrap">
    <p class="st-pill">${icon('bean', 'sm')} نظام كاشير وإدارة للمقاهي والمطاعم في العراق</p>
    <h1>كل يوم بمقهاك…<br><em>بنظام واحد</em></h1>
    <p class="st-lead">مور كاش يجمع الكاشير، والطاولات، وشاشة التحضير، والمخزون، والموظفين والرواتب، والتقارير. بالعربي، على الآيباد، وبالدينار بلا كسور.</p>
    <div class="st-cta-row"><a class="st-btn dark lg" href="${href('book')}">احجز عرضك المجاني</a>${second}</div>
    <dl class="st-stats">
      <div><dt>بلمستين</dt><dd>من اختيار الصنف للطلب</dd></div>
      <div><dt>0</dt><dd>فروقات بين الدرج والمخزون والتقارير</dd></div>
      <div><dt>بلا إنترنت</dt><dd>البيع ما يوقف أبداً</dd></div>
    </dl>
    <div class="st-device-wrap">
      <div class="st-device"><img src="${img('pos')}" alt="شاشة البيع في مور كاش: أصناف مربعة ونافذة طلب" width="1600" height="1199"></div>
      <div class="st-chip c1"><span class="dot ok"></span><div><b>طاولة 6</b><small>مشغولة · 12,500 د.ع</small></div></div>
      <div class="st-chip c2"><span class="ic">${icon('alert', 'sm')}</span><div><b>تنبيه المخزون</b><small>الحليب قارب ينفد</small></div></div>
      <div class="st-chip c3"><span class="ic olive">${icon('chart', 'sm')}</span><div><b>صافي ربح اليوم</b><small>محسوب بعد التكلفة والمصاريف</small></div></div>
    </div>
  </div></section>`;
}

function trusted(info) {
  const list = info?.trusted ?? [];
  const cells = list.length
    ? list.map((t) => `<div class="st-logo-card"><b>${esc(t.name)}</b>${t.city ? `<small>${esc(t.city)}</small>` : ''}</div>`).join('')
    : Array.from({ length: 4 }, () => '<div class="st-logo-card empty"><b>مقهاك هنا</b><small>كن من أوائل المشتركين</small></div>').join('');
  return `<section class="st-trusted"><div class="st-wrap">${eyebrow('يثقون بمور كاش')}<div class="st-logos">${cells}</div></div></section>`;
}

function challenge() {
  return `<section class="st-sec" id="challenge"><div class="st-wrap">
    ${head('التحدي والحل', 'دفتر وذاكرة… والفلوس تضيع بالنص', 'المقهى يشتغل كل يوم، بس الحسابات مبعثرة بين الدرج والدفتر وراس صاحب المحل.')}
    <div class="st-pains">${PAINS.map((p) => `<div class="st-pain"><span>${icon('x', 'sm')}</span>${p}</div>`).join('')}</div>
    <div class="st-solution"><div><h3>الحل؟ نظام واحد يربط كل شي</h3><p>البيع يخصم المخزون، والرواتب تدخل المصروفات، وكل دينار يطلع بصافي الربح. بلا إدخال مرتين.</p></div>
      <button type="button" class="st-btn dark" data-action="st-go" data-to="modules">شوف وحدات المنصة ${icon('arrow', 'sm')}</button></div>
  </div></section>`;
}

function modules() {
  return `<section class="st-sec alt" id="modules"><div class="st-wrap">
    ${head('وحدات المنصة', 'كل شي متصل… بنظام واحد', 'اثنا عشر وحدة تشتغل سوا من أول طلب لحد صرف الرواتب، وكلها مشمولة بالاشتراك.')}
    <div class="st-mods">${MODULES.map(([ic, t, d, more]) => `<details class="st-mod"><summary>
        <span class="st-mod-ic">${icon(ic)}</span><h3>${t}</h3><p>${d}</p><span class="st-more">اعرف أكثر <i>+</i></span></summary>
        <ul>${more.map((m) => `<li>${icon('check', 'sm')}${m}</li>`).join('')}</ul></details>`).join('')}</div>
  </div></section>`;
}

function inside(s) {
  const cur = SHOTS.find(([k]) => k === s.shot) ?? SHOTS[0];
  return `<section class="st-sec" id="inside"><div class="st-wrap">
    ${head('من داخل البرنامج', 'شاشات حقيقية، مو تصاميم', 'هذي لقطات من مور كاش نفسه على الآيباد. اختار الشاشة وشوف.')}
    <div class="st-tabs" role="tablist">${SHOTS.map(([k, t]) => `<button type="button" role="tab" aria-selected="${k === cur[0]}" class="${k === cur[0] ? 'on' : ''}" data-action="st-shot" data-k="${k}">${t}</button>`).join('')}</div>
    <figure class="st-shot">
      <div class="st-device big"><img src="${img(cur[0])}" alt="${esc(cur[2])}" width="1600" height="1199" loading="lazy"></div>
      <figcaption><b>${cur[2]}</b><span>${cur[3]}</span></figcaption>
    </figure>
  </div></section>`;
}

function spotlight(id, eb, h, p, points, image, alt, flip = false) {
  return `<section class="st-sec ${flip ? 'alt' : ''}" id="${id}"><div class="st-wrap st-split ${flip ? 'flip' : ''}">
    <div class="st-split-text">${eyebrow(eb)}<h2>${h}</h2><p>${p}</p>
      <ul class="st-checks">${points.map(([t, d]) => `<li><span>${icon('check', 'sm')}</span><div><b>${t}</b><small>${d}</small></div></li>`).join('')}</ul></div>
    <div class="st-device"><img src="${img(image)}" alt="${alt}" width="1600" height="1199" loading="lazy"></div>
  </div></section>`;
}

function audience() {
  return `<section class="st-sec alt" id="audience"><div class="st-wrap">
    ${head('لمن مور كاش؟', 'مصمم لكل أنواع المحلات', 'من الكوفي شوب الصغير لسلسلة الفروع، مور كاش يدير يوم العمل كامل.')}
    <div class="st-aud">${AUDIENCE.map(([ic, t, pts]) => `<article class="st-aud-card"><span class="st-mod-ic">${icon(ic)}</span><h3>${t}</h3>
      <ul>${pts.map((p) => `<li>${icon('check', 'sm')}${p}</li>`).join('')}</ul></article>`).join('')}</div>
  </div></section>`;
}

function why() {
  return `<section class="st-sec" id="why"><div class="st-wrap">
    ${head('لماذا مور كاش', 'خمسة أسباب تخليه الخيار الأول')}
    <div class="st-why">${WHY.map(([ic, t, d], i) => `<article><span class="n">0${i + 1}</span><span class="st-mod-ic">${icon(ic)}</span><h3>${t}</h3><p>${d}</p></article>`).join('')}</div>
    <p class="st-why-foot">${icon('chat', 'sm')} ودعم عربي محلي يفهمك ويرد بسرعة</p>
  </div></section>`;
}

function testimonials(info) {
  const list = info?.testimonials ?? [];
  const cards = list.length
    ? list.map((t) => `<figure class="st-quote"><span class="q">”</span><blockquote>${esc(t.quote)}</blockquote>
        <figcaption><span class="av">${esc([...t.name][0] ?? '')}</span><div><b>${esc(t.name)}</b>${t.shop ? `<small>${esc(t.shop)}</small>` : ''}</div></figcaption></figure>`).join('')
    : Array.from({ length: 3 }, () => `<figure class="st-quote empty"><span class="q">”</span><blockquote>مساحة لرأي أحد عملائنا</blockquote>
        <figcaption><span class="av"></span><div><b>اسم صاحب المقهى</b><small>اسم المقهى · المدينة</small></div></figcaption></figure>`).join('');
  return `<section class="st-sec alt" id="voices"><div class="st-wrap">
    ${head('آراء العملاء', 'اللي يشتغلون بمور كاش')}
    <div class="st-quotes">${cards}</div>
  </div></section>`;
}

function pricing(s) {
  const yearly = s.bill === 'year';
  const link = wa('مرحباً، عندي أكثر من فرع وأريد سعر مور كاش للسلسلة.');
  return `<section class="st-sec" id="pricing"><div class="st-wrap">
    ${head('الباقات والأسعار', 'سعر واضح… كل شي مشمول', 'كل الوحدات · تحديثات مستمرة · دعم بالعربي')}
    <div class="st-seg-row">
      <div class="st-seg" role="tablist">${Object.entries(KINDS).map(([k, t]) => `<button type="button" class="${s.kind === k ? 'on' : ''}" data-action="st-kind" data-k="${k}">${t}</button>`).join('')}</div>
      <div class="st-bill"><button type="button" class="${!yearly ? 'on' : ''}" data-action="st-bill" data-k="month">شهري</button>
        <button type="button" class="${yearly ? 'on' : ''}" data-action="st-bill" data-k="year">سنوي <span class="save">وفّر شهرين</span></button></div>
    </div>
    <div class="st-plans">
      <article class="st-plan main">
        <span class="st-badge">الأكثر طلباً</span>
        <h3>مور كاش الكامل</h3><p class="muted">لـ${KINDS[s.kind]} · لكل فرع</p>
        <p class="st-price"><b>${num(yearly ? PRICE.year : PRICE.month)}</b><span>د.ع / ${yearly ? 'سنوياً' : 'شهرياً'}</span></p>
        <p class="st-price-note">${yearly ? `بدل ${num(PRICE.month * 12)} د.ع — توفّر ${num(PRICE.month * 12 - PRICE.year)} د.ع` : `أو ${num(PRICE.year)} د.ع سنوياً وتوفّر شهرين`}</p>
        <ul>${PLAN_FEATURES[s.kind].map((f) => `<li>${icon('check', 'sm')}${f}</li>`).join('')}</ul>
        <a class="st-btn dark block" href="${href('book')}">احجز عرضك المجاني</a>
      </article>
      <article class="st-plan">
        <h3>السلاسل والفروع</h3><p class="muted">أكثر من 3 فروع</p>
        <p class="st-price"><b class="custom">سعر خاص</b></p>
        <p class="st-price-note">حسب عدد الفروع والأجهزة</p>
        <ul><li>${icon('check', 'sm')}كل ما في «مور كاش الكامل»</li><li>${icon('check', 'sm')}تقرير مجمّع لكل الفروع</li><li>${icon('check', 'sm')}مساعدة بالإعداد ونقل القائمة</li><li>${icon('check', 'sm')}متابعة مباشرة على واتساب</li></ul>
        ${link ? `<a class="st-btn light block" href="${link}" target="_blank" rel="noopener">${icon('chat', 'sm')} تواصل واتساب</a>` : `<a class="st-btn light block" href="${href('book')}">اطلب عرض سعر</a>`}
      </article>
    </div>
  </div></section>`;
}

function faq() {
  return `<section class="st-sec alt" id="faq"><div class="st-wrap st-narrow">
    ${head('الأسئلة الشائعة', 'كل اللي تحتاج تعرفه قبل ما تبدي')}
    <div class="st-faq">${FAQ.map(([q, a], i) => `<details ${i === 0 ? 'open' : ''}><summary>${q}<i>+</i></summary><p>${a}</p></details>`).join('')}</div>
  </div></section>`;
}

export function siteView(s) {
  const st = S();
  loadSite();
  return `<div class="st" id="st-top">${nav(st)}${hero()}${trusted(st.info)}${challenge()}${modules()}${inside(st)}
    ${spotlight('floor', 'المبيعات والصالة', 'كاشير أسرع… وصالة مرتبة', 'من الطاولة للتحضير للدفع، تدفق واحد واضح بلا أوراق.',
      [['خريطة الطاولات', 'المشغولة بمبلغها والفارغة بلمسة'], ['من الطاولة للباريستا', 'الطلب يوصل لشاشة التحضير لحظة الدفع'], ['دفع مقسّم', 'نقد وكي بنفس الطلب، والباقي محسوب']], 'floor', 'خريطة الطاولات عند حفظ الطلب')}
    ${spotlight('team', 'الموظفون والرواتب', 'رواتب تنحسب وحدها', 'الحضور من جهاز الكاشير، والتأخير والإضافي والسحوبات تنحسب تلقائياً لحد القسيمة.',
      [['حضور برمز الموظف', 'شاشة وحدة على الكاشير لكل الموظفين'], ['سحب من الراتب', 'ينخصم من راتب نفس الشهر بنهايته'], ['قسيمة مفصّلة', 'تنطبع أو تنرسل واتساب، والصرف يقفل الشهر']], 'hr-payroll', 'كشف الرواتب في مور كاش', true)}
    ${audience()}${why()}${testimonials(st.info)}${pricing(st)}${faq()}${footer()}${waFloat()}</div>`;
}

// ---------------------------------------------------------------- صفحة «احجز عرضك المجاني»
export function bookView() {
  const st = S();
  loadSite();
  st.clientId ??= crypto.randomUUID();
  const link = wa('مرحباً، أريد أحجز عرض مجاني لمور كاش.');
  const body = st.sent
    ? `<div class="st-done">${icon('check')}<h1>وصل طلبك، شكراً!</h1><p>نتواصل وياك قريباً على رقمك حتى نحدد موعد العرض.</p>
        <div class="st-cta-row">${link ? `<a class="st-btn light lg" href="${link}" target="_blank" rel="noopener">${icon('chat', 'sm')} أو راسلنا واتساب هسه</a>` : ''}<a class="st-btn dark lg" href="#/">الرجوع للرئيسية</a></div></div>`
    : DEMO_PAGE() && !SAME_ORIGIN()
      ? `<div class="st-done"><h1>احجز عرضك المجاني</h1><p>الحجز يتم من موقع مور كاش.</p><a class="st-btn dark lg" href="${href('book')}">افتح صفحة الحجز</a></div>`
      : `<form class="st-form" data-form="st-lead" data-keep novalidate>
        <div class="grid-2">
          ${field('اسمك', '<input name="name" id="ld-name" required minlength="2" maxlength="60" autocomplete="name">')}
          ${field('رقم الهاتف (واتساب)', '<input name="phone" id="ld-phone" required inputmode="tel" dir="ltr" maxlength="20" placeholder="07xxxxxxxxx" autocomplete="tel">')}
        </div>
        ${field('اسم المقهى أو المطعم', '<input name="shop" id="ld-shop" required minlength="2" maxlength="80" autocomplete="organization">')}
        <div class="grid-2">
          ${field('نوع المحل', `<select name="type" id="ld-type">${[['cafe', 'كافيه / كوفي شوب'], ['restaurant', 'مطعم'], ['quick', 'خدمة سريعة'], ['bakery', 'مخبز / حلويات'], ['other', 'غير ذلك']].map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select>`)}
          ${field('عدد الفروع', '<select name="branches" id="ld-branches"><option value="1">فرع واحد</option><option value="2">2</option><option value="3">3</option><option value="5">4 – 5</option><option value="10">أكثر من 5</option></select>')}
        </div>
        <div class="grid-2">
          ${field('المدينة', '<input name="city" id="ld-city" maxlength="40" placeholder="بغداد، البصرة، أربيل…">')}
          ${field('الوقت المناسب للتواصل', '<select name="when" id="ld-when"><option value="">أي وقت</option><option>الصبح</option><option>الظهر</option><option>المساء</option></select>')}
        </div>
        ${field('ملاحظة (اختياري)', '<textarea name="note" id="ld-note" rows="3" maxlength="500" placeholder="شنو أكثر شي تحتاجه بمحلك؟"></textarea>')}
        <input type="text" name="website" tabindex="-1" autocomplete="off" class="st-hp" aria-hidden="true">
        <button class="st-btn dark lg block" type="submit" ${state.busy ? 'disabled' : ''}>أرسل الطلب</button>
        ${link ? `<a class="st-btn light block" href="${link}" target="_blank" rel="noopener">${icon('chat', 'sm')} أو احجز على واتساب مباشرة</a>` : ''}
        <p class="st-form-note">${icon('lock', 'sm')} نستخدم رقمك فقط للتواصل بخصوص العرض.</p>
      </form>`;
  return `<div class="st st-book">${nav(st)}
    <section class="st-book-in"><div class="st-wrap st-book-grid">
      <div class="st-book-side">${eyebrow('عرض تجريبي مجاني')}<h1>شوف مور كاش على مقهاك</h1>
        <p>عبّي بياناتك ونتواصل وياك نحدد موعد. نوريك البرنامج على أصنافك وطريقة شغلك، بدون أي التزام.</p>
        <ul class="st-checks">${[['عرض على مقهاك', 'بأصنافك وأسعارك، مو عرض عام'], ['مساعدة بالإعداد', 'نضيف قائمتك ونجهز الأجهزة وياك'], ['بدون التزام', 'تقرر بعد ما تشوف بنفسك']].map(([t, d]) => `<li><span>${icon('check', 'sm')}</span><div><b>${t}</b><small>${d}</small></div></li>`).join('')}</ul>
      </div>
      <div class="st-book-card">${body}</div>
    </div></section>${waFloat()}</div>`;
}

// ---------------------------------------------------------------- التفاعل
function scrollToSection(id) {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

on({
  'st-go': (el) => {
    const id = el.dataset.to;
    S().menu = false;
    if (location.hash && location.hash !== '#/' && location.hash !== '#') {
      location.hash = '#/';
      setTimeout(() => scrollToSection(id), 120);
      return;
    }
    render();
    requestAnimationFrame(() => scrollToSection(id));
  },
  'st-menu': () => { S().menu = !S().menu; render(); },
  'st-shot': (el) => { S().shot = el.dataset.k; render(); },
  'st-bill': (el) => { S().bill = el.dataset.k; render(); },
  'st-kind': (el) => { S().kind = el.dataset.k; render(); },
  'st-lead': (_el, _e, d) => busy(async () => {
    const st = S();
    await post('/api/leads', {
      clientId: st.clientId, name: d.name, shop: d.shop, type: d.type, branches: Number(d.branches) || 1,
      phone: d.phone, city: d.city || null, when: d.when || null, note: d.note || null, website: d.website || '',
    });
    st.sent = true;
    st.clientId = null;
    document.getElementById('app')?.scrollTo({ top: 0, behavior: 'smooth' });
  }),
});
