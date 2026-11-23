// لوحة مزوّد الخدمة (#/platform): طلبات الاشتراك (موافقة/رفض)، العملاء واشتراكاتهم ونشاطهم، السجل، بيانات التحويل والتفاصيل،
// وأخطاء الخادم. التفعيل والتمديد والإيقاف وكلمة المرور المؤقتة والنسخة الاحتياطية من صف كل عميل.
import { dateTime, esc, localDate } from '../../../shared/format.js';
import { get, post, put } from '../api.js';
import { icon } from '../icons.js';
import { busy, fail, field, modalFrame, on, openModal, render, state, toast } from '../ui.js';

const TZ = 180;
const P = () => state.platform ?? (state.platform = { me: undefined, list: null, search: '', tab: 'requests', filter: 'all' });
const ago = (d) => {
  if (!d) return '—';
  const days = Math.floor((Date.now() - new Date(d).getTime()) / 86400_000);
  return days <= 0 ? 'اليوم' : days === 1 ? 'أمس' : `قبل ${days} يوم`;
};
const day = (d) => (d ? localDate(d, TZ) : '—');
const METHOD = { transfer: 'تحويل', cash: 'نقداً', free: 'مجاني' };
const SUB = {
  pending: ['بانتظار الموافقة', 'warn'], active: ['مشترك', 'ok'], trial: ['تجريبي مجاني', 'olive'], expired: ['منتهي', 'bad'],
};
const subPill = (s) => {
  if (!s) return '';
  if (s.unlimited) return '<span class="pill">حساب المزوّد</span>';
  const [label, cls] = SUB[s.status] ?? [s.status, ''];
  return `<span class="pill ${cls}">${label}</span>${s.until ? `<div class="muted small">${s.status === 'expired' ? 'انتهى' : 'حتى'} ${day(s.until)}${s.daysLeft && s.daysLeft <= 7 ? ` · باقي ${s.daysLeft} يوم` : ''}</div>` : ''}`;
};
const ACTIONS = {
  'request.approve': 'موافقة على طلب', 'request.reject': 'رفض طلب', 'subscription.extend': 'تفعيل/تمديد', 'subscription.stop': 'إيقاف الاشتراك',
  'config.update': 'تعديل بيانات التحويل', 'shop.disable': 'إيقاف المقهى', 'shop.enable': 'تفعيل المقهى', 'account.reset_password': 'كلمة مرور مؤقتة', 'backup.download': 'نسخة احتياطية',
};

export async function enterPlatform() {
  const p = P();
  try {
    const me = await get('/api/platform/me');
    p.me = me;
    if (me.email) {
      [p.list, p.errors, p.requests, p.config, p.audit] = await Promise.all([
        get('/api/platform/shops', { search: p.search || undefined }), get('/api/platform/errors'),
        get('/api/platform/requests', { status: 'all' }).catch(() => []), get('/api/platform/config').catch(() => null), get('/api/platform/audit').catch(() => []),
      ]);
    }
  } catch (e) { p.me = { email: null, enabled: false }; fail(e); }
  render();
}

function requestCard(r) {
  return `<div class="card pad stack" style="gap:8px">
    <div class="row wrap"><b style="font-size:1.05rem">${esc(r.shopName ?? '')}</b><span class="muted small">${esc(r.ownerName ?? '')} · <span dir="ltr">${esc(r.email ?? '')}</span></span>
      <span class="spacer"></span><span class="muted small">${dateTime(r.createdAt, TZ)}</span></div>
    <div class="row wrap small" style="gap:14px"><span class="pill ${r.method === 'cash' ? 'warn' : 'olive'}">${METHOD[r.method] ?? r.method}</span>
      ${r.phone ? `<a href="https://wa.me/${esc(r.phone.replace(/^0/, '964'))}" target="_blank" rel="noopener" dir="ltr">${esc(r.phone)}</a>` : ''}
      ${r.reference ? `<span>رقم الحوالة: <b dir="ltr">${esc(r.reference)}</b></span>` : ''}
      ${r.hasImage ? `<button class="btn sm" data-action="pf-req-image" data-id="${r.id}">${icon('camera', 'sm')} صورة الوصل</button>` : ''}</div>
    ${r.note ? `<p class="small" style="margin:0">«${esc(r.note)}»</p>` : ''}
    <div class="row wrap"><button class="btn primary" data-action="pf-approve" data-id="${r.id}">${icon('check', 'sm')} موافقة وتفعيل</button>
      <button class="btn danger" data-action="pf-reject" data-id="${r.id}">رفض</button></div></div>`;
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
  const T = l?.totals ?? {};
  const pendingReqs = (p.requests ?? []).filter((r) => r.status === 'pending');
  const TABS = [['requests', `طلبات الاشتراك${pendingReqs.length ? ` (${pendingReqs.length})` : ''}`], ['clients', 'العملاء'], ['log', 'السجل'], ['config', 'بيانات التحويل والتفاصيل'], ['errors', `أخطاء الخادم${p.errors?.count24h ? ` (${p.errors.count24h})` : ''}`]];
  const head = `<div class="page-head"><h1>لوحة المزوّد</h1><span class="muted small" dir="ltr">${esc(p.me.email)}</span>
      <span class="spacer"></span><button class="btn sm" data-action="platform-refresh">${icon('check', 'sm')} تحديث</button>
      <button class="btn sm ghost" data-action="platform-logout">${icon('lock', 'sm')} خروج</button></div>
    ${l ? `<div class="kpis">
      <div class="kpi lead"><span class="label">طلبات تنتظرك</span><b>${T.requests ?? 0}</b><span class="small">${T.pending ?? 0} حساب بانتظار الموافقة</span></div>
      <div class="kpi"><span class="label">مشتركون</span><b>${T.paying ?? 0}</b><span class="muted small">${T.trial ?? 0} تجريبي مجاني</span></div>
      <div class="kpi"><span class="label">منتهية</span><b style="color:${T.expired ? 'var(--bad)' : 'inherit'}">${T.expired ?? 0}</b></div>
      <div class="kpi"><span class="label">نشطة آخر 7 أيام</span><b>${T.active7 ?? 0}</b><span class="muted small">من ${T.shops ?? 0} مقهى</span></div></div>
      ${T.approval === false ? '<p class="small" style="color:var(--warn)">الموافقة على الحسابات معطّلة على هذا الخادم (REQUIRE_APPROVAL=false): كل حساب جديد يعمل مباشرة.</p>' : ''}` : ''}
    <div class="toolbar"><div class="seg wrap-seg">${TABS.map(([k, label]) => `<button class="${p.tab === k ? 'on' : ''}" data-action="pf-tab" data-k="${k}">${label}</button>`).join('')}</div></div>`;
  const body = {
    requests: () => `${pendingReqs.length ? pendingReqs.map(requestCard).join('') : '<div class="empty">لا طلبات اشتراك تنتظر موافقتك</div>'}
      ${(p.requests ?? []).filter((r) => r.status !== 'pending').length ? `<h2 style="margin-top:8px">آخر القرارات</h2><div class="table-wrap"><table><thead><tr><th>المقهى</th><th>الطريقة</th><th>القرار</th><th>المدة</th><th>التاريخ</th><th>ملاحظة</th></tr></thead><tbody>
        ${(p.requests ?? []).filter((r) => r.status !== 'pending').slice(0, 40).map((r) => `<tr><td><b>${esc(r.shopName ?? '')}</b>${r.manual ? ' <span class="pill">من اللوحة</span>' : ''}</td><td>${METHOD[r.method] ?? r.method}</td>
          <td>${r.status === 'approved' ? '<span class="pill ok">موافقة</span>' : '<span class="pill bad">رفض</span>'}</td><td class="small">${r.months ? `${r.months} شهر` : ''}${r.days ? ` ${r.days} يوم` : ''}</td>
          <td class="small">${dateTime(r.decidedAt ?? r.createdAt, TZ)}</td><td class="small">${esc(r.decisionNote ?? r.note ?? '')}</td></tr>`).join('')}</tbody></table></div>` : ''}`,
    clients: () => {
      const rows = (l?.rows ?? []).filter((r) => p.filter === 'all' || (p.filter === 'branch' ? r.branchOf : !r.branchOf && r.subscription?.status === p.filter));
      const F = [['all', 'الكل'], ['pending', 'بانتظار الموافقة'], ['active', 'مشتركون'], ['trial', 'تجريبي'], ['expired', 'منتهية']];
      return `<div class="row wrap"><div class="search-box" style="flex:1">${icon('search', 'sm')}<input type="search" id="pf-search" placeholder="ابحث باسم المقهى أو البريد" value="${esc(p.search)}" data-input="platform-search" autocomplete="off"></div>
        <div class="seg">${F.map(([k, label]) => `<button class="${p.filter === k ? 'on' : ''}" data-action="pf-filter" data-k="${k}">${label}</button>`).join('')}</div></div>
      <div class="table-wrap"><table><thead><tr><th>المقهى</th><th>المالك</th><th>الاشتراك</th><th>التسجيل</th><th>آخر دخول</th><th>آخر بيع</th><th class="num">مبيعات 30 يوم</th><th class="num">أجهزة</th><th></th></tr></thead>
      <tbody>${!l ? '<tr><td colspan="9" class="muted">جارٍ التحميل…</td></tr>' : rows.length ? rows.map((r) => `<tr>
        <td><b>${esc(r.name)}</b>${r.branchOf ? ' <span class="pill">فرع</span>' : ''}${r.pendingRequest ? ' <span class="pill warn">طلب جديد</span>' : ''}${r.disabled ? ` <span class="pill bad" title="${esc(r.disabledReason ?? '')}">موقوف</span>` : ''}</td>
        <td><div>${esc(r.ownerName ?? '')}</div><div class="muted small" dir="ltr">${esc(r.email ?? '')}</div></td>
        <td>${r.branchOf ? '<span class="muted small">يتبع حساب المالك</span>' : subPill(r.subscription)}</td>
        <td class="small">${day(r.createdAt)}</td><td class="small">${ago(r.lastLoginAt)}</td><td class="small">${ago(r.lastSaleAt)}</td>
        <td class="num">${r.sales30}</td><td class="num">${r.devices}</td>
        <td><div class="row wrap" style="justify-content:flex-end;gap:6px">
          ${r.branchOf || r.subscription?.unlimited ? '' : `<button class="btn sm primary" data-action="pf-extend" data-id="${r.id}">تفعيل / تمديد</button>`}
          <button class="btn sm" data-action="pf-more" data-id="${r.id}">المزيد</button></div></td></tr>`).join('')
        : '<tr><td colspan="9" class="muted">لا نتائج</td></tr>'}</tbody></table></div>`;
    },
    log: () => `<div class="table-wrap"><table><thead><tr><th>الوقت</th><th>العملية</th><th>المقهى</th><th>التفاصيل</th></tr></thead><tbody>
      ${(p.audit ?? []).map((x) => `<tr><td class="small">${dateTime(x.at, TZ)}</td><td>${ACTIONS[x.action] ?? esc(x.action)}</td>
        <td>${esc(x.shopName ?? l?.rows.find((r) => r.id === x.tenantId)?.name ?? '')}</td>
        <td class="small">${[x.method ? METHOD[x.method] : '', x.months ? `${x.months} شهر` : '', x.days ? `${x.days} يوم` : '', x.until ? `حتى ${day(x.until)}` : '', x.note ? `«${esc(x.note)}»` : ''].filter(Boolean).join(' · ')}</td></tr>`).join('')
        || '<tr><td colspan="4" class="muted">لا عمليات بعد</td></tr>'}</tbody></table></div>`,
    config: () => configForm(p),
    errors: () => `${p.errors ? `<div class="card pad stack"><b>${p.errors.count24h ? `${icon('alert', 'sm')} ${p.errors.count24h} خطأ في الخادم خلال 24 ساعة` : `${icon('check', 'sm')} لا أخطاء في الخادم خلال 24 ساعة`}</b>
      ${p.errors.recent.length ? `<div class="table-wrap"><table><tbody>${p.errors.recent.map((x) => `<tr><td class="small">${dateTime(x.at, TZ)}</td><td class="small" dir="ltr">${esc(x.method ?? '')} ${esc(x.path ?? '')}</td><td class="small" dir="ltr">${esc(x.name)}: ${esc(x.message)}</td><td class="small">${esc(l?.rows.find((r) => r.id === x.tenantId)?.name ?? '')}</td></tr>`).join('')}</tbody></table></div>` : ''}</div>` : ''}`,
  };
  return `<div class="page" style="max-width:1280px;height:100%;overflow:auto">${head}${(body[p.tab] ?? body.requests)()}</div>`;
}

function configForm(p) {
  const c = p.cfgDraft ?? (p.cfgDraft = structuredClone(p.config ?? { price: '', details: '', methods: [], whatsapp: '' }));
  if (!c.methods.length) c.methods.push({ label: '', value: '', holder: '' });
  return `<div class="grid-2" style="align-items:start"><section class="card pad stack">
      <h2>ما يراه العميل في صفحة الاشتراك</h2>
      ${field('السعر', `<input id="cf-price" value="${esc(c.price ?? '')}" maxlength="80" placeholder="مثلاً: 25,000 د.ع شهرياً" data-input="pf-cfg" data-k="price">`)}
      ${field('التفاصيل', `<textarea id="cf-details" rows="5" maxlength="1200" data-input="pf-cfg" data-k="details">${esc(c.details ?? '')}</textarea>`, 'ما يشمله الاشتراك، والمدة، وأي شرط')}
      ${field('واتساب للتواصل', `<input id="cf-wa" value="${esc(c.whatsapp ?? '')}" inputmode="tel" dir="ltr" maxlength="20" placeholder="9647…" data-input="pf-cfg" data-k="whatsapp">`)}
    </section><section class="card pad stack"><div class="row"><h2 style="margin-inline-end:auto">طرق الدفع وبيانات التحويل</h2>
      <button type="button" class="btn sm" data-action="pf-cfg-add">${icon('plus', 'sm')} طريقة</button></div>
      ${c.methods.map((m, i) => `<div class="card pad stack" style="gap:8px;box-shadow:none"><div class="grid-2">
        ${field('الطريقة', `<input id="cf-l-${i}" value="${esc(m.label)}" maxlength="40" placeholder="زين كاش، كي كارد، حساب مصرفي" data-input="pf-cfg-m" data-i="${i}" data-k="label">`)}
        ${field('الرقم', `<input id="cf-v-${i}" value="${esc(m.value)}" maxlength="80" dir="ltr" data-input="pf-cfg-m" data-i="${i}" data-k="value">`)}</div>
        <div class="row">${field('باسم (اختياري)', `<input id="cf-h-${i}" value="${esc(m.holder ?? '')}" maxlength="60" data-input="pf-cfg-m" data-i="${i}" data-k="holder">`)}
          <button type="button" class="icon-btn" data-action="pf-cfg-del" data-i="${i}" aria-label="حذف الطريقة">${icon('trash', 'sm')}</button></div></div>`).join('')}
      <p class="muted small" style="margin:0">لا تُكتب هذه البيانات في الكود: تحفظها هنا وتغيّرها متى شئت، وتظهر فوراً لكل عميل في صفحة الاشتراك.</p>
      <button class="btn primary lg" data-action="pf-cfg-save" ${state.busy ? 'disabled' : ''}>حفظ</button></section></div>`;
}

const durationFields = (preset = 1) => `<div class="grid-2">
    ${field('أشهر', `<select name="months" id="pf-months">${[0, 1, 2, 3, 6, 12].map((n) => `<option value="${n}" ${n === preset ? 'selected' : ''}>${n ? `${n} ${n === 1 ? 'شهر' : n === 2 ? 'شهران' : 'أشهر'}` : 'بلا أشهر'}</option>`).join('')}</select>`)}
    ${field('أيام إضافية', '<input name="days" id="pf-days" inputmode="numeric" value="0" maxlength="3">', 'مثلاً 14 للتجربة')}</div>`;

export const modals = {
  'pf-approve'(s) {
    const r = (P().requests ?? []).find((x) => x.id === s.modal.id);
    return modalFrame({ title: `تفعيل ${r?.shopName ?? ''}`, sub: `${METHOD[r?.method] ?? ''}${r?.reference ? ` · ${esc(r.reference)}` : ''}`, body: `<form class="stack" data-form="pf-approve-submit">
      <p class="small" style="margin:0">يبدأ من نهاية الاشتراك الحالي إن لم ينتهِ، وإلا من اليوم.</p>
      ${durationFields(1)}
      <label class="check"><input type="checkbox" name="free" id="pf-free"> مجاني (تجريبي) بلا دفع</label>
      ${field('ملاحظة (اختياري)', '<input name="note" id="pf-note" maxlength="200" placeholder="مثلاً: وصل سليم">')}
      <button class="btn primary lg" type="submit" ${s.busy ? 'disabled' : ''}>${icon('check', 'sm')} موافقة وتفعيل</button></form>` });
  },
  'pf-reject'(s) {
    return modalFrame({ title: 'رفض الطلب', body: `<form class="stack" data-form="pf-reject-submit">
      ${field('السبب (يظهر للعميل)', '<input name="note" id="pf-rnote" required maxlength="200" placeholder="مثلاً: لم يصل التحويل، أرسل الوصل مرة ثانية">')}
      <button class="btn danger solid lg" type="submit" ${s.busy ? 'disabled' : ''}>رفض</button></form>` });
  },
  'pf-extend'(s) {
    const r = P().list?.rows.find((x) => x.id === s.modal.id);
    return modalFrame({ title: `تفعيل / تمديد ${r?.name ?? ''}`, sub: r?.subscription?.until ? `الاشتراك الحالي حتى ${day(r.subscription.until)}` : 'لا اشتراك بعد', body: `<form class="stack" data-form="pf-extend-submit">
      <div class="seg">${Object.entries(METHOD).map(([k, label]) => `<button type="button" class="${(s.modal.method ?? 'cash') === k ? 'on' : ''}" data-action="pf-extend-method" data-k="${k}">${label}</button>`).join('')}</div>
      ${durationFields(s.modal.method === 'free' ? 0 : 1)}
      ${field('ملاحظة', '<input name="note" id="pf-enote" maxlength="200" placeholder="مثلاً: استلمت 25,000 نقداً">')}
      <button class="btn primary lg" type="submit" ${s.busy ? 'disabled' : ''}>${icon('check', 'sm')} تفعيل</button></form>` });
  },
  'pf-more'(s) {
    const r = P().list?.rows.find((x) => x.id === s.modal.id);
    if (!r) return '';
    return modalFrame({ title: r.name, sub: `${esc(r.ownerName ?? '')} · <span dir="ltr">${esc(r.email ?? '')}</span>`, body: `<div class="stack">
      <div class="r-line"><span>الاشتراك</span><span>${r.branchOf ? 'فرع يتبع حساب المالك' : subPill(r.subscription)}</span></div>
      <div class="r-line"><span>التسجيل</span><span>${dateTime(r.createdAt, TZ)}</span></div>
      <div class="r-line"><span>آخر دخول بالحساب</span><span>${r.lastLoginAt ? dateTime(r.lastLoginAt, TZ) : '—'}</span></div>
      <div class="r-line"><span>آخر بيع</span><span>${r.lastSaleAt ? dateTime(r.lastSaleAt, TZ) : '—'}</span></div>
      <div class="r-line"><span>مبيعات 30 يوم · أجهزة</span><span>${r.sales30} · ${r.devices}</span></div>
      <div class="row wrap" style="margin-top:8px">
        <button class="btn" data-action="pf-backup" data-id="${r.id}">${icon('download', 'sm')} نسخة احتياطية</button>
        <button class="btn" data-action="platform-reset" data-id="${r.id}">كلمة مرور مؤقتة</button>
        ${!r.branchOf && !r.subscription?.unlimited && ['active', 'trial'].includes(r.subscription?.status) ? `<button class="btn danger" data-action="pf-stop" data-id="${r.id}">إيقاف الاشتراك الآن</button>` : ''}
        ${r.disabled ? `<button class="btn" data-action="platform-enable" data-id="${r.id}">إلغاء حظر المقهى</button>` : `<button class="btn ghost danger" data-action="platform-disable" data-id="${r.id}">حظر المقهى كلياً</button>`}</div>
      <p class="muted small" style="margin:0">إيقاف الاشتراك: يقرأ تقاريره ولا يبيع حتى التجديد. الحظر: لا دخول إطلاقاً.</p></div>` });
  },
  'pf-image'(s) {
    return modalFrame({ title: 'صورة الوصل', cls: 'wide', body: s.modal.src ? `<img src="${s.modal.src}" alt="وصل التحويل" style="max-width:100%;border-radius:12px">` : '<p class="muted">جارٍ التحميل…</p>' });
  },
  'platform-disable'(s) {
    const r = P().list?.rows.find((x) => x.id === s.modal.id);
    return modalFrame({ title: `حظر ${r?.name ?? ''}`, body: `<form class="stack" data-form="platform-disable-submit">
      <p>لن يستطيع المقهى البيع أو الدخول حتى تلغي الحظر. البيانات تبقى محفوظة.</p>
      ${field('السبب (يظهر لك فقط)', '<input name="reason" id="pf-reason" required maxlength="120" placeholder="مثلاً: إساءة استخدام">')}
      <button class="btn danger solid lg" type="submit" ${s.busy ? 'disabled' : ''}>حظر المقهى</button></form>` });
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

const duration = (d) => {
  const months = Number(d.months) || 0;
  const days = Number(String(d.days ?? '0').replace(/[^\d]/g, '')) || 0;
  if (!months && !days) throw new Error('اختر مدة: أشهر أو أيام');
  return { months, days };
};

on({
  'platform-login': (_el, _e, d) => busy(async () => {
    await post('/api/platform/login', { email: d.email, password: d.password });
    await enterPlatform();
  }),
  'platform-logout': () => busy(async () => { await post('/api/platform/logout', {}); state.platform = null; await enterPlatform(); }),
  'platform-refresh': () => enterPlatform(),
  'pf-tab': (el) => { P().tab = el.dataset.k; render(); },
  'pf-filter': (el) => { P().filter = el.dataset.k; render(); },
  'platform-search': (el) => {
    const p = P();
    p.search = el.value;
    clearTimeout(p.timer);
    p.timer = setTimeout(() => enterPlatform(), 300);
  },
  'pf-approve': (el) => openModal({ type: 'pf-approve', id: el.dataset.id }),
  'pf-approve-submit': (_el, _e, d) => busy(async () => {
    await post(`/api/platform/requests/${state.modal.id}/approve`, { ...duration(d), free: d.free === 'on', note: d.note || null });
    state.modal = null;
    toast('فُعّل الاشتراك', 'ok');
    await enterPlatform();
  }),
  'pf-reject': (el) => openModal({ type: 'pf-reject', id: el.dataset.id }),
  'pf-reject-submit': (_el, _e, d) => busy(async () => {
    await post(`/api/platform/requests/${state.modal.id}/reject`, { note: d.note });
    state.modal = null;
    toast('رُفض الطلب', 'ok');
    await enterPlatform();
  }),
  'pf-req-image': (el) => busy(async () => {
    openModal({ type: 'pf-image', src: null });
    const r = await get(`/api/platform/requests/${el.dataset.id}/image`);
    if (state.modal?.type === 'pf-image') { state.modal.src = `data:${r.mediaType};base64,${r.image}`; render(); }
  }),
  'pf-extend': (el) => openModal({ type: 'pf-extend', id: el.dataset.id, method: 'cash' }),
  'pf-extend-method': (el) => { state.modal.method = el.dataset.k; render(); },
  'pf-extend-submit': (_el, _e, d) => busy(async () => {
    const r = await post(`/api/platform/shops/${state.modal.id}/subscription`, { ...duration(d), method: state.modal.method ?? 'cash', note: d.note || null });
    state.modal = null;
    toast(`فُعّل حتى ${day(r.until)}`, 'ok');
    await enterPlatform();
  }),
  'pf-more': (el) => openModal({ type: 'pf-more', id: el.dataset.id }),
  'pf-stop': (el) => busy(async () => {
    const p = P();
    if (p.confirmStop !== el.dataset.id) { p.confirmStop = el.dataset.id; toast('اضغط مرة أخرى لإيقاف الاشتراك الآن'); return; }
    p.confirmStop = null;
    await post(`/api/platform/shops/${el.dataset.id}/subscription`, { action: 'stop' });
    state.modal = null;
    toast('أُوقف الاشتراك', 'ok');
    await enterPlatform();
  }),
  'pf-backup': (el) => busy(async () => {
    const data = await get(`/api/platform/shops/${el.dataset.id}/backup`);
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `morecash-${(data.tenant?.name ?? 'shop').replace(/[^\p{L}\p{N}]+/gu, '-')}-${localDate(Date.now(), TZ)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('نُزّلت النسخة الاحتياطية', 'ok');
  }),
  'pf-cfg': (el) => { P().cfgDraft[el.dataset.k] = el.value; },
  'pf-cfg-m': (el) => { P().cfgDraft.methods[Number(el.dataset.i)][el.dataset.k] = el.value; },
  'pf-cfg-add': () => { P().cfgDraft.methods.push({ label: '', value: '', holder: '' }); render(); },
  'pf-cfg-del': (el) => { P().cfgDraft.methods.splice(Number(el.dataset.i), 1); render(); },
  'pf-cfg-save': () => busy(async () => {
    const c = P().cfgDraft;
    const methods = c.methods.filter((m) => m.label.trim() || m.value.trim());
    if (methods.some((m) => !m.label.trim() || !m.value.trim())) throw new Error('أكمل اسم الطريقة ورقمها، أو احذف السطر');
    P().config = await put('/api/platform/config', { price: c.price, details: c.details, whatsapp: c.whatsapp || null, methods });
    P().cfgDraft = null;
    toast('حُفظت بيانات التحويل', 'ok');
    render();
  }),
  'platform-enable': (el) => busy(async () => { await post(`/api/platform/shops/${el.dataset.id}/enable`, {}); state.modal = null; toast('أُلغي الحظر', 'ok'); await enterPlatform(); }),
  'platform-disable': (el) => openModal({ type: 'platform-disable', id: el.dataset.id }),
  'platform-disable-submit': (_el, _e, d) => busy(async () => {
    await post(`/api/platform/shops/${state.modal.id}/disable`, { reason: d.reason });
    state.modal = null;
    toast('حُظر المقهى', 'ok');
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
