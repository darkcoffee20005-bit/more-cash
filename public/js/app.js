// التشغيل، التوجيه، شاشتا الإعداد والدخول، والهيكل العام.
import { esc } from '../../shared/format.js';
import { get, post } from './api.js';
import { icon } from './icons.js';
import { bindEvents, busy, can, errorText, fail, field, initials, on, render, set, setViews, state, toast } from './ui.js';
import * as pos from './views/pos.js';
import * as receipts from './views/receipts.js';
import * as ops from './views/ops.js';
import * as admin from './views/admin.js';

const modules = [pos, receipts, ops, admin];
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
  if (!state.employee) return render();
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
    if (!s.setUp) return setupView();
    if (!s.employee) return pinView();
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
    const badge = r === 'pos' && s.ticketsCount ? `<span class="badge">${s.ticketsCount}</span>` : '';
    return `<a href="#/${r}" class="${s.route === r ? 'on' : ''}" ${s.route === r ? 'aria-current="page"' : ''}>${icon(ic)}<span>${label}</span>${badge}</a>`;
  }).join('');
  return `<nav class="rail" aria-label="التنقل الرئيسي">
    <div class="logo-mark" title="مور كاش">${icon('bean')}</div>
    ${links}
    <div class="me">
      ${globalThis.MORECASH_BACKEND ? '<span class="demo-tag" title="البيانات في هذا المتصفح فقط">تجريبي</span>' : ''}
      <div class="avatar" title="${esc(s.employee.name)}">${esc(initials(s.employee.name))}</div>
      <span class="small" style="font-size:.7rem;text-align:center">${esc(s.employee.name)}</span>
      <button data-action="lock" title="قفل الشاشة">${icon('lock', 'sm')}<span>قفل</span></button>
    </div>
  </nav>`;
}

function brandPanel() {
  return `<section class="auth-brand">
    <div class="logo"><div class="logo-mark">${icon('bean')}</div>مور كاش</div>
    <div><h1>كاشير مصمم لإيقاع الكوفي شوب</h1>
    <p>طلب بلمستين، إضافات الحليب والشوت بلمسة، مخزون البن والحليب يُخصم من الوصفة تلقائياً، وإغلاق وردية بلا أوراق.</p></div>
    <div class="facts"><div><b>د.ع</b>أعداد صحيحة بلا كسور</div><div><b>MongoDB</b>بيانات مركزية</div><div><b>PIN</b>دخول سريع</div></div>
  </section>`;
}

function pinView() {
  const pin = state.view.pin ?? '';
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'];
  return `<div class="auth">${brandPanel()}
    <section class="auth-panel"><div class="auth-card">
      <div><h2>أدخل رمزك</h2><p class="muted">رمز الموظف من 4 إلى 6 أرقام</p></div>
      <div class="pin-dots ${state.view.pinShake ? 'shake' : ''}" aria-label="عدد الأرقام المدخلة ${pin.length}">
        ${Array.from({ length: Math.max(4, pin.length) }, (_, i) => `<span class="${i < pin.length ? 'on' : ''}"></span>`).join('')}
      </div>
      <div class="keypad">${keys.map((k) => k === 'clear' ? '<button class="muted-key" data-action="pin-clear">مسح</button>'
        : k === 'back' ? `<button class="muted-key" data-action="pin-back" aria-label="حذف رقم">${icon('back')}</button>`
        : `<button data-action="pin-key" data-k="${k}">${k}</button>`).join('')}</div>
      <button class="btn primary lg block" data-action="pin-submit" ${pin.length < 4 || state.busy ? 'disabled' : ''}>دخول</button>
    </div></section></div>`;
}

function setupView() {
  return `<div class="auth">${brandPanel()}
    <section class="auth-panel"><form class="auth-card" data-form="setup" autocomplete="off">
      <div><h2>إعداد المقهى</h2><p class="muted">مرة واحدة فقط. ستكون أنت المالك.</p></div>
      ${field('اسم المقهى', '<input name="storeName" id="setup-store" required minlength="2" maxlength="60" placeholder="مقهى الزيتون">')}
      ${field('اسمك', '<input name="ownerName" id="setup-owner" required minlength="2" maxlength="40">')}
      <div class="grid-2">
        ${field('رمز الدخول', '<input name="pin" id="setup-pin" required inputmode="numeric" pattern="[0-9]{4,6}" maxlength="6" type="password">')}
        ${field('تأكيد الرمز', '<input name="pin2" id="setup-pin2" required inputmode="numeric" pattern="[0-9]{4,6}" maxlength="6" type="password">')}
      </div>
      <label class="check"><input type="checkbox" name="seed" checked> أضف قائمة كوفي جاهزة (مشروبات، إضافات، مكونات بوصفات)</label>
      <button class="btn primary lg block" type="submit" ${state.busy ? 'disabled' : ''}>ابدأ</button>
    </form></section></div>`;
}

// ---------------------------------------------------------------- الإجراءات العامة
async function loadSession(employee) {
  state.employee = employee;
  state.view = {};
  if (can('pos.sell') || can('kds.use')) await pos.loadBootstrap().catch(fail);
  await navigate();
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
    if (state.employee || !state.setUp || state.modal) return;
    if (document.activeElement?.tagName === 'INPUT') return;
    if (/^\d$/.test(e.key)) { const pin = state.view.pin ?? ''; if (pin.length < 6) set({ view: { ...state.view, pin: pin + e.key } }); }
    else if (e.key === 'Backspace') set({ view: { ...state.view, pin: (state.view.pin ?? '').slice(0, -1) } });
    else if (e.key === 'Enter') submitPin();
  },
  setup: (_el, _e, data) => busy(async () => {
    if (data.pin !== data.pin2) { toast('الرمزان غير متطابقين', 'bad'); return; }
    await post('/api/setup', { storeName: data.storeName, ownerName: data.ownerName, pin: data.pin, seed: data.seed });
    const r = await post('/api/auth/pin', { pin: data.pin });
    state.setUp = true;
    toast('تم إعداد المقهى. أهلاً بك!', 'ok');
    await loadSession(r.employee);
  }),
  lock: async () => {
    await post('/api/auth/logout', {}).catch(() => {});
    state.employee = null;
    state.modal = null;
    state.view = { pin: '' };
    render();
  },
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

export async function boot() {
  setViews(views);
  bindEvents(document.getElementById('app'));
  window.addEventListener('hashchange', () => navigate());
  try {
    const s = await get('/api/state');
    state.setUp = s.setUp;
    state.ready = true;
    if (s.employee) await loadSession(s.employee);
    else render();
  } catch (e) {
    state.ready = true;
    if (e.code === 'DB_NOT_CONFIGURED' || e.code === 'DB_UNAVAILABLE' || e.code === 'NETWORK') state.fatal = errorText(e);
    else fail(e);
    render();
  }
}
