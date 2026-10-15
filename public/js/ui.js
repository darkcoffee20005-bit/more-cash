// الحالة العامة، الرسم، تفويض الأحداث، الرسائل، والنوافذ.
import { esc } from '../../shared/format.js';
import { icon } from './icons.js';

export const state = {
  ready: false, shop: null, authPage: '', employee: null, route: 'pos', params: {},
  settings: null, catalog: null, shift: null, ticketsCount: 0,
  modal: null, busy: false, toasts: [],
  pos: null, view: {},
};

let views = null;
let scheduled = false;
const actions = Object.create(null);

export function setViews(v) { views = v; }
export function on(map) { Object.assign(actions, map); }
export const can = (perm) => !!state.employee?.permissions?.includes(perm);

const renderedHooks = [];
/** يُستدعى بعد كل رسم (لقياسات تعتمد على DOM الفعلي) */
export function onRendered(fn) { renderedHooks.push(fn); }

export function render() {
  if (scheduled || typeof document === 'undefined' || !views) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    const root = document.getElementById('app');
    const active = document.activeElement;
    const focusId = active?.id && root.contains(active) ? active.id : null;
    const sel = focusId && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;
    const scrolls = [...root.querySelectorAll('[data-keep-scroll]')].map((el) => [el.dataset.keepScroll, el.scrollTop]);
    // حقول النماذج غير المرتبطة بالحالة (عميل جديد، فتح وردية، الدخول…): لا يضيع ما كُتب عند إعادة الرسم
    // (اختفاء إشعار مثلاً يعيد الرسم). الحقول ذات data-input تُرسم من الحالة فلا تُستعاد
    const kept = [...root.querySelectorAll('form [id]:not([data-input])')].filter((el) => 'value' in el && el.type !== 'file' && el.type !== 'submit' && el.type !== 'button')
      .map((el) => [el.id, el.type === 'checkbox' ? el.checked : el.value, el.type]);
    root.innerHTML = views.app(state) + modalHtml() + toastsHtml();
    for (const [id, v, type] of kept) {
      const el = document.getElementById(id);
      if (!el) continue;
      if (type === 'checkbox') el.checked = v; else el.value = v;
    }
    // الحركة عند الظهور الأول فقط؛ إعادة الرسم لا تعيد تشغيلها (لا وميض أثناء اختيار الإضافات)
    if (state.modal) state.modal.__shown = true;
    for (const t of state.toasts) t.shown = true;
    for (const [key, top] of scrolls) { const el = root.querySelector(`[data-keep-scroll="${key}"]`); if (el) el.scrollTop = top; }
    if (focusId) {
      const el = document.getElementById(focusId);
      if (el) { el.focus({ preventScroll: true }); if (sel && el.setSelectionRange) try { el.setSelectionRange(...sel); } catch { /* */ } }
    } else {
      root.querySelector('.modal [autofocus]')?.focus();
    }
    for (const fn of renderedHooks) { try { fn(); } catch (e) { console.error(e); } }
  });
}

export function set(patch) { Object.assign(state, patch); render(); }

function modalHtml() {
  if (!state.modal) return '';
  const html = views.modal(state);
  return html ? `<div class="modal-back ${state.modal.__shown ? '' : 'anim'}" data-action="modal-back" role="presentation">${html}</div>` : '';
}

export function modalFrame({ title, body, foot = '', cls = '', sub = '' }) {
  return `<div class="modal ${cls}" role="dialog" aria-modal="true" aria-label="${esc(title)}" data-stop>
    <div class="modal-head"><div><h2>${esc(title)}</h2>${sub ? `<div class="muted small">${sub}</div>` : ''}</div><span class="spacer"></span>
      <button class="icon-btn" data-action="close-modal" aria-label="إغلاق">${icon('x')}</button></div>
    <div class="modal-body">${body}</div>
    ${foot ? `<div class="modal-foot">${foot}</div>` : ''}
  </div>`;
}

export function openModal(modal) { state.modal = modal; render(); }
export function closeModal() { state.modal = null; render(); }

// ---------------------------------------------------------------- رسائل
function toastsHtml() {
  if (!state.toasts.length) return '';
  return `<div class="toast-zone" role="status" aria-live="polite">${state.toasts.map((t) => `<div class="toast ${t.kind} ${t.shown ? '' : 'anim'}">${esc(t.text)}</div>`).join('')}</div>`;
}

export function toast(text, kind = '') {
  const t = { text, kind, id: Math.random() };
  state.toasts = [...state.toasts.slice(-2), t];
  render();
  setTimeout(() => { state.toasts = state.toasts.filter((x) => x !== t); render(); }, kind === 'bad' ? 5000 : 2600);
}

const ERRORS = {
  NETWORK: 'تعذر الاتصال بالخادم. تحقق من الشبكة.',
  SCAN_NOT_CONFIGURED: 'قراءة صور الفواتير غير مفعّلة بعد (يلزم ANTHROPIC_API_KEY في إعدادات الخادم). يمكنك إدخال المشتريات يدوياً.',
  SCAN_FAILED: 'تعذرت قراءة الفاتورة. جرّب صورة أوضح بإضاءة جيدة، أو أدخل الأسطر يدوياً.',
  INVALID_IMAGE: 'الصورة غير صالحة.',
  TOO_LARGE: 'الصورة كبيرة جداً.',
  NOT_AUTHENTICATED: 'انتهت الجلسة. أدخل رمزك مجدداً.',
  FORBIDDEN: 'لا تملك صلاحية هذه العملية.',
  WRONG_PIN: 'الرمز غير صحيح.',
  TOO_MANY_ATTEMPTS: 'محاولات كثيرة. انتظر قليلاً ثم حاول.',
  WEAK_PIN: 'الرمز من 4 إلى 6 أرقام، ولا يكون رقماً مكرراً مثل 1111.',
  PIN_IN_USE: 'هذا الرمز مستخدم لموظف آخر.',
  NO_OPEN_SHIFT: 'لا توجد وردية مفتوحة. افتح وردية أولاً.',
  SHIFT_ALREADY_OPEN: 'توجد وردية مفتوحة بالفعل.',
  TOTAL_MISMATCH: 'تغيّرت الأسعار على الخادم. حدّث القائمة ثم أعد المحاولة.',
  MODIFIER_REQUIRED: 'اختر الإضافة الإلزامية للصنف.',
  UNKNOWN_ITEM: 'صنف غير متوفر. حدّث القائمة.',
  INSUFFICIENT_POINTS: 'رصيد النقاط غير كافٍ.',
  POINTS_EXCEED_TOTAL: 'النقاط أكبر من قيمة الفاتورة.',
  OVERPAYMENT: 'المبلغ المدفوع أكبر من المستحق.',
  UNDERPAYMENT: 'المبلغ المدفوع أقل من المستحق.',
  TENDERED_LESS_THAN_DUE: 'المبلغ المستلم أقل من المستحق.',
  REFUND_QTY_EXCEEDS: 'الكمية أكبر من المتبقي للاسترجاع.',
  VARIANCE_NOTE_REQUIRED: 'فرق النقد كبير. اكتب ملاحظة توضح السبب.',
  TICKET_CHANGED: 'عُدّلت هذه التذكرة من جهاز آخر. أعد فتحها.',
  NAME_IN_USE: 'الاسم مستخدم مسبقاً.',
  NAME_OR_SKU_IN_USE: 'الاسم أو رمز SKU مستخدم مسبقاً.',
  PHONE_IN_USE: 'رقم الهاتف مسجل لعميل آخر.',
  LAST_OWNER: 'لا يمكن تعطيل أو تغيير دور المالك الوحيد.',
  CASH_REQUIRED: 'يجب أن تبقى طريقة دفع نقدية فعالة.',
  REQUIRED: 'أكمل الحقول المطلوبة.',
  INVALID_NUMBER: 'رقم غير صالح.',
  INVALID_COST: 'التكلفة رقم بثلاث منازل عشرية كحد أقصى.',
  RECIPE_COMPONENT_INVALID: 'مكون الوصفة يجب أن يكون صنفاً بمخزون متتبَّع.',
  INVALID_RANGE: 'فترة غير صالحة.',
  ALREADY_SET_UP: 'النظام مُعدّ مسبقاً.',
  INVALID_EMAIL: 'اكتب بريداً إلكترونياً صحيحاً.',
  PLATFORM_AUTH: 'انتهت جلسة لوحة المزوّد. ادخل مجدداً.',
  INVALID_PHONE: 'رقم الهاتف غير صحيح. مثال: 07701234567',
  WEAK_PASSWORD: 'كلمة المرور 8 أحرف على الأقل، ولا تكون أرقاماً فقط.',
  EMAIL_IN_USE: 'هذا البريد مسجّل لمقهى آخر. سجّل الدخول به بدلاً من ذلك.',
  BAD_CREDENTIALS: 'البريد أو كلمة المرور غير صحيحة.',
  ACCOUNT_LOCKED: 'محاولات خاطئة كثيرة. أُوقف الدخول لهذا الحساب 5 دقائق.',
  WRONG_PASSWORD: 'كلمة المرور الحالية غير صحيحة.',
  NO_SHOP: 'انتهى ربط هذا الجهاز بالمقهى. سجّل الدخول مجدداً.',
  ALLOCATION_EXCEEDS_BASE: 'الخصم أكبر من قيمة الفاتورة.',
  INTERNAL: 'خطأ غير متوقع في الخادم.',
  DB_NOT_CONFIGURED: 'قاعدة البيانات غير مهيأة: أضف MONGODB_URI في إعدادات الخادم (Vercel → Environment Variables).',
  DB_UNAVAILABLE: 'تعذر الاتصال بقاعدة البيانات. حاول بعد قليل.',
};

export function errorText(e) {
  if (!e) return '';
  return ERRORS[e.code] ?? e.message ?? 'حدث خطأ';
}

export function fail(e) {
  if (!e?.code) console.error(e);
  if (e?.code === 'SHOP_DISABLED') {
    // أوقف المزوّد هذا المقهى: شاشة توضيح بدل أخطاء متكررة
    Object.assign(state, { shop: { ...(state.shop ?? {}), disabled: true }, employee: null, modal: null });
    render();
    return;
  }
  if (e?.code === 'NO_SHOP') {
    // انتهى ربط الجهاز بالمقهى (أو سُجّل خروجه من جهاز آخر): العودة لتسجيل الدخول
    Object.assign(state, { shop: null, employee: null, modal: null, view: {}, authPage: 'login' });
    if (typeof history !== 'undefined') history.replaceState(null, '', '#/login');
  }
  toast(errorText(e), 'bad');
}

/** يمنع النقر المزدوج على عمليات الكتابة */
export async function busy(fn) {
  if (state.busy) return undefined;
  state.busy = true;
  render();
  try { return await fn(); } catch (e) { fail(e); return undefined; } finally { state.busy = false; render(); }
}

// ---------------------------------------------------------------- تفويض الأحداث
export function bindEvents(root) {
  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || el.disabled) return;
    if (el.dataset.action === 'modal-back' && e.target !== el) return;
    e.preventDefault();
    run(el.dataset.action, el, e);
  });
  root.addEventListener('submit', (e) => {
    const form = e.target.closest('form[data-form]');
    if (!form) return;
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    for (const cb of form.querySelectorAll('input[type=checkbox][name]')) data[cb.name] = cb.checked;
    run(form.dataset.form, form, e, data);
  });
  root.addEventListener('input', (e) => { const el = e.target.closest('[data-input]'); if (el) run(el.dataset.input, el, e); });
  root.addEventListener('change', (e) => { const el = e.target.closest('[data-change]'); if (el) run(el.dataset.change, el, e); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.modal) { state.modal = null; render(); }
    if (actions.keydown) actions.keydown(null, e);
  });
}

/** تشغيل إجراء مباشرة (للاختبارات) */
export const runAction = (name, el = { dataset: {} }, e = {}, data = undefined) => run(name, el, e, data, true);

async function run(name, el, e, data, rethrow = false) {
  const fn = actions[name];
  if (!fn) { console.warn('no action', name); return; }
  try { await fn(el, e, data); } catch (err) { if (rethrow) throw err; fail(err); }
}

export const field = (label, input, hint = '') => `<label class="field"><span>${label}</span>${input}${hint ? `<small class="hint">${hint}</small>` : ''}</label>`;
export const initials = (name = '') => name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('');
