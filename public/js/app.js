// التشغيل، التوجيه، شاشتا الإعداد والدخول، والهيكل العام.
import { esc } from '../../shared/format.js';
import { get, post } from './api.js';
import { icon } from './icons.js';
import { bindEvents, busy, can, errorText, fail, field, initials, on, render, set, setViews, state, toast } from './ui.js';
import * as pos from './views/pos.js';
import * as receipts from './views/receipts.js';
import * as ops from './views/ops.js';
import * as admin from './views/admin.js';
import * as account from './views/account.js';
import * as platform from './views/platform.js';
import { mark } from './brand.js';
import { flushSales, initOffline, rememberSession, savedSession } from './offline.js';

const modules = [pos, receipts, ops, admin, account, platform];
const routes = Object.assign({}, ...modules.map((m) => m.routes ?? {}));
const modals = Object.assign({}, ...modules.map((m) => m.modals ?? {}));

const NAV = [
  ['pos', 'البيع', 'sale', 'pos.sell'],
  ['receipts', 'الإيصالات', 'receipt', 'receipts.view'],
  ['kds', 'التحضير', 'cup', 'kds.use'],
  ['shift', 'الوردية', 'clock', 'shift.manage'],
  ['customers', 'العملاء', 'users', 'customers.manage'],
  ['admin', 'الإدارة', 'chart', 'admin.reports'],
];

function defaultRoute() {
  return NAV.find(([, , , p]) => can(p))?.[0] ?? 'kds';
}

function parseHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  return { route: parts[0] || '', sub: parts[1] || '', id: parts[2] || parts[1] || '' };
}

export async function navigate() {
  const { route, sub, id } = parseHash();
  if (route === 'platform') { state.modal = null; render(); return platform.enterPlatform(); }
  if (!state.employee) { state.authPage = route; state.modal = null; return render(); }
  const name = route || defaultRoute();
  const allowed = NAV.find(([r]) => r === name);
  if (allowed && !can(allowed[3]) && !(name === 'admin' && can('admin.catalog'))) {
    location.hash = `#/${defaultRoute()}`;
    return undefined;
  }
  state.route = name;
  state.params = { sub, id };
  state.modal = null;
  render();
  const mod = modules.find((m) => m.routes?.[name]);
  if (mod?.enter) await mod.enter(state.params).catch(fail);
  return render();
}

// ---------------------------------------------------------------- العرض
export const views = {
  app(s) {
    if (!s.ready) return '<div class="auth-panel" style="height:100%"><p class="muted">جارٍ التحميل…</p></div>';
    if (s.fatal) return `<div class="auth-panel" style="height:100%"><div class="card pad stack" style="max-width:520px">${icon('alert')}<h2>لا يمكن تشغيل النظام الآن</h2><p>${esc(s.fatal)}</p><button class="btn primary" data-action="reload">إعادة المحاولة</button></div></div>`;
    if (parseHash().route === 'platform') return platform.platformView(s);
    if (s.shop?.disabled) return account.disabledView(s);
    if (!s.employee) return account.gateView(s);
    const body = (routes[s.route] ?? routes.pos)(s);
    return `<div class="shell">${railView(s)}<main class="main" id="main">${body}</main></div>`;
  },
  modal(s) {
    const fn = modals[s.modal?.type];
    return fn ? fn(s) : '';
  },
};

function railView(s) {
  const links = NAV.filter(([r, , , p]) => can(p) || (r === 'admin' && can('admin.catalog'))).map(([r, label, ic]) => {
    const low = s.catalog?.lowStock?.length ?? 0;
    const badge = r === 'pos' && s.ticketsCount ? `<span class="badge">${s.ticketsCount}</span>`
      : r === 'admin' && low && can('admin.inventory') ? `<span class="badge bad" title="مواد تحت حد التنبيه">${low}</span>` : '';
    return `<a href="#/${r}" class="${s.route === r ? 'on' : ''}" ${s.route === r ? 'aria-current="page"' : ''}>${icon(ic)}<span>${label}</span>${badge}</a>`;
  }).join('');
  return `<nav class="rail" aria-label="التنقل الرئيسي">
    ${mark()}
    ${links}
    <div class="me">
      ${globalThis.MORECASH_BACKEND ? '<span class="demo-tag" title="البيانات في هذا المتصفح فقط">تجريبي</span>' : ''}
      <div class="avatar" title="${esc(s.employee.name)}">${esc(initials(s.employee.name))}</div>
      <span class="small" style="font-size:.7rem;text-align:center">${esc(s.employee.name)}</span>
      ${canFullscreen() ? `<button data-action="fullscreen" title="ملء الشاشة">${icon(isFullscreen() ? 'shrink' : 'expand', 'sm')}<span>${isFullscreen() ? 'تصغير' : 'تكبير'}</span></button>` : ''}
      <button data-action="lock" title="قفل الشاشة">${icon('lock', 'sm')}<span>قفل</span></button>
    </div>
  </nav>`;
}

// ---------------------------------------------------------------- ملء الشاشة (الآيباد والمتصفحات المكتبية؛ الآيفون لا يدعمه فيُخفى الزر)
const doc = typeof document !== 'undefined' ? document : null;
const canFullscreen = () => Boolean(doc && (doc.fullscreenEnabled || doc.webkitFullscreenEnabled));
const isFullscreen = () => Boolean(doc && (doc.fullscreenElement || doc.webkitFullscreenElement));
async function toggleFullscreen() {
  const el = doc.documentElement;
  try {
    if (isFullscreen()) await (doc.exitFullscreen ?? doc.webkitExitFullscreen).call(doc);
    else await (el.requestFullscreen ?? el.webkitRequestFullscreen).call(el, { navigationUI: 'hide' });
  } catch { toast('تعذّر ملء الشاشة. على الآيباد: شارك ← إضافة إلى الشاشة الرئيسية', 'bad'); }
}
if (doc) for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) doc.addEventListener(ev, () => render());

// ---------------------------------------------------------------- الإجراءات العامة
async function loadSession(employee) {
  state.employee = employee;
  state.view = {};
  if (state.online !== false) rememberSession(state.shop, employee);
  if (can('pos.sell') || can('kds.use')) await pos.loadBootstrap().catch(fail);
  await navigate();
  flushSales();
}

on({
  'pin-key': (el) => {
    const pin = state.view.pin ?? '';
    if (pin.length < 6) set({ view: { ...state.view, pin: pin + el.dataset.k, pinShake: false } });
    if ((state.view.pin ?? '').length === 6) submitPin();
  },
  'pin-back': () => set({ view: { ...state.view, pin: (state.view.pin ?? '').slice(0, -1) } }),
  'pin-clear': () => set({ view: { ...state.view, pin: '' } }),
  'pin-submit': () => submitPin(),
  keydown: (_el, e) => {
    if (state.employee || !state.shop || state.modal) return;
    if (document.activeElement?.tagName === 'INPUT') return;
    // لوحة مفاتيح عربية: ٠-٩ و۰-۹ تُقبل كأرقام
    const digit = /^[0-9]$/.test(e.key) ? e.key : /^[٠-٩]$/.test(e.key) ? String(e.key.charCodeAt(0) - 0x0660) : /^[۰-۹]$/.test(e.key) ? String(e.key.charCodeAt(0) - 0x06f0) : null;
    if (digit) { const pin = state.view.pin ?? ''; if (pin.length < 6) set({ view: { ...state.view, pin: pin + digit } }); }
    else if (e.key === 'Backspace') set({ view: { ...state.view, pin: (state.view.pin ?? '').slice(0, -1) } });
    else if (e.key === 'Enter') submitPin();
  },
  lock: async () => {
    if (state.online === false) { toast('لا يمكن تبديل الموظف بدون إنترنت. البيع مستمر باسم الموظف الحالي.', 'bad'); return; }
    await post('/api/auth/logout', {}).catch(() => {});
    rememberSession(state.shop, null);
    state.employee = null;
    state.modal = null;
    state.view = { pin: '' };
    render();
  },
  fullscreen: () => toggleFullscreen(),
  'close-modal': () => set({ modal: null }),
  reload: () => location.reload(),
  'modal-back': () => set({ modal: null }),
});

async function submitPin() {
  const pin = state.view.pin ?? '';
  if (pin.length < 4) return;
  await busy(async () => {
    try {
      const r = await post('/api/auth/pin', { pin });
      await loadSession(r.employee);
    } catch (e) {
      state.view = { pin: '', pinShake: true };
      throw e;
    }
  });
}

account.initAccount({ loadSession });

export async function boot() {
  setViews(views);
  bindEvents(document.getElementById('app'));
  window.addEventListener('hashchange', () => navigate());
  initOffline();
  try {
    const s = await get('/api/state');
    state.online = true;
    rememberSession(s.shop, s.employee);
    state.shop = s.shop;
    state.authPage = parseHash().route;
    state.ready = true;
    if (parseHash().route === 'platform') await navigate();
    else if (s.employee) await loadSession(s.employee);
    else render();
  } catch (e) {
    state.ready = true;
    // بلا إنترنت: يفتح المقهى المحفوظ على هذا الجهاز باسم آخر موظف، والمبيعات تُحفظ حتى يعود الاتصال
    const saved = e.code === 'NETWORK' ? savedSession() : null;
    if (saved?.shop) {
      state.online = false;
      state.shop = saved.shop;
      if (saved.employee) { await loadSession(saved.employee); return; }
      render();
      return;
    }
    if (e.code === 'DB_NOT_CONFIGURED' || e.code === 'DB_UNAVAILABLE' || e.code === 'NETWORK') state.fatal = errorText(e);
    else fail(e);
    render();
  }
}
