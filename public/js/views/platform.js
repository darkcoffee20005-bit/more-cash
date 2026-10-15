// لوحة مزوّد الخدمة (#/platform): كل المقاهي، النشاط، الإيقاف/التفعيل، وكلمة مرور مؤقتة لمن نسيها.
import { dateTime, esc } from '../../../shared/format.js';
import { get, post } from '../api.js';
import { icon } from '../icons.js';
import { busy, fail, field, modalFrame, on, openModal, render, state, toast } from '../ui.js';

const P = () => state.platform ?? (state.platform = { me: undefined, list: null, search: '' });
const ago = (d) => {
  if (!d) return '—';
  const days = Math.floor((Date.now() - new Date(d).getTime()) / 86400_000);
  return days <= 0 ? 'اليوم' : days === 1 ? 'أمس' : `قبل ${days} يوم`;
};

export async function enterPlatform() {
  const p = P();
  try {
    const me = await get('/api/platform/me');
    p.me = me;
    if (me.email) p.list = await get('/api/platform/shops', { search: p.search || undefined });
  } catch (e) { p.me = { email: null, enabled: false }; fail(e); }
  render();
}

export function platformView() {
  const p = P();
  if (p.me === undefined) return '<div class="auth-panel" style="height:100%"><p class="muted">جارٍ التحميل…</p></div>';
  if (!p.me.email) {
    return `<div class="auth-panel" style="height:100%"><form class="card pad stack" style="width:min(420px,100%)" data-form="platform-login">
      <div class="row">${icon('gear')}<h1 style="font-size:1.3rem">لوحة مزوّد الخدمة</h1></div>
      ${p.me.enabled === false ? '<p class="muted">اللوحة غير مفعّلة على هذا الخادم (PLATFORM_ADMINS).</p>' : '<p class="muted small">للمزوّد فقط. ادخل ببريد وكلمة مرور حسابك المسجّل كمزوّد.</p>'}
      ${field('البريد', '<input name="email" id="pf-email" type="email" dir="ltr" required autocomplete="username">')}
      ${field('كلمة المرور', '<input name="password" id="pf-pass" type="password" required autocomplete="current-password">')}
      <button class="btn primary lg" type="submit" ${state.busy ? 'disabled' : ''}>دخول</button>
      <a class="btn ghost" href="#/">العودة للبرنامج</a></form></div>`;
  }
  const l = p.list;
  return `<div class="page" style="max-width:1200px;height:100%;overflow:auto">
    <div class="page-head"><h1>المقاهي المشتركة</h1><span class="muted small" dir="ltr">${esc(p.me.email)}</span>
      <span class="spacer"></span><button class="btn sm" data-action="platform-refresh">${icon('check', 'sm')} تحديث</button>
      <button class="btn sm ghost" data-action="platform-logout">${icon('lock', 'sm')} خروج</button></div>
    ${l ? `<div class="kpis" style="grid-template-columns:repeat(3,minmax(0,1fr))">
      <div class="kpi lead"><span class="label">كل المقاهي</span><b>${l.totals.shops}</b></div>
      <div class="kpi"><span class="label">نشطة آخر 7 أيام</span><b>${l.totals.active7}</b></div>
      <div class="kpi"><span class="label">موقوفة</span><b>${l.totals.disabled}</b></div></div>` : ''}
    <div class="search-box">${icon('search', 'sm')}<input type="search" id="pf-search" placeholder="ابحث باسم المقهى أو البريد" value="${esc(p.search)}" data-input="platform-search" autocomplete="off"></div>
    <div class="table-wrap"><table><thead><tr><th>المقهى</th><th>المالك</th><th>التسجيل</th><th>آخر بيع</th><th class="num">مبيعات 30 يوم</th><th class="num">أجهزة</th><th>الحالة</th><th></th></tr></thead>
    <tbody>${!l ? '<tr><td colspan="8" class="muted">جارٍ التحميل…</td></tr>' : l.rows.length ? l.rows.map((r) => `<tr>
      <td><b>${esc(r.name)}</b></td><td><div>${esc(r.ownerName ?? '')}</div><div class="muted small" dir="ltr">${esc(r.email ?? '')}</div></td>
      <td class="small">${r.createdAt ? dateTime(r.createdAt, 180) : '—'}</td><td class="small">${ago(r.lastSaleAt)}</td>
      <td class="num">${r.sales30}</td><td class="num">${r.devices}</td>
      <td>${r.disabled ? `<span class="pill bad" title="${esc(r.disabledReason ?? '')}">موقوف</span>` : '<span class="pill ok">فعّال</span>'}</td>
      <td><div class="row" style="justify-content:flex-end;gap:6px">
        ${r.disabled ? `<button class="btn sm" data-action="platform-enable" data-id="${r.id}">تفعيل</button>` : `<button class="btn sm danger" data-action="platform-disable" data-id="${r.id}">إيقاف</button>`}
        <button class="btn sm" data-action="platform-reset" data-id="${r.id}">كلمة مرور مؤقتة</button></div></td></tr>`).join('')
      : '<tr><td colspan="8" class="muted">لا مقاهي</td></tr>'}</tbody></table></div></div>`;
}

export const modals = {
  'platform-disable'(s) {
    const r = P().list?.rows.find((x) => x.id === s.modal.id);
    return modalFrame({ title: `إيقاف ${r?.name ?? ''}`, body: `<form class="stack" data-form="platform-disable-submit">
      <p>لن يستطيع المقهى البيع أو الدخول حتى تعيد تفعيله. البيانات تبقى محفوظة.</p>
      ${field('السبب (يظهر لك فقط)', '<input name="reason" id="pf-reason" required maxlength="120" placeholder="مثلاً: لم يُدفع اشتراك الشهر">')}
      <button class="btn danger solid lg" type="submit" ${s.busy ? 'disabled' : ''}>إيقاف المقهى</button></form>` });
  },
  'platform-temp'(s) {
    const m = s.modal;
    return modalFrame({ title: 'كلمة مرور مؤقتة', body: `
      <p>أعطِ صاحب المقهى (<b dir="ltr">${esc(m.email)}</b>) هذه الكلمة. ستُطلب منه تغييرها، وقد سُجّل خروج كل أجهزته.</p>
      <div class="card pad" style="text-align:center;font-family:var(--font-display);font-size:1.8rem;letter-spacing:.08em" dir="ltr">${esc(m.temp)}</div>
      <p class="muted small">لن تظهر مرة أخرى. انسخها الآن.</p>`,
    foot: '<button class="btn primary" data-action="platform-copy">نسخ</button><button class="btn" data-action="close-modal">تم</button>' });
  },
};

on({
  'platform-login': (_el, _e, d) => busy(async () => {
    await post('/api/platform/login', { email: d.email, password: d.password });
    await enterPlatform();
  }),
  'platform-logout': () => busy(async () => { await post('/api/platform/logout', {}); state.platform = null; await enterPlatform(); }),
  'platform-refresh': () => enterPlatform(),
  'platform-search': (el) => {
    const p = P();
    p.search = el.value;
    clearTimeout(p.timer);
    p.timer = setTimeout(() => enterPlatform(), 300);
  },
  'platform-enable': (el) => busy(async () => { await post(`/api/platform/shops/${el.dataset.id}/enable`, {}); toast('فُعّل المقهى', 'ok'); await enterPlatform(); }),
  'platform-disable': (el) => openModal({ type: 'platform-disable', id: el.dataset.id }),
  'platform-disable-submit': (_el, _e, d) => busy(async () => {
    await post(`/api/platform/shops/${state.modal.id}/disable`, { reason: d.reason });
    state.modal = null;
    toast('أُوقف المقهى', 'ok');
    await enterPlatform();
  }),
  'platform-reset': (el) => busy(async () => {
    const p = P();
    if (p.confirmReset !== el.dataset.id) { p.confirmReset = el.dataset.id; toast('اضغط مرة أخرى: ستُستبدل كلمة المرور الحالية ويُسجَّل خروج أجهزة المقهى'); return; }
    p.confirmReset = null;
    const r = await post(`/api/platform/shops/${el.dataset.id}/reset-password`, {});
    openModal({ type: 'platform-temp', email: r.email, temp: r.tempPassword });
  }),
  'platform-copy': async () => {
    try { await navigator.clipboard.writeText(state.modal.temp); toast('نُسخت', 'ok'); } catch { toast('انسخها يدوياً', 'bad'); }
  },
});
