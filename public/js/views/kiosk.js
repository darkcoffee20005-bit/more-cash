// شاشة الحضور والانصراف المشتركة على جهاز الكاشير: أسماء الموظفين، يضغط الموظف على اسمه ويكتب رمزه،
// فيُسجَّل حضوره أو انصرافه حسب حالته. لا تغيّر جلسة الكاشير، وتعمل أيضاً من شاشة الرمز قبل أي دخول.
import { esc, time } from '../../../shared/format.js';
import { get, post, uid } from '../api.js';
import { icon } from '../icons.js';
import { busy, fail, on, render, state, toast } from '../ui.js';

const tz = () => state.settings?.tzOffsetMin ?? 180;
const hours = (min) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
const ROLES = { owner: 'المالك', manager: 'مدير', cashier: 'كاشير', barista: 'باريستا' };
const initials = (name) => name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('');

async function load() {
  try { state.kiosk.list = await get('/api/hr/kiosk'); } catch (e) { fail(e); state.kiosk.list = []; }
  render();
}

export function kioskView(s) {
  const k = s.kiosk;
  const list = k.list;
  const pick = list?.find((e) => e.id === k.pick);
  const cards = list === null ? '<p class="muted">جارٍ التحميل…</p>' : list.map((e) => {
    const c = e.clockedIn;
    const status = c ? (c.forgot ? '<span class="pill bad">حضور مفتوح من أمس</span>' : `<span class="pill ok">حاضر منذ ${time(c.inAt, tz())} · ${hours(c.minutes)}</span>`) : '<span class="pill">لم يسجّل حضوراً</span>';
    return `<button class="kiosk-emp ${c && !c.forgot ? 'in' : ''}" data-action="kiosk-pick" data-id="${esc(e.id)}"><span class="avatar">${esc(initials(e.name))}</span>
      <span class="stack" style="gap:4px;align-items:flex-start"><b>${esc(e.name)}</b><small class="muted">${ROLES[e.role] ?? ''}</small>${status}</span></button>`;
  }).join('');
  const pad = pick ? (() => {
    const p = k.pin;
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'];
    const out = pick.clockedIn && !pick.clockedIn.forgot;
    return `<div class="kiosk-pad card pad stack" role="dialog" aria-label="رمز ${esc(pick.name)}">
      <div class="row"><div style="flex:1"><h2 style="margin:0">${esc(pick.name)}</h2><p class="muted small" style="margin:0">اكتب رمزك ل${out ? 'تسجيل الانصراف' : 'تسجيل الحضور'}</p></div>
        <button class="icon-btn" data-action="kiosk-unpick" aria-label="رجوع">${icon('x')}</button></div>
      <div class="pin-dots ${k.shake ? 'shake' : ''}" aria-label="عدد الأرقام المدخلة ${p.length}">${Array.from({ length: Math.max(4, p.length) }, (_, i) => `<span class="${i < p.length ? 'on' : ''}"></span>`).join('')}</div>
      <div class="keypad">${keys.map((x) => (x === 'clear' ? '<button class="muted-key" data-action="kiosk-clear">مسح</button>'
        : x === 'back' ? `<button class="muted-key" data-action="kiosk-back" aria-label="حذف رقم">${icon('back')}</button>`
          : `<button data-action="kiosk-key" data-k="${x}">${x}</button>`)).join('')}</div>
      <button class="btn ${out ? 'danger solid' : 'primary'} lg block" data-action="kiosk-submit" ${p.length < 4 || s.busy ? 'disabled' : ''}>${icon('clock', 'sm')} ${out ? 'تسجيل انصراف' : 'تسجيل حضور'}</button>
    </div>`;
  })() : '';
  return `<div class="kiosk">
    <header class="kiosk-head"><div><h1>الحضور والانصراف</h1><p class="muted" style="margin:0">${esc(s.shop?.name ?? '')} · اضغط على اسمك واكتب رمزك</p></div>
      <button class="btn" data-action="kiosk-close">${icon('back', 'sm')} رجوع</button></header>
    <div class="kiosk-body"><div class="kiosk-grid">${cards}</div>${pad}</div></div>`;
}

on({
  'kiosk-open': () => { state.kiosk = { list: null, pick: null, pin: '' }; state.modal = null; render(); load(); },
  'kiosk-close': () => { state.kiosk = null; render(); },
  'kiosk-pick': (el) => { Object.assign(state.kiosk, { pick: el.dataset.id, pin: '', clientId: uid() }); render(); },
  'kiosk-unpick': () => { Object.assign(state.kiosk, { pick: null, pin: '' }); render(); },
  'kiosk-key': (el) => { const k = state.kiosk; if (k.pin.length < 6) k.pin += el.dataset.k; render(); },
  'kiosk-back': () => { state.kiosk.pin = state.kiosk.pin.slice(0, -1); render(); },
  'kiosk-clear': () => { state.kiosk.pin = ''; render(); },
  'kiosk-submit': () => busy(async () => {
    const k = state.kiosk;
    try {
      const r = await post('/api/hr/kiosk/clock', { clientId: k.clientId, employeeId: k.pick, pin: k.pin });
      toast(r.action === 'in' ? `أهلاً ${r.name} — سُجّل حضورك ${time(r.attendance.inAt, tz())}` : `مع السلامة ${r.name} — سُجّل انصرافك · ${hours(r.attendance.minutes)} ساعة`, 'ok');
      if (r.autoClosed) toast('كان عندك حضور مفتوح من يوم سابق: أُغلق وسيراجعه المدير', 'bad');
      Object.assign(k, { pick: null, pin: '' });
      await load();
    } catch (e) {
      // رمز خاطئ: هزّة ومسح، وتبقى الشاشة على نفس الموظف بعملية جديدة
      Object.assign(k, { pin: '', shake: true, clientId: uid() });
      setTimeout(() => { if (state.kiosk) { state.kiosk.shake = false; render(); } }, 400);
      throw e;
    }
  }),
});
