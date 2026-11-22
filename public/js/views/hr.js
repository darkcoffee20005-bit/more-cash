// الموارد البشرية: صفحة «سجلي» لكل موظف (حضور/انصراف، ساعاته، حوافزه وغراماته، إجازاته وطلب إجازة)،
// وقسم الإدارة (الحاضرون الآن، ترتيب الموظفين بالساعات، الإجازات، الحوافز والغرامات، موظف الشهر).
import { dateTime, esc, localDate, money, parseAmount, time } from '../../../shared/format.js';
import { del, get, post, uid } from '../api.js';
import { icon } from '../icons.js';
import { busy, can, fail, field, modalFrame, on, openModal, render, state, toast } from '../ui.js';

const tz = () => state.settings?.tzOffsetMin ?? 180;
const thisMonth = () => localDate(Date.now(), tz()).slice(0, 7);
const hours = (min) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
const ROLES = { owner: 'المالك', manager: 'مدير', cashier: 'كاشير', barista: 'باريستا' };
const STATUS = { pending: ['بانتظار الموافقة', 'warn'], approved: ['موافق عليها', 'ok'], rejected: ['مرفوضة', 'bad'] };
const H = () => state.view.hr ?? (state.view.hr = { month: thisMonth(), tab: 'team' });

// ---------------------------------------------------------------- الحضور في الشريط العلوي
export async function loadMe() {
  try { state.me = await get('/api/hr/record/me', { month: thisMonth() }); } catch { state.me = null; }
}

export function clockButton(s) {
  const c = s.me?.clockedIn;
  if (s.me === undefined || s.online === false) return '';
  return c
    ? `<button class="tb-btn on" data-action="hr-clock" data-act="out" title="مسجّل حضور منذ ${time(c.inAt, tz())}">${icon('clock', 'sm')}<span>انصراف · ${hours(c.minutes)}</span></button>`
    : `<button class="tb-btn" data-action="hr-clock" data-act="in">${icon('clock', 'sm')}<span>تسجيل حضور</span></button>`;
}

// ---------------------------------------------------------------- سجل الموظف (يُستخدم لـ «سجلي» ولسجل أي موظف عند الإدارة)
function recordView(r, { self }) {
  const S = r.summary;
  const pay = S.salary !== undefined;
  return `<div class="kpis">
      <div class="kpi lead"><span class="label">ساعات العمل · ${esc(r.month)}</span><b class="num">${hours(S.minutes)}</b><span class="small">${S.days} يوم${S.rank ? ` · الترتيب ${S.rank}` : ''}</span></div>
      <div class="kpi"><span class="label">الحوافز</span><b style="color:var(--ok)">${money(S.bonus)}</b></div>
      <div class="kpi"><span class="label">الغرامات</span><b style="color:var(--bad)">${money(S.fine)}</b></div>
      ${pay ? `<div class="kpi"><span class="label">صافي الشهر</span><b>${money(S.net)}</b><span class="muted small">راتب ${money(S.salary)}</span></div>`
        : `<div class="kpi"><span class="label">إجازات مدفوعة</span><b class="num">${S.paidLeaveDays} يوم</b></div>`}</div>
    ${r.awards.includes(r.month) ? `<div class="alert-low" style="background:var(--gold-soft);color:var(--gold-ink);border-color:transparent">${icon('star')}<div><b>موظف الشهر</b><div class="small">${esc(r.month)}</div></div></div>` : ''}
    <div class="grid-2" style="align-items:start">
      <section class="card pad stack"><div class="row"><h2 style="margin-inline-end:auto">الحضور والانصراف</h2>${self ? clockButtonBig(r) : ''}</div>
        <div class="table-wrap" style="box-shadow:none"><table><thead><tr><th>اليوم</th><th>حضور</th><th>انصراف</th><th class="num">المدة</th>${self ? '' : '<th></th>'}</tr></thead><tbody>
        ${r.attendance.map((a) => `<tr><td class="small">${esc(a.day)}</td><td class="num">${time(a.inAt, tz())}</td>
          <td class="num">${a.outAt ? time(a.outAt, tz()) : a.forgot ? '<span class="pill bad">لم يُسجَّل</span>' : '<span class="pill ok">الآن</span>'}</td>
          <td class="num">${hours(a.minutes)}${a.fixed ? ` <span class="pill" title="${esc(a.fixed.note)}">مُصحَّح</span>` : ''}</td>
          ${self ? '' : `<td>${can('hr.manage') ? `<button class="btn sm ghost" data-action="hr-fix" data-id="${a.id}">تصحيح</button>` : ''}</td>`}</tr>`).join('') || `<tr><td colspan="${self ? 4 : 5}" class="muted">لا حضور مسجّل هذا الشهر</td></tr>`}
        </tbody></table></div></section>
      <section class="card pad stack"><h2>الحوافز والغرامات</h2>
        ${r.adjustments.map((a) => `<div class="r-line"><span><span class="pill ${a.type === 'bonus' ? 'ok' : 'bad'}">${a.type === 'bonus' ? 'حافز' : 'غرامة'}</span> ${esc(a.reason)} <span class="muted small">${esc(a.day)}</span></span>
          <span class="row" style="gap:6px"><b class="num">${a.type === 'bonus' ? '+' : '−'}${money(a.amount)}</b>${!self && can('hr.manage') ? `<button class="icon-btn" data-action="hr-adj-del" data-id="${a.id}" aria-label="حذف">${icon('x', 'sm')}</button>` : ''}</span></div>`).join('') || '<p class="muted">لا شيء هذا الشهر</p>'}
      </section></div>
    <section class="card pad stack"><div class="row wrap"><h2 style="margin-inline-end:auto">الإجازات</h2>
        <span class="pill olive">الرصيد السنوي المتبقي ${r.leaveBalance.left} من ${r.leaveBalance.total} يوم</span>
        ${self ? `<button class="btn sm primary" data-action="hr-leave-new">${icon('plus', 'sm')} طلب إجازة</button>` : ''}</div>
      ${r.leaves.map((l) => `<div class="r-line"><span>${esc(l.typeName)} · ${esc(l.from)} → ${esc(l.to)} <span class="muted small">(${l.days} يوم${l.paid ? '، مدفوعة' : ''})</span>${l.reason ? ` <span class="muted small">— ${esc(l.reason)}</span>` : ''}</span>
        <span class="pill ${STATUS[l.status][1]}">${STATUS[l.status][0]}</span></div>`).join('') || '<p class="muted">لا إجازات</p>'}
    </section>`;
}

function clockButtonBig(r) {
  return r.clockedIn
    ? `<button class="btn danger" data-action="hr-clock" data-act="out">${icon('clock', 'sm')} تسجيل انصراف (${hours(r.clockedIn.minutes)})</button>`
    : `<button class="btn primary" data-action="hr-clock" data-act="in">${icon('clock', 'sm')} تسجيل حضور</button>`;
}

export const routes = {
  me(s) {
    const r = s.view.me;
    return `<div class="page"><div class="page-head"><h1>سجلي</h1><span class="muted">${esc(s.employee?.name ?? '')} · ${ROLES[s.employee?.role] ?? ''}</span>
      <input type="month" id="me-month" value="${esc(r?.month ?? thisMonth())}" data-change="me-month" aria-label="الشهر"></div>
      ${r ? recordView(r, { self: true }) : '<p class="muted">جارٍ التحميل…</p>'}</div>`;
  },
};

export async function enter() {
  state.view.me = await get('/api/hr/record/me', { month: state.view.meMonth ?? thisMonth() });
  state.me = state.view.me.month === thisMonth() ? state.view.me : state.me;
  render();
}

// ---------------------------------------------------------------- قسم الإدارة
export async function loadHr() {
  const h = H();
  h.data = null; render();
  h.data = await get('/api/hr/overview', { month: h.month });
  render();
}

export function hrPage() {
  const h = H();
  const d = h.data;
  const TABS = [['team', 'الموظفون والترتيب'], ['present', 'الحاضرون الآن'], ['leaves', `الإجازات${d?.pending.length ? ` (${d.pending.length})` : ''}`]];
  const head = `<div class="page-head"><h1>الموارد البشرية</h1><input type="month" id="hr-month" value="${esc(h.month)}" max="${thisMonth()}" data-change="hr-month" aria-label="الشهر">
      <span class="spacer"></span>
      <button class="btn" data-action="hr-adj-new" data-type="bonus">${icon('plus', 'sm')} حافز</button>
      <button class="btn" data-action="hr-adj-new" data-type="fine">${icon('minus', 'sm')} غرامة</button>
      <button class="btn" data-action="hr-pool">توزيع حوافز حسب الساعات</button>
      <button class="btn primary" data-action="hr-award">${icon('star', 'sm')} موظف الشهر</button></div>
    <div class="toolbar"><div class="seg">${TABS.map(([k, l]) => `<button class="${h.tab === k ? 'on' : ''}" data-action="hr-tab" data-k="${k}">${l}</button>`).join('')}</div></div>`;
  if (!d) return `${head}<p class="muted">جارٍ التحميل…</p>`;
  const award = d.award ? `<div class="alert-low" style="background:var(--gold-soft);color:var(--gold-ink);border-color:transparent">${icon('star')}<div><b>موظف الشهر ${esc(d.month)}: ${esc(d.award.name)}</b>
    <div class="small">${d.award.bonus ? `مكافأة ${money(d.award.bonus)}` : ''}${d.award.note ? ` · ${esc(d.award.note)}` : ''}</div></div></div>` : '';
  if (h.tab === 'present') {
    return `${head}<div class="table-wrap"><table><thead><tr><th>الموظف</th><th>منذ</th><th class="num">المدة</th><th></th></tr></thead><tbody>
      ${d.present.map((a) => `<tr><td><b>${esc(a.employeeName)}</b></td><td class="small">${dateTime(a.inAt, tz())}</td><td class="num">${hours(a.minutes)} ${a.forgot ? '<span class="pill bad">نُسي الانصراف</span>' : ''}</td>
        <td><button class="btn sm" data-action="hr-fix" data-id="${a.id}">تسجيل انصراف / تصحيح</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">لا أحد مسجّل حضور الآن</td></tr>'}
      </tbody></table></div>
      ${d.onLeaveToday.length ? `<p class="small">في إجازة اليوم: ${d.onLeaveToday.map((l) => esc(l.employeeName)).join('، ')}</p>` : ''}`;
  }
  if (h.tab === 'leaves') {
    return `${head}<div class="stack">${d.pending.map((l) => `<div class="card pad row wrap"><div style="flex:1;min-width:0"><b>${esc(l.employeeName)}</b> · ${esc(l.typeName)} · ${esc(l.from)} → ${esc(l.to)} (${l.days} يوم${l.paid ? '، مدفوعة' : ''})
        ${l.reason ? `<div class="muted small">${esc(l.reason)}</div>` : ''}</div>
        <button class="btn sm primary" data-action="hr-leave-decide" data-id="${l.id}" data-s="approved">موافقة</button>
        <button class="btn sm danger" data-action="hr-leave-decide" data-id="${l.id}" data-s="rejected">رفض</button></div>`).join('') || '<p class="muted">لا طلبات إجازة معلّقة</p>'}</div>`;
  }
  return `${head}${award}<div class="table-wrap"><table><thead><tr><th>#</th><th>الموظف</th><th class="num">الساعات</th><th class="num">الأيام</th><th class="num">الحوافز</th><th class="num">الغرامات</th><th class="num">إجازة مدفوعة</th>${d.showPay ? '<th class="num">صافي الشهر</th>' : ''}</tr></thead><tbody>
    ${d.rows.map((r) => `<tr class="click" data-action="hr-open" data-id="${r.id}"><td class="num">${r.rank ?? '—'}</td>
      <td><b>${esc(r.name)}</b> <span class="muted small">${ROLES[r.role] ?? ''}</span>${r.employeeOfMonth ? ` <span class="pill olive">${icon('star', 'sm')} موظف الشهر</span>` : ''}${r.openNow ? ' <span class="pill ok">حاضر</span>' : ''}${r.forgot ? ' <span class="pill bad">نُسي الانصراف</span>' : ''}</td>
      <td class="num"><b>${hours(r.minutes)}</b></td><td class="num">${r.days}</td><td class="num">${r.bonus ? money(r.bonus) : '—'}</td><td class="num">${r.fine ? money(r.fine) : '—'}</td><td class="num">${r.paidLeaveDays || '—'}</td>
      ${d.showPay ? `<td class="num">${money(r.net)}</td>` : ''}</tr>`).join('')}</tbody></table></div>
    <p class="muted small">الترتيب حسب ساعات العمل المسجّلة في الشهر. الحضور المنسي (أكثر من 16 ساعة) لا يُحسب حتى يُصحَّح.</p>`;
}

/** تقسيم مبلغ على الساعات كما يفعل الخادم (للمعاينة قبل التأكيد) */
function splitPreview(weights, amount) {
  const total = weights.reduce((a, w) => a + w, 0);
  if (!total) return weights.map(() => 0);
  const shares = weights.map((w) => Math.floor((amount * w) / total));
  let left = amount - shares.reduce((a, x) => a + x, 0);
  const order = weights.map((w, i) => [((amount * w) % total), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) { if (!left) break; shares[i] += 1; left -= 1; }
  return shares;
}

export const modals = {
  'hr-record'(s) {
    const r = s.modal.record;
    return modalFrame({ title: `سجل ${r.employee.name}`, sub: `${ROLES[r.employee.role] ?? ''} · ${r.month}`, cls: 'full', body: recordView(r, { self: false }) });
  },
  'hr-adj'(s) {
    const m = s.modal;
    const rows = H().data?.rows ?? [];
    return modalFrame({ title: m.adjType === 'bonus' ? 'حافز لموظف' : 'غرامة على موظف', body: `<form class="stack" data-form="hr-adj-save" id="hr-adj-form">
      ${field('الموظف', `<select name="employeeId" id="adj-emp">${rows.filter((r) => r.active).map((r) => `<option value="${r.id}" ${r.id === m.employeeId ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select>`)}
      <div class="grid-2">${field('المبلغ (د.ع)', '<input class="amount-input" name="amount" id="adj-amount" inputmode="numeric" required autocomplete="off">')}
        ${field('السبب', `<input name="reason" id="adj-reason" required minlength="2" maxlength="160" placeholder="${m.adjType === 'bonus' ? 'خدمة ممتازة، ساعات إضافية' : 'تأخير، كسر أكواب'}">`)}</div>
      <button class="btn ${m.adjType === 'bonus' ? 'primary' : 'danger solid'} lg" type="submit" ${s.busy ? 'disabled' : ''}>تسجيل</button></form>` });
  },
  'hr-pool'(s) {
    const m = s.modal;
    const rows = (H().data?.rows ?? []).filter((r) => r.active && r.minutes > 0);
    const pool = parseAmount(m.pool ?? '') ?? 0;
    const shares = pool > 0 ? splitPreview(rows.map((r) => r.minutes), pool) : [];
    return modalFrame({ title: `توزيع حوافز ${H().month} حسب ساعات العمل`, body: `
      ${field('مبلغ الحوافز الكلي (د.ع)', `<input class="amount-input" id="pool-amount" inputmode="numeric" value="${esc(m.pool ?? '')}" data-input="hr-pool-amount" autocomplete="off">`, 'يُقسَّم على الموظفين بنسبة ساعات عمل كل واحد، والمجموع يساوي المبلغ بالضبط')}
      ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>الموظف</th><th class="num">الساعات</th><th class="num">الحصة</th></tr></thead><tbody>
        ${rows.map((r, i) => `<tr><td>${esc(r.name)}</td><td class="num">${hours(r.minutes)}</td><td class="num"><b>${shares[i] ? money(shares[i]) : '—'}</b></td></tr>`).join('')}</tbody></table></div>`
        : '<p class="muted">لا ساعات عمل مسجّلة في هذا الشهر</p>'}`,
    foot: `<button class="btn primary" data-action="hr-pool-save" ${pool > 0 && rows.length && !s.busy ? '' : 'disabled'}>تسجيل الحوافز</button>` });
  },
  'hr-award'(s) {
    const rows = (H().data?.rows ?? []).filter((r) => r.active);
    const pick = s.modal.employeeId ?? H().data?.award?.employeeId ?? rows[0]?.id;
    return modalFrame({ title: `موظف الشهر ${H().month}`, body: `<form class="stack" data-form="hr-award-save" id="hr-award-form">
      <p class="muted small">المقترح: الأعلى ساعات عمل. يمكنك اختيار غيره.</p>
      <div class="opts">${rows.map((r) => `<button type="button" class="opt ${r.id === pick ? 'on' : ''}" data-action="hr-award-pick" data-id="${r.id}"><span>${esc(r.name)}</span><small>${hours(r.minutes)} ساعة${r.rank ? ` · #${r.rank}` : ''}</small></button>`).join('')}</div>
      <div class="grid-2">${field('مكافأة (د.ع، اختياري)', `<input name="bonus" id="aw-bonus" inputmode="numeric" value="${esc(H().data?.award?.bonus || '')}">`)}
        ${field('ملاحظة', `<input name="note" id="aw-note" maxlength="160" value="${esc(H().data?.award?.note ?? '')}" placeholder="أفضل خدمة للزبائن">`)}</div>
      <button class="btn primary lg" type="submit" ${pick && !s.busy ? '' : 'disabled'}>${icon('star', 'sm')} اعتماد</button></form>` });
  },
  'hr-fix'(s) {
    const a = s.modal.att;
    const local = (d) => (d ? new Date(new Date(d).getTime() + tz() * 60000).toISOString().slice(0, 16) : '');
    return modalFrame({ title: `تصحيح حضور ${a.employeeName}`, body: `<form class="stack" data-form="hr-fix-save" id="hr-fix-form">
      <div class="grid-2">${field('وقت الحضور', `<input type="datetime-local" name="inAt" id="fx-in" value="${local(a.inAt)}" required>`)}
        ${field('وقت الانصراف', `<input type="datetime-local" name="outAt" id="fx-out" value="${local(a.outAt ?? (a.forgot ? null : new Date()))}">`, 'اتركه فارغاً إن كان ما زال حاضراً')}</div>
      ${field('السبب', '<input name="note" id="fx-note" required minlength="2" maxlength="160" placeholder="نسي تسجيل الانصراف">')}
      <button class="btn primary" type="submit" ${s.busy ? 'disabled' : ''}>حفظ التصحيح</button></form>` });
  },
  'hr-leave'(s) {
    const today = localDate(Date.now(), tz());
    return modalFrame({ title: 'طلب إجازة', body: `<form class="stack" data-form="hr-leave-save" id="hr-leave-form">
      <div class="seg">${[['annual', 'سنوية مدفوعة'], ['sick', 'مرضية'], ['unpaid', 'بدون راتب']].map(([k, l]) => `<button type="button" class="${(s.modal.leaveType ?? 'annual') === k ? 'on' : ''}" data-action="hr-leave-type" data-k="${k}">${l}</button>`).join('')}</div>
      <div class="grid-2">${field('من', `<input type="date" name="from" id="lv-from" min="${today}" required>`)}${field('إلى', `<input type="date" name="to" id="lv-to" min="${today}" required>`)}</div>
      ${field('السبب (اختياري)', '<input name="reason" id="lv-reason" maxlength="160">')}
      <button class="btn primary lg" type="submit" ${s.busy ? 'disabled' : ''}>إرسال الطلب</button></form>` });
  },
};

async function refreshAfterChange() {
  if (state.route === 'admin') await loadHr();
  if (state.route === 'me') await enter();
  if (state.modal?.type === 'hr-record') state.modal.record = await get(`/api/hr/record/${state.modal.record.employee.id}`, { month: H().month });
  render();
}

on({
  'hr-clock': (el) => busy(async () => {
    const r = await post('/api/hr/clock', { clientId: uid(), action: el.dataset.act });
    toast(el.dataset.act === 'in' ? `سُجّل حضورك ${time(r.attendance.inAt, tz())}` : `سُجّل انصرافك · ${hours(r.attendance.minutes)} ساعة`, 'ok');
    await loadMe();
    if (state.route === 'me') await enter();
  }),
  'me-month': (el) => { state.view.meMonth = el.value || thisMonth(); enter().catch(fail); },
  'hr-month': (el) => { H().month = el.value || thisMonth(); loadHr().catch(fail); },
  'hr-tab': (el) => { H().tab = el.dataset.k; render(); },
  'hr-open': (el) => busy(async () => openModal({ type: 'hr-record', record: await get(`/api/hr/record/${el.dataset.id}`, { month: H().month }) })),
  'hr-adj-new': (el) => openModal({ type: 'hr-adj', adjType: el.dataset.type, clientId: uid() }),
  'hr-adj-save': (_el, _e, d) => busy(async () => {
    const m = state.modal;
    const amount = parseAmount(d.amount);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('أدخل مبلغاً صحيحاً');
    await post('/api/hr/adjustments', { clientId: m.clientId, employeeId: d.employeeId, type: m.adjType, amount, reason: d.reason });
    state.modal = null;
    toast(m.adjType === 'bonus' ? 'سُجّل الحافز' : 'سُجّلت الغرامة', 'ok');
    await refreshAfterChange();
  }),
  'hr-adj-del': (el) => busy(async () => {
    const h = H();
    if (h.confirmDel !== el.dataset.id) { h.confirmDel = el.dataset.id; toast('اضغط مرة أخرى للحذف (يُسجَّل في سجل العمليات)'); return; }
    await del(`/api/hr/adjustments/${el.dataset.id}`);
    h.confirmDel = null;
    await refreshAfterChange();
  }),
  'hr-pool': () => openModal({ type: 'hr-pool', clientId: uid(), pool: '' }),
  'hr-pool-amount': (el) => { state.modal.pool = el.value; render(); },
  'hr-pool-save': () => busy(async () => {
    const r = await post('/api/hr/incentives', { clientId: state.modal.clientId, month: H().month, pool: parseAmount(state.modal.pool) });
    state.modal = null;
    toast(`وُزّعت حوافز بقيمة ${money(r.total)} على ${r.rows.length} موظف`, 'ok');
    await loadHr();
  }),
  'hr-award': () => openModal({ type: 'hr-award', employeeId: null }),
  'hr-award-pick': (el) => { state.modal.employeeId = el.dataset.id; render(); },
  'hr-award-save': (_el, _e, d) => busy(async () => {
    const pick = state.modal.employeeId ?? H().data?.award?.employeeId ?? (H().data?.rows ?? []).find((r) => r.active)?.id;
    const r = await post('/api/hr/award', { month: H().month, employeeId: pick, bonus: d.bonus ? parseAmount(d.bonus) : 0, note: d.note || null });
    state.modal = null;
    toast(`موظف الشهر: ${r.name}`, 'ok');
    await loadHr();
  }),
  'hr-fix': (el) => {
    const d = H().data;
    const a = d?.present.find((x) => x.id === el.dataset.id) ?? state.modal?.record?.attendance.find((x) => x.id === el.dataset.id);
    if (a) openModal({ type: 'hr-fix', att: a, back: state.modal?.type === 'hr-record' ? state.modal : null });
  },
  'hr-fix-save': (_el, _e, d) => busy(async () => {
    const m = state.modal;
    const toIso = (v) => (v ? new Date(new Date(`${v}:00Z`).getTime() - tz() * 60000).toISOString() : null);
    await post(`/api/hr/attendance/${m.att.id}/fix`, { inAt: toIso(d.inAt), outAt: toIso(d.outAt), note: d.note });
    state.modal = m.back;
    toast('حُفظ التصحيح', 'ok');
    await refreshAfterChange();
  }),
  'hr-leave-new': () => openModal({ type: 'hr-leave', clientId: uid(), leaveType: 'annual' }),
  'hr-leave-type': (el) => { state.modal.leaveType = el.dataset.k; render(); },
  'hr-leave-save': (_el, _e, d) => busy(async () => {
    await post('/api/hr/leaves', { clientId: state.modal.clientId, from: d.from, to: d.to, type: state.modal.leaveType, reason: d.reason || null });
    state.modal = null;
    toast('أُرسل طلب الإجازة للموافقة', 'ok');
    await enter();
  }),
  'hr-leave-decide': (el) => busy(async () => {
    await post(`/api/hr/leaves/${el.dataset.id}/decide`, { status: el.dataset.s });
    toast(el.dataset.s === 'approved' ? 'تمت الموافقة على الإجازة' : 'رُفضت الإجازة', 'ok');
    await loadHr();
  }),
});
