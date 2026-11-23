// الموارد البشرية: صفحة «سجلي» لكل موظف (حضور/انصراف، ساعاته، تأخيره وغيابه، حوافزه وغراماته، إجازاته، قسيمة راتبه وسلفه)،
// وقسم الإدارة (الموظفون والأداء، الحاضرون، التأخير والغياب، جدول الدوام، الإجازات، السلف، الرواتب، موظف الشهر، الإعدادات).
import { dateTime, esc, localDate, money, parseAmount, time } from '../../../shared/format.js';
import { del, get, post, uid } from '../api.js';
import { icon } from '../icons.js';
import { busy, can, fail, field, modalFrame, on, openModal, render, state, toast } from '../ui.js';
import { printHtml } from './receipts.js';

const tz = () => state.settings?.tzOffsetMin ?? 180;
const thisMonth = () => localDate(Date.now(), tz()).slice(0, 7);
const hours = (min) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
const ROLES = { owner: 'المالك', manager: 'مدير', cashier: 'كاشير', barista: 'باريستا' };
const STATUS = { pending: ['بانتظار الموافقة', 'warn'], approved: ['موافق عليها', 'ok'], rejected: ['مرفوضة', 'bad'] };
const H = () => state.view.hr ?? (state.view.hr = { month: thisMonth(), tab: 'team' });
const DAYS = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const WEEK_ORDER = [6, 0, 1, 2, 3, 4, 5]; // يبدأ الأسبوع بالسبت
const PAY_TYPES = { monthly: 'راتب شهري', hourly: 'أجر بالساعة' };
const plain = (v) => Number(v ?? 0).toLocaleString('en-US');

// ---------------------------------------------------------------- الحضور في الشريط العلوي
export async function loadMe() {
  try { state.me = await get('/api/hr/record/me', { month: thisMonth() }); } catch { state.me = null; }
}

export function clockButton(s) {
  const c = s.me?.clockedIn;
  if (s.me === undefined || s.online === false) return '';
  if (c?.forgot) return `<a class="tb-btn warn" href="#/me" title="حضور مفتوح منذ ${dateTime(c.inAt, tz())}">${icon('clock', 'sm')}<span>نسيت الانصراف؟</span></a>`;
  return c
    ? `<button class="tb-btn on" data-action="hr-clock" data-act="out" title="مسجّل حضور منذ ${time(c.inAt, tz())}">${icon('clock', 'sm')}<span>انصراف · ${hours(c.minutes)}</span></button>`
    : `<button class="tb-btn" data-action="hr-clock" data-act="in">${icon('clock', 'sm')}<span>تسجيل حضور</span></button>`;
}

// ---------------------------------------------------------------- سجل الموظف (يُستخدم لـ «سجلي» ولسجل أي موظف عند الإدارة)
function recordView(r, { self }) {
  const S = r.summary;
  const pay = S.salary !== undefined;
  const p = r.profile;
  return `${r.clockedIn?.forgot ? `<div class="alert-low">${icon('alert')}<div><b>حضور مفتوح منذ ${esc(dateTime(r.clockedIn.inAt, tz()))}</b><div class="small">${self ? 'يبدو أنك نسيت تسجيل الانصراف. سجّله الآن، أو اطلب من المدير تصحيح الوقت.' : 'نُسي تسجيل الانصراف: صحّح الوقت من جدول الحضور.'}</div></div></div>` : ''}
    <div class="kpis">
      <div class="kpi lead"><span class="label">ساعات العمل · ${esc(r.month)}</span><b class="num">${hours(S.minutes)}</b><span class="small">${S.days} يوم${S.rank ? ` · الترتيب ${S.rank}` : ''}</span></div>
      <div class="kpi"><span class="label">التأخير</span><b class="num" style="color:${S.lateCount ? 'var(--warn)' : 'inherit'}">${S.lateCount ?? 0} مرة</b><span class="muted small">${hours(S.lateMin ?? 0)} ساعة</span></div>
      <div class="kpi"><span class="label">الغياب</span><b class="num" style="color:${S.absentDays ? 'var(--bad)' : 'inherit'}">${S.absentDays ?? 0} يوم</b><span class="muted small">إضافي ${hours(S.overtimeMin ?? 0)}</span></div>
      <div class="kpi"><span class="label">الحوافز − الغرامات</span><b><span style="color:var(--ok)">${money(S.bonus)}</span></b><span class="small" style="color:var(--bad)">− ${money(S.fine)}</span></div>
      ${pay ? `<div class="kpi"><span class="label">صافي الشهر</span><b>${money(S.net)}</b><span class="muted small">${r.payroll?.paid ? 'مصروف' : 'تقديري حتى الصرف'}</span></div>`
        : `<div class="kpi"><span class="label">إجازات مدفوعة</span><b class="num">${S.paidLeaveDays} يوم</b></div>`}
      ${S.perf?.sales ? `<div class="kpi"><span class="label">مبيعاته</span><b>${money(S.perf.salesTotal)}</b><span class="muted small">${S.perf.sales} طلب${S.perf.cancels ? ` · ${S.perf.cancels} إلغاء` : ''}</span></div>` : ''}</div>
    ${r.awards.includes(r.month) ? `<div class="alert-low" style="background:var(--gold-soft);color:var(--gold-ink);border-color:transparent">${icon('star')}<div><b>موظف الشهر</b><div class="small">${esc(r.month)}</div></div></div>` : ''}
    ${r.payroll ? payslipCard(r.payroll, { self }) : ''}
    ${profileCard(p, { self, schedule: true })}
    ${r.late.length || r.absent.length ? `<section class="card pad stack"><h2>التأخير والغياب</h2>
      ${r.late.map((l) => `<div class="r-line"><span>${esc(DAYS[new Date(`${l.day}T00:00:00Z`).getUTCDay()])} ${esc(l.day)} · الدوام ${esc(l.start)} · حضر ${time(l.inAt, tz())}</span><span class="pill warn">تأخير ${l.lateMin} د</span></div>`).join('')}
      ${r.absent.map((d) => `<div class="r-line"><span>${esc(DAYS[new Date(`${d}T00:00:00Z`).getUTCDay()])} ${esc(d)}</span><span class="pill bad">غياب</span></div>`).join('')}</section>` : ''}
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
    </section>
    ${(r.advances ?? []).length ? `<section class="card pad stack"><h2>السلف</h2>${r.advances.map(advLine).join('')}</section>` : ''}`;
}

const advLine = (a) => `<div class="r-line"><span>${money(a.amount)} <span class="muted small">${esc(String(a.createdAt).slice(0, 10))} · ${a.installments} قسط × ${money(a.perMonth)} من ${esc(a.startMonth)}${a.note ? ` — ${esc(a.note)}` : ''}</span></span>
  <span class="pill ${a.remaining ? 'warn' : 'ok'}">${a.remaining ? `متبقٍ ${money(a.remaining)}` : 'سُدّدت'}</span></div>`;

function scheduleText(sch) {
  if (!sch) return 'بلا جدول';
  return WEEK_ORDER.map((d) => (sch[d] ? `${DAYS[d]} ${sch[d].start}–${sch[d].end}` : null)).filter(Boolean).join(' · ');
}

function profileCard(p, { self }) {
  if (!p) return '';
  const item = (label, v) => (v ? `<div><span class="muted small">${label}</span><div>${esc(v)}</div></div>` : '');
  return `<section class="card pad stack"><div class="row"><h2 style="margin-inline-end:auto">${self ? 'بياناتي' : 'ملف الموظف'}</h2>
      ${!self && can('hr.manage') ? `<button class="btn sm" data-action="hr-profile" data-id="${p.id}">${icon('edit', 'sm')} تعديل</button>` : ''}</div>
    <div class="grid-3">${item('الهاتف', p.phone)}${item('تاريخ التعيين', p.hiredAt)}${item('رقم الهوية', p.nationalId)}${item('للطوارئ', p.emergency)}
      ${p.payType ? item('الأجر', p.payType === 'hourly' ? `${plain(p.hourlyRate)} د.ع للساعة` : `${plain(p.salary)} د.ع شهرياً`) : ''}</div>
    <div class="small"><span class="muted">جدول الدوام:</span> ${esc(scheduleText(p.schedule))}</div>
    ${p.notes && !self ? `<div class="small muted">${esc(p.notes)}</div>` : ''}</section>`;
}

/** قسيمة الراتب: سطور الاستحقاق والخصم بالتفصيل، مع طباعة 80 مم ومشاركة */
function payLines(x) {
  return [
    [x.payType === 'hourly' ? `أجر ${hours(x.minutes)} ساعة × ${plain(x.hourlyRate)}` : 'الراتب الأساسي', x.base, 1],
    [`ساعات إضافية (${hours(x.overtimeMin)})`, x.overtimePay, 1],
    ['حوافز', x.bonus, 1],
    ['غرامات', x.fine, -1],
    [`إجازة بلا راتب (${x.unpaidLeaveDays} يوم)`, x.leaveDeduction, -1],
    [`غياب (${x.absentDays} يوم)`, x.absenceDeduction, -1],
    ['قسط السلفة', x.advance, -1],
  ].filter(([, v]) => v);
}

function payslipCard(x, { self }) {
  return `<section class="card pad stack"><div class="row wrap"><h2 style="margin-inline-end:auto">قسيمة الراتب · ${esc(x.month)}</h2>
      <span class="pill ${x.paid ? 'ok' : 'warn'}">${x.paid ? `صُرف ${esc(dateTime(x.paidAt, tz()))}` : 'لم يُصرف بعد'}</span>
      <button class="btn sm" data-action="hr-slip-print" data-src="${self ? 'me' : 'record'}">${icon('print', 'sm')} طباعة</button>
      <button class="btn sm" data-action="hr-slip-share" data-src="${self ? 'me' : 'record'}">${icon('arrow', 'sm')} مشاركة</button></div>
    ${payLines(x).map(([l, v, sign]) => `<div class="r-line"><span>${esc(l)}</span><span class="num" style="color:${sign < 0 ? 'var(--bad)' : 'inherit'}">${sign < 0 ? '− ' : ''}${money(v)}</span></div>`).join('')}
    <div class="r-line" style="font-size:1.1rem"><b>الصافي</b><b class="num">${money(x.net)}</b></div>
    ${x.shortfall ? `<p class="small" style="color:var(--bad)">الخصومات أكبر من المستحق بـ ${money(x.shortfall)}، فالصافي صفر.</p>` : ''}</section>`;
}

function slipHtml(x) {
  const row = (a, b) => `<div class="row80"><span>${a}</span><span>${b}</span></div>`;
  return `<div class="paper80"><div class="c big">${esc(state.settings?.name ?? state.shop?.name ?? '')}</div><div class="c">قسيمة راتب · ${esc(x.month)}</div><hr>
    ${row('الموظف', esc(x.name ?? ''))}${row('نوع الأجر', PAY_TYPES[x.payType] ?? '')}<hr>
    ${payLines(x).map(([l, v, sign]) => row(esc(l), `${sign < 0 ? '-' : ''}${plain(v)}`)).join('')}<hr>
    ${row('<b>الصافي د.ع</b>', `<b>${plain(x.net)}</b>`)}
    <hr><div class="c">${x.paid ? `صُرف ${esc(dateTime(x.paidAt, tz()))}${x.paidByName ? ` · ${esc(x.paidByName)}` : ''}` : 'تقديري — لم يُصرف بعد'}</div>
    <br><div class="row80"><span>توقيع الموظف: ............</span></div></div>`;
}

function slipText(x) {
  return [`قسيمة راتب ${x.month} — ${x.name ?? ''}`, ...payLines(x).map(([l, v, sign]) => `${l}: ${sign < 0 ? '-' : ''}${plain(v)}`), `الصافي: ${plain(x.net)} د.ع`, x.paid ? 'مصروف' : 'تقديري'].join('\n');
}

async function shareText(text, title) {
  if (navigator.share) {
    try { await navigator.share({ title, text }); } catch (e) { if (e?.name !== 'AbortError') toast('تعذرت المشاركة', 'bad'); }
    return;
  }
  try { await navigator.clipboard.writeText(text); toast('نُسخت القسيمة — الصقها في واتساب'); } catch { toast('تعذر النسخ', 'bad'); }
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
  const [data, payroll] = await Promise.all([get('/api/hr/overview', { month: h.month }), can('admin.employees') ? get('/api/hr/payroll', { month: h.month }) : null]);
  Object.assign(h, { data, payroll, advances: payroll?.advances ?? null });
  if (state.me) state.me.pendingLeaves = data.pending.length; // شارة القائمة الجانبية
  render();
}

export function hrPage() {
  const h = H();
  const d = h.data;
  const owner = can('admin.employees');
  const lateOpen = (d?.late ?? []).filter((l) => !l.fined).length;
  const TABS = [['team', 'الموظفون والأداء'], ['present', 'الحاضرون الآن'], ['late', `التأخير والغياب${lateOpen ? ` (${lateOpen})` : ''}`], ['schedule', 'جدول الدوام'],
    ['leaves', `الإجازات${d?.pending.length ? ` (${d.pending.length})` : ''}`], ['advances', 'السلف'], ...(owner ? [['payroll', 'الرواتب']] : [])];
  const head = `<div class="page-head"><h1>الموارد البشرية</h1><input type="month" id="hr-month" value="${esc(h.month)}" max="${thisMonth()}" data-change="hr-month" aria-label="الشهر">
      <span class="spacer"></span>
      <button class="btn" data-action="hr-adj-new" data-type="bonus">${icon('plus', 'sm')} حافز</button>
      <button class="btn" data-action="hr-adj-new" data-type="fine">${icon('minus', 'sm')} غرامة</button>
      <button class="btn" data-action="hr-adv-new">${icon('wallet', 'sm')} سلفة</button>
      <button class="btn" data-action="hr-pool">توزيع حوافز حسب الساعات</button>
      <button class="btn primary" data-action="hr-award">${icon('star', 'sm')} موظف الشهر</button>
      ${owner ? `<button class="icon-btn" data-action="hr-policy" title="إعدادات الموارد البشرية" aria-label="إعدادات الموارد البشرية">${icon('gear')}</button>` : ''}</div>
    <div class="toolbar"><div class="seg wrap-seg">${TABS.map(([k, l]) => `<button class="${h.tab === k ? 'on' : ''}" data-action="hr-tab" data-k="${k}">${l}</button>`).join('')}</div></div>`;
  if (!d) return `${head}<p class="muted">جارٍ التحميل…</p>`;
  const award = d.award ? `<div class="alert-low" style="background:var(--gold-soft);color:var(--gold-ink);border-color:transparent">${icon('star')}<div><b>موظف الشهر ${esc(d.month)}: ${esc(d.award.name)}</b>
    <div class="small">${d.award.bonus ? `مكافأة ${money(d.award.bonus)}` : ''}${d.award.note ? ` · ${esc(d.award.note)}` : ''}</div></div></div>` : '';
  const body = {
    present: () => `<div class="table-wrap"><table><thead><tr><th>الموظف</th><th>منذ</th><th class="num">المدة</th><th></th></tr></thead><tbody>
      ${d.present.map((a) => `<tr><td><b>${esc(a.employeeName)}</b></td><td class="small">${dateTime(a.inAt, tz())}</td><td class="num">${hours(a.minutes)} ${a.forgot ? '<span class="pill bad">نُسي الانصراف</span>' : ''}</td>
        <td><button class="btn sm" data-action="hr-fix" data-id="${a.id}">تسجيل انصراف / تصحيح</button></td></tr>`).join('') || '<tr><td colspan="4" class="muted">لا أحد مسجّل حضور الآن</td></tr>'}
      </tbody></table></div>
      ${d.onLeaveToday.length ? `<p class="small">في إجازة اليوم: ${d.onLeaveToday.map((l) => esc(l.employeeName)).join('، ')}</p>` : ''}`,
    leaves: () => `<div class="stack">${d.pending.map((l) => `<div class="card pad row wrap"><div style="flex:1;min-width:0"><b>${esc(l.employeeName)}</b> · ${esc(l.typeName)} · ${esc(l.from)} → ${esc(l.to)} (${l.days} يوم${l.paid ? '، مدفوعة' : ''})
        ${l.reason ? `<div class="muted small">${esc(l.reason)}</div>` : ''}</div>
        <button class="btn sm primary" data-action="hr-leave-decide" data-id="${l.id}" data-s="approved">موافقة</button>
        <button class="btn sm danger" data-action="hr-leave-decide" data-id="${l.id}" data-s="rejected">رفض</button></div>`).join('') || '<p class="muted">لا طلبات إجازة معلّقة</p>'}</div>`,
    late: () => {
      const absent = d.rows.filter((r) => r.absentDays);
      return `<div class="row wrap"><p class="muted small" style="margin:0;flex:1">التأخير بعد سماح ${d.policy.graceMin} دقيقة من بداية الدوام. ${d.policy.lateFine ? `الغرامة المقترحة ${money(d.policy.lateFine)} لكل ${d.policy.lateStepMin} دقيقة.` : 'غرامة التأخير المقترحة معطّلة من الإعدادات.'}</p>
        ${lateOpen && d.policy.lateFine ? `<button class="btn danger" data-action="hr-late-all">تسجيل كل غرامات التأخير</button>` : ''}</div>
        <div class="table-wrap"><table><thead><tr><th>الموظف</th><th>اليوم</th><th>الدوام</th><th>الحضور</th><th class="num">التأخير</th><th class="num">الغرامة المقترحة</th><th></th></tr></thead><tbody>
        ${d.late.map((l) => `<tr><td><b>${esc(l.employeeName)}</b></td><td class="small">${esc(DAYS[new Date(`${l.day}T00:00:00Z`).getUTCDay()])} ${esc(l.day)}</td><td class="num">${esc(l.start)}</td><td class="num">${time(l.inAt, tz())}</td>
          <td class="num"><span class="pill warn">${l.lateMin} د</span></td><td class="num">${l.fine ? money(l.fine) : '—'}</td>
          <td>${l.fined ? '<span class="pill">سُجّلت</span>' : l.fine ? `<button class="btn sm" data-action="hr-late-one" data-id="${l.attendanceId}">تسجيل الغرامة</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">لا تأخير هذا الشهر (أو لا جداول دوام محددة)</td></tr>'}
        </tbody></table></div>
        <section class="card pad stack"><h2>الغياب</h2>${absent.map((r) => `<div class="r-line"><span><b>${esc(r.name)}</b></span><span class="pill bad">${r.absentDays} يوم</span></div>`).join('') || '<p class="muted">لا غياب: كل أيام الدوام فيها حضور أو إجازة.</p>'}
          <p class="muted small">يوم الغياب = يوم دوام في الجدول، قبل اليوم، بلا حضور ولا إجازة.${d.policy.deductAbsence ? ' يُخصم من الراتب الشهري بأجر يوم (الراتب ÷ 30).' : ''}</p></section>`;
    },
    schedule: () => `<p class="muted small">اضغط على موظف لتعديل جدوله وبياناته. بلا جدول لا يُحسب تأخير ولا غياب ولا إضافي.</p>
      <div class="table-wrap"><table><thead><tr><th>الموظف</th>${WEEK_ORDER.map((i) => `<th>${DAYS[i]}</th>`).join('')}</tr></thead><tbody>
      ${d.team.map((p) => `<tr class="click" data-action="hr-profile" data-id="${p.id}"><td><b>${esc(p.name)}</b> <span class="muted small">${ROLES[p.role] ?? ''}</span></td>
        ${WEEK_ORDER.map((i) => `<td class="num small">${p.schedule?.[i] ? `${p.schedule[i].start}–${p.schedule[i].end}` : '<span class="muted">عطلة</span>'}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`,
    advances: () => {
      const list = h.advances;
      if (!owner && !list) return '<p class="muted small">السلف وأرصدتها يراها المالك في تبويب الرواتب. يمكنك تسجيل سلفة جديدة من الزر أعلاه.</p>';
      return `${(list ?? []).map((a) => `<div class="card pad row wrap"><div style="flex:1;min-width:0"><b>${esc(a.employeeName)}</b> ${advLine(a)}</div>
        ${!a.repaid ? `<button class="btn sm ghost danger" data-action="hr-adv-cancel" data-id="${a.id}">إلغاء</button>` : ''}</div>`).join('') || '<p class="muted">لا سلف قائمة</p>'}
        <p class="muted small">السلفة تُسجَّل مصروفاً (سلف موظفين) يوم صرفها، وأقساطها تُخصم تلقائياً من الراتب عند الصرف.</p>`;
    },
    payroll: () => payrollView(h),
    team: () => {
      const rows = [...d.rows].sort(h.sort === 'sales' ? (a, b) => b.perf.salesTotal - a.perf.salesTotal : () => 0);
      return `${award}<div class="row"><span class="muted small" style="flex:1">الترتيب حسب ساعات العمل المسجّلة. الحضور المنسي (أكثر من 16 ساعة) لا يُحسب حتى يُصحَّح.</span>
        <div class="seg"><button class="${h.sort !== 'sales' ? 'on' : ''}" data-action="hr-sort" data-k="hours">بالساعات</button><button class="${h.sort === 'sales' ? 'on' : ''}" data-action="hr-sort" data-k="sales">بالمبيعات</button></div></div>
      <div class="table-wrap"><table><thead><tr><th>#</th><th>الموظف</th><th class="num">الساعات</th><th class="num">الأيام</th><th class="num">تأخير</th><th class="num">غياب</th><th class="num">إضافي</th><th class="num">المبيعات</th><th class="num">الحوافز</th><th class="num">الغرامات</th>${d.showPay ? '<th class="num">صافي تقديري</th>' : ''}</tr></thead><tbody>
      ${rows.map((r) => `<tr class="click" data-action="hr-open" data-id="${r.id}"><td class="num">${r.rank ?? '—'}</td>
        <td><b>${esc(r.name)}</b> <span class="muted small">${ROLES[r.role] ?? ''}</span>${r.employeeOfMonth ? ` <span class="pill olive">${icon('star', 'sm')} موظف الشهر</span>` : ''}${r.openNow ? ' <span class="pill ok">حاضر</span>' : ''}${r.forgot ? ' <span class="pill bad">نُسي الانصراف</span>' : ''}</td>
        <td class="num"><b>${hours(r.minutes)}</b></td><td class="num">${r.days}</td>
        <td class="num">${r.lateCount ? `<span class="pill warn">${r.lateCount}</span>` : '—'}</td><td class="num">${r.absentDays ? `<span class="pill bad">${r.absentDays}</span>` : '—'}</td>
        <td class="num">${r.overtimeMin ? hours(r.overtimeMin) : '—'}</td>
        <td class="num">${r.perf.sales ? `${money(r.perf.salesTotal)} <span class="muted small">(${r.perf.sales})</span>` : '—'}</td>
        <td class="num">${r.bonus ? money(r.bonus) : '—'}</td><td class="num">${r.fine ? money(r.fine) : '—'}</td>
        ${d.showPay ? `<td class="num">${money(r.net)}</td>` : ''}</tr>`).join('')}</tbody></table></div>`;
    },
  };
  return `${head}${(body[h.tab] ?? body.team)()}`;
}

function payrollView(h) {
  const p = h.payroll;
  if (!p) return '<p class="muted">جارٍ التحميل…</p>';
  const unpaid = p.rows.filter((r) => !r.paid);
  return `<div class="kpis"><div class="kpi lead"><span class="label">صافي رواتب ${esc(p.month)}</span><b>${money(p.totals.net)}</b><span class="small">${p.rows.length} موظف</span></div>
      <div class="kpi"><span class="label">مصروف</span><b style="color:var(--ok)">${money(p.totals.paid)}</b></div>
      <div class="kpi"><span class="label">لم يُصرف</span><b style="color:var(--warn)">${money(p.totals.unpaid)}</b></div>
      <div class="kpi"><span class="label">أقساط السلف</span><b>${money(p.totals.advance)}</b></div></div>
    <div class="row wrap"><label class="row small" style="gap:6px;flex:1"><input type="checkbox" id="pay-drawer" ${h.payFromDrawer ? 'checked' : ''} data-change="hr-pay-drawer"> الدفع من درج الوردية المفتوحة (وإلا: من خارج الدرج)</label>
      ${unpaid.length ? `<button class="btn primary" data-action="hr-pay" data-id="">${icon('cash', 'sm')} صرف كل الرواتب (${money(unpaid.reduce((a, r) => a + r.net, 0))})</button>` : ''}</div>
    <div class="table-wrap"><table><thead><tr><th>الموظف</th><th>الأجر</th><th class="num">المستحق</th><th class="num">الخصومات</th><th class="num">السلفة</th><th class="num">الصافي</th><th></th></tr></thead><tbody>
    ${p.rows.map((r) => {
      const plus = r.base + r.overtimePay + r.bonus;
      const minus = r.fine + r.leaveDeduction + r.absenceDeduction;
      return `<tr><td><b>${esc(r.name)}</b>${r.shortfall ? ' <span class="pill bad">عجز</span>' : ''}</td><td class="small">${PAY_TYPES[r.payType]}${r.payType === 'hourly' ? ` · ${hours(r.minutes)}` : ''}</td>
        <td class="num">${money(plus)}</td><td class="num" style="color:var(--bad)">${minus ? `− ${money(minus)}` : '—'}</td><td class="num">${r.advance ? `− ${money(r.advance)}` : '—'}</td><td class="num"><b>${money(r.net)}</b></td>
        <td class="row" style="gap:6px;justify-content:flex-end"><button class="btn sm ghost" data-action="hr-slip" data-id="${r.employeeId}">القسيمة</button>
          ${r.paid ? `<span class="pill ok">مصروف</span><button class="btn sm ghost danger" data-action="hr-pay-cancel" data-id="${r.id}">إلغاء</button>` : `<button class="btn sm primary" data-action="hr-pay" data-id="${r.employeeId}">صرف</button>`}</td></tr>`;
    }).join('') || '<tr><td colspan="7" class="muted">لا موظفين</td></tr>'}</tbody></table></div>
    <p class="muted small">الصرف يُقفل قسيمة الشهر (لا تتغير حوافزه وغراماته وحضوره) ويسجّل الصافي مصروف «رواتب» فيظهر في صافي الربح. إلغاء الصرف يحذف المصروف ويفتح الشهر.</p>
    ${p.advances.length ? `<section class="card pad stack"><h2>السلف القائمة</h2>${p.advances.map((a) => `<div class="row wrap"><b>${esc(a.employeeName)}</b> <div style="flex:1">${advLine(a)}</div>${!a.repaid ? `<button class="btn sm ghost danger" data-action="hr-adv-cancel" data-id="${a.id}">إلغاء</button>` : ''}</div>`).join('')}</section>` : ''}`;
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
  'hr-profile'(s) {
    const m = s.modal;
    const p = m.p;
    const owner = can('admin.employees');
    const dayRow = (i) => {
      const d = p.schedule?.[i];
      return `<div class="sched-row"><label class="row small" style="gap:6px;min-width:96px"><input type="checkbox" ${d ? 'checked' : ''} data-change="hr-sched-on" data-i="${i}" id="sc-on-${i}"> ${DAYS[i]}</label>
        ${d ? `<input type="time" value="${esc(d.start)}" data-change="hr-sched-t" data-i="${i}" data-k="start" id="sc-s-${i}" aria-label="بداية ${DAYS[i]}"><span>→</span><input type="time" value="${esc(d.end)}" data-change="hr-sched-t" data-i="${i}" data-k="end" id="sc-e-${i}" aria-label="نهاية ${DAYS[i]}">` : '<span class="muted small">عطلة</span>'}</div>`;
    };
    return modalFrame({ title: `ملف ${p.name}`, sub: ROLES[p.role] ?? '', cls: 'wide', body: `<div class="stack">
      <div class="grid-3">${field('الهاتف', `<input id="pf-phone" data-input="hr-pf" data-k="phone" value="${esc(p.phone ?? '')}" inputmode="tel" maxlength="20">`)}
        ${field('تاريخ التعيين', `<input type="date" id="pf-hired" data-change="hr-pf" data-k="hiredAt" value="${esc(p.hiredAt ?? '')}">`, 'الغياب يُحسب من هذا اليوم')}
        ${field('رقم الهوية', `<input id="pf-nid" data-input="hr-pf" data-k="nationalId" value="${esc(p.nationalId ?? '')}" maxlength="30">`)}</div>
      <div class="grid-2">${field('رقم للطوارئ', `<input id="pf-em" data-input="hr-pf" data-k="emergency" value="${esc(p.emergency ?? '')}" maxlength="60" placeholder="الاسم والرقم">`)}
        ${field('ملاحظات', `<input id="pf-notes" data-input="hr-pf" data-k="notes" value="${esc(p.notes ?? '')}" maxlength="300">`)}</div>
      ${owner ? `<div class="stack" style="gap:8px"><span class="label">الأجر</span><div class="row wrap">
        <div class="seg">${Object.entries(PAY_TYPES).map(([k, l]) => `<button type="button" class="${(p.payType ?? 'monthly') === k ? 'on' : ''}" data-action="hr-pf-pay" data-k="${k}">${l}</button>`).join('')}</div>
        ${(p.payType ?? 'monthly') === 'hourly' ? `<input id="pf-rate" class="amount-input" style="max-width:180px" data-input="hr-pf" data-k="hourlyRate" value="${esc(p.hourlyRate || '')}" inputmode="numeric" placeholder="د.ع للساعة" aria-label="أجر الساعة">`
          : `<input id="pf-salary" class="amount-input" style="max-width:180px" data-input="hr-pf" data-k="salary" value="${esc(p.salary || '')}" inputmode="numeric" placeholder="د.ع شهرياً" aria-label="الراتب الشهري">`}</div></div>` : ''}
      <div class="row"><h3 style="margin-inline-end:auto">جدول الدوام الأسبوعي</h3><button type="button" class="btn sm ghost" data-action="hr-sched-copy">نسخ أول يوم على كل الأيام</button></div>
      <div class="sched">${WEEK_ORDER.map(dayRow).join('')}</div>
      <p class="muted small">الدوام الذي ينتهي بعد منتصف الليل مقبول (مثلاً 16:00 → 01:00).</p></div>`,
    foot: `<button class="btn primary" data-action="hr-profile-save" ${s.busy ? 'disabled' : ''}>حفظ</button>` });
  },
  'hr-adv'(s) {
    const rows = (H().data?.rows ?? []).filter((r) => r.active);
    return modalFrame({ title: 'سلفة لموظف', body: `<form class="stack" data-form="hr-adv-save" id="hr-adv-form">
      ${field('الموظف', `<select name="employeeId" id="adv-emp">${rows.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select>`)}
      <div class="grid-2">${field('المبلغ (د.ع)', '<input class="amount-input" name="amount" id="adv-amount" inputmode="numeric" required autocomplete="off">')}
        ${field('عدد الأقساط', `<select name="installments" id="adv-inst">${[1, 2, 3, 4, 5, 6, 8, 10, 12].map((n) => `<option value="${n}">${n === 1 ? 'دفعة واحدة' : `${n} أشهر`}</option>`).join('')}</select>`, 'تُخصم من الراتب ابتداءً من هذا الشهر')}</div>
      ${field('ملاحظة', '<input name="note" id="adv-note" maxlength="120">')}
      ${s.shift && can('shift.cash') ? '<label class="row small" style="gap:6px"><input type="checkbox" name="fromDrawer" id="adv-drawer" checked> صُرفت نقداً من درج الوردية المفتوحة (تُسجَّل سحباً منه)</label>' : ''}
      <button class="btn primary lg" type="submit" ${s.busy ? 'disabled' : ''}>تسجيل السلفة</button></form>` });
  },
  'hr-policy'(s) {
    const p = s.modal.policy;
    return modalFrame({ title: 'إعدادات الموارد البشرية', body: `<form class="stack" data-form="hr-policy-save" id="hr-policy-form">
      <div class="grid-3">${field('سماح التأخير (دقيقة)', `<input name="graceMin" id="po-grace" inputmode="numeric" value="${p.graceMin}">`)}
        ${field('غرامة التأخير (د.ع)', `<input name="lateFine" id="po-fine" inputmode="numeric" value="${p.lateFine}">`, '0 = بلا غرامة مقترحة')}
        ${field('لكل (دقيقة)', `<input name="lateStepMin" id="po-step" inputmode="numeric" value="${p.lateStepMin}">`)}</div>
      <div class="grid-2">${field('أجر الساعة الإضافية (د.ع)', `<input name="overtimeHourly" id="po-ot" inputmode="numeric" value="${p.overtimeHourly}">`, 'للراتب الشهري فقط. 0 = بلا')}
        ${field('حد السلف من الراتب (%)', `<input name="advanceMaxPct" id="po-adv" inputmode="numeric" value="${p.advanceMaxBp / 100}">`, '0 = بلا حد')}</div>
      <label class="row small" style="gap:6px"><input type="checkbox" name="deductAbsence" id="po-abs" ${p.deductAbsence ? 'checked' : ''}> خصم أيام الغياب من الراتب الشهري (أجر اليوم = الراتب ÷ 30)</label>
      <button class="btn primary lg" type="submit" ${s.busy ? 'disabled' : ''}>حفظ</button></form>` });
  },
  'hr-slip'(s) {
    const x = s.modal.slip;
    return modalFrame({ title: `قسيمة ${x.name}`, body: payslipCard(x, { self: false }) });
  },
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

function slipFrom(src) {
  if (state.modal?.type === 'hr-slip') return state.modal.slip;
  const r = src === 'me' ? state.view.me : state.modal?.record;
  return r?.payroll ? { ...r.payroll, name: r.payroll.name ?? r.employee.name } : null;
}

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
  'hr-sort': (el) => { H().sort = el.dataset.k; render(); },
  'hr-profile': (el) => {
    const p = H().data?.team.find((x) => x.id === el.dataset.id) ?? (state.modal?.record?.profile?.id === el.dataset.id ? state.modal.record.profile : null);
    if (p) openModal({ type: 'hr-profile', p: structuredClone(p), back: state.modal?.type === 'hr-record' ? state.modal : null });
  },
  'hr-pf': (el) => { state.modal.p[el.dataset.k] = el.value; },
  'hr-pf-pay': (el) => { state.modal.p.payType = el.dataset.k; render(); },
  'hr-sched-on': (el) => {
    const p = state.modal.p;
    p.schedule = p.schedule ? [...p.schedule] : [null, null, null, null, null, null, null];
    const first = p.schedule.find(Boolean) ?? { start: '09:00', end: '17:00' };
    p.schedule[Number(el.dataset.i)] = el.checked ? { ...first } : null;
    render();
  },
  'hr-sched-t': (el) => { const d = state.modal.p.schedule[Number(el.dataset.i)]; if (d && el.value) d[el.dataset.k] = el.value; },
  'hr-sched-copy': () => {
    const p = state.modal.p;
    const first = WEEK_ORDER.map((i) => p.schedule?.[i]).find(Boolean);
    if (!first) { toast('حدّد وقت أول يوم دوام أولاً'); return; }
    p.schedule = p.schedule.map((d, i) => (i === 5 && !d ? null : { ...first })); // الجمعة تبقى عطلة إن كانت عطلة
    render();
  },
  'hr-profile-save': () => busy(async () => {
    const m = state.modal;
    const p = m.p;
    const num = (v) => (v === '' || v == null ? undefined : parseAmount(String(v)));
    await post(`/api/hr/profile/${p.id}`, { phone: p.phone || null, hiredAt: p.hiredAt || null, nationalId: p.nationalId || null, emergency: p.emergency || null, notes: p.notes || null,
      schedule: p.schedule ?? null, ...(can('admin.employees') ? { payType: p.payType ?? 'monthly', salary: num(p.salary), hourlyRate: num(p.hourlyRate) } : {}) });
    state.modal = m.back;
    toast('حُفظ ملف الموظف', 'ok');
    await refreshAfterChange();
  }),
  'hr-adv-new': () => openModal({ type: 'hr-adv', clientId: uid() }),
  'hr-adv-save': (_el, _e, d) => busy(async () => {
    const amount = parseAmount(d.amount);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('أدخل مبلغاً صحيحاً');
    await post('/api/hr/advances', { clientId: state.modal.clientId, employeeId: d.employeeId, amount, installments: Number(d.installments), note: d.note || null, fromDrawer: d.fromDrawer === 'on' });
    state.modal = null;
    toast('سُجّلت السلفة', 'ok');
    await loadHr();
  }),
  'hr-adv-cancel': (el) => busy(async () => {
    const h = H();
    if (h.confirmAdv !== el.dataset.id) { h.confirmAdv = el.dataset.id; toast('اضغط مرة أخرى لإلغاء السلفة وحذف مصروفها'); return; }
    await del(`/api/hr/advances/${el.dataset.id}`);
    h.confirmAdv = null;
    toast('أُلغيت السلفة', 'ok');
    await loadHr();
  }),
  'hr-policy': () => busy(async () => openModal({ type: 'hr-policy', policy: await get('/api/hr/policy') })),
  'hr-policy-save': (_el, _e, d) => busy(async () => {
    const n = (v, label) => { const x = parseAmount(String(v ?? '0')); if (!Number.isSafeInteger(x) || x < 0) throw new Error(`قيمة غير صحيحة: ${label}`); return x; };
    await post('/api/hr/policy', { graceMin: n(d.graceMin, 'السماح'), lateFine: n(d.lateFine, 'الغرامة'), lateStepMin: Math.max(1, n(d.lateStepMin, 'الدقائق')),
      overtimeHourly: n(d.overtimeHourly, 'الإضافي'), advanceMaxBp: n(d.advanceMaxPct, 'حد السلف') * 100, deductAbsence: d.deductAbsence === 'on' });
    state.modal = null;
    toast('حُفظت الإعدادات', 'ok');
    await loadHr();
  }),
  'hr-late-one': (el) => busy(async () => {
    const r = await post('/api/hr/late-fines', { month: H().month, attendanceIds: [el.dataset.id] });
    toast(r.count ? `سُجّلت غرامة ${money(r.total)}` : 'لا شيء جديد', 'ok');
    await loadHr();
  }),
  'hr-late-all': () => busy(async () => {
    const r = await post('/api/hr/late-fines', { month: H().month });
    toast(`سُجّلت ${r.count} غرامة بمجموع ${money(r.total)}`, 'ok');
    await loadHr();
  }),
  'hr-pay-drawer': (el) => { H().payFromDrawer = el.checked; },
  'hr-pay': (el) => busy(async () => {
    const h = H();
    const key = `pay:${el.dataset.id || 'all'}`;
    if (h.confirmPay !== key) { h.confirmPay = key; toast(`اضغط مرة أخرى لتأكيد الصرف${h.payFromDrawer ? ' من الدرج' : ''}`); return; }
    h.confirmPay = null;
    const r = await post('/api/hr/payroll/pay', { clientId: uid(), month: h.month, ...(el.dataset.id ? { employeeIds: [el.dataset.id] } : {}), fromDrawer: h.payFromDrawer === true });
    toast(`صُرفت رواتب بقيمة ${money(r.total)}`, 'ok');
    await loadHr();
  }),
  'hr-pay-cancel': (el) => busy(async () => {
    const h = H();
    if (h.confirmPay !== `cancel:${el.dataset.id}`) { h.confirmPay = `cancel:${el.dataset.id}`; toast('اضغط مرة أخرى لإلغاء الصرف وحذف مصروف الراتب'); return; }
    h.confirmPay = null;
    await del(`/api/hr/payroll/${el.dataset.id}`);
    toast('أُلغي الصرف', 'ok');
    await loadHr();
  }),
  'hr-slip': (el) => { const x = H().payroll?.rows.find((r) => r.employeeId === el.dataset.id); if (x) openModal({ type: 'hr-slip', slip: x }); },
  'hr-slip-print': (el) => { const x = slipFrom(el.dataset.src); if (x) printHtml(slipHtml(x), 'معاينة قسيمة الراتب'); },
  'hr-slip-share': (el) => { const x = slipFrom(el.dataset.src); if (x) shareText(slipText(x), `قسيمة راتب ${x.month}`); },
  'hr-leave-decide': (el) => busy(async () => {
    await post(`/api/hr/leaves/${el.dataset.id}/decide`, { status: el.dataset.s });
    toast(el.dataset.s === 'approved' ? 'تمت الموافقة على الإجازة' : 'رُفضت الإجازة', 'ok');
    await loadHr();
  }),
});
