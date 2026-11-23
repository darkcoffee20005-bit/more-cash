// الموارد البشرية: الحضور والانصراف، الحوافز والغرامات، الإجازات (طلب وموافقة ورصيد مدفوع)،
// سجل لكل موظف، ترتيب الحوافز حسب ساعات العمل، وموظف الشهر،
// جدول الدوام (تأخير، غياب، ساعات إضافية)، ملف الموظف، السلف بأقساط، وصرف الرواتب بقسيمة ومصروف مرتبط.
// كل عملية كتابة من الجهاز تحمل clientId (لا تتكرر عند إعادة الإرسال)، والمبالغ دنانير صحيحة.
import { localDate } from '../../shared/format.js';
import { AppError, audit, bad, conflict, getSettings, id as checkId, int, isDup, notFound, oneOf, requirePerm, str } from './core.js';
import { can } from '../../shared/perms.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;
const LEAVE_TYPES = { annual: 'إجازة سنوية', sick: 'إجازة مرضية', unpaid: 'إجازة بدون راتب' };
const FORGOT_MIN = 16 * 60; // حضور مفتوح أكثر من 16 ساعة: غالباً نُسي الانصراف
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
/** سياسة الموارد البشرية الافتراضية (يعدّلها المالك) */
export const HR_POLICY = Object.freeze({
  graceMin: 10, // سماح التأخير بالدقائق
  lateStepMin: 15, // غرامة التأخير المقترحة: مبلغ لكل خطوة من الدقائق
  lateFine: 0, // 0 = بلا غرامة مقترحة
  deductAbsence: true, // يوم دوام بلا حضور ولا إجازة يُخصم من الراتب الشهري
  overtimeHourly: 0, // أجر الساعة الإضافية للراتب الشهري (0 = بلا)
  advanceMaxBp: 5000, // حد السلف القائمة من الراتب الشهري (نقاط أساس، 0 = بلا حد)
  dayDivisor: 30, // أجر اليوم = الراتب ÷ 30
});
const mulDiv = (a, b, c) => (c ? Number((BigInt(a) * BigInt(b)) / BigInt(c)) : 0); // floor(a×b÷c) بأعداد صحيحة
const monthOf = (day) => day.slice(0, 7);
const lastDay = (month) => { const [y, m] = month.split('-').map(Number); return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`; };
const addMonths = (month, n) => { const [y, m] = month.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };
const weekday = (day) => new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = الأحد
const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/** تقسيم مبلغ صحيح على أوزان بأكبر باقٍ: الحصص أعداد صحيحة ومجموعها = المبلغ بالضبط */
export function splitByWeight(weights, amount) {
  const total = weights.reduce((a, w) => a + BigInt(w), 0n);
  if (total === 0n) return weights.map(() => 0);
  const A = BigInt(amount);
  const shares = weights.map((w) => (A * BigInt(w)) / total);
  const rem = weights.map((w) => (A * BigInt(w)) % total);
  let left = A - shares.reduce((a, x) => a + x, 0n);
  const order = weights.map((_, i) => i).sort((i, j) => (rem[j] > rem[i] ? 1 : rem[j] < rem[i] ? -1 : i - j));
  for (const i of order) { if (left === 0n) break; shares[i] += 1n; left -= 1n; }
  return shares.map(Number);
}

const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;

export function createHr(ctx) {
  const { db, now, newId } = ctx;
  const ATT = () => db.collection('attendance');
  const ADJ = () => db.collection('hr_adjustments');
  const LV = () => db.collection('leaves');
  const AW = () => db.collection('hr_awards');
  const ADV = () => db.collection('hr_advances');
  const PAY = () => db.collection('payrolls');
  const EMP = () => db.collection('employees');
  const tz = async () => (await getSettings(db)).tzOffsetMin;

  const minutesOf = (a, at = now()) => Math.max(0, Math.floor(((a.outAt ? new Date(a.outAt) : at) - new Date(a.inAt)) / 60000));
  /** شهر صُرف راتبه لموظف: لا تتغير فيه الحوافز والغرامات والحضور والإجازات (القسيمة مقفلة) */
  async function assertOpenMonth(employeeId, ...months) {
    for (const month of new Set(months.filter(Boolean))) {
      if (await PAY().findOne({ employeeId, month })) throw conflict('PAYROLL_LOCKED', month);
    }
  }
  const leaveMonths = (from, to) => { const out = []; for (let m = monthOf(from); m <= monthOf(to); m = addMonths(m, 1)) out.push(m); return out; };

  const viewAtt = (a) => ({ id: a._id, employeeId: a.employeeId, employeeName: a.employeeName, inAt: a.inAt, outAt: a.outAt ?? null, day: a.day,
    minutes: minutesOf(a), open: !a.outAt, forgot: !a.outAt && minutesOf(a) > FORGOT_MIN, fixed: a.fixed ?? null });

  // ---------------------------------------------------------------- الحضور والانصراف (للموظف نفسه)
  async function clock(actor, input = {}) {
    if (!actor) throw new AppError(401, 'NOT_AUTHENTICATED');
    const clientId = checkId(input.clientId, 'clientId');
    const action = oneOf(input.action, ['in', 'out'], 'action');
    const open = await ATT().findOne({ employeeId: actor.id, open: true });
    if (action === 'in') {
      const prior = await ATT().findOne({ clientId });
      if (prior) return { attendance: viewAtt(prior), duplicate: true };
      if (open) throw conflict('ALREADY_CLOCKED_IN');
      const doc = { _id: newId(), clientId, employeeId: actor.id, employeeName: actor.name, inAt: now(), outAt: null, open: true, day: localDate(now(), await tz()) };
      try { await ATT().insertOne(doc); } catch (e) { if (isDup(e)) throw conflict('ALREADY_CLOCKED_IN'); throw e; }
      return { attendance: viewAtt(doc), duplicate: false };
    }
    const done = await ATT().findOne({ outClientId: clientId });
    if (done) return { attendance: viewAtt(done), duplicate: true };
    if (!open) throw conflict('NOT_CLOCKED_IN');
    const r = await ATT().updateOne({ _id: open._id, open: true }, { $set: { outAt: now(), open: false, outClientId: clientId } });
    if (!r.matchedCount) throw conflict('NOT_CLOCKED_IN');
    return { attendance: viewAtt(await ATT().findOne({ _id: open._id })), duplicate: false };
  }

  // ---------------------------------------------------------------- الإجازات
  async function requestLeave(actor, input = {}) {
    if (!actor) throw new AppError(401, 'NOT_AUTHENTICATED');
    const clientId = checkId(input.clientId, 'clientId');
    const prior = await LV().findOne({ clientId });
    if (prior) return viewLeave(prior);
    const from = String(input.from ?? '');
    const to = String(input.to ?? '');
    if (!DATE.test(from) || !DATE.test(to) || from > to) throw bad('INVALID_RANGE');
    const days = daysBetween(from, to);
    if (days > 60) throw bad('INVALID_RANGE');
    const type = oneOf(input.type ?? 'annual', Object.keys(LEAVE_TYPES), 'type');
    const reason = str(input.reason, { field: 'reason', max: 160, optional: true });
    // الموظف يطلب لنفسه؛ مسؤول الموارد البشرية يمكنه تسجيل إجازة لموظف آخر
    let employeeId = actor.id;
    if (input.employeeId && input.employeeId !== actor.id) { requirePerm(actor, 'hr.manage'); employeeId = checkId(input.employeeId, 'employeeId'); }
    const emp = await EMP().findOne({ _id: employeeId });
    if (!emp) throw notFound();
    const overlap = await LV().findOne({ employeeId, status: { $in: ['pending', 'approved'] }, from: { $lte: to }, to: { $gte: from } });
    if (overlap) throw conflict('LEAVE_OVERLAP');
    const doc = { _id: newId(), clientId, employeeId, employeeName: emp.name, from, to, days, type, paid: type !== 'unpaid', reason, status: 'pending', requestedAt: now(), requestedBy: actor.name };
    try { await LV().insertOne(doc); } catch (e) { if (isDup(e)) return viewLeave(await LV().findOne({ clientId })); throw e; }
    return viewLeave(doc);
  }

  async function leaveBalance(emp, year) {
    const used = (await LV().find({ employeeId: emp._id, status: 'approved', type: 'annual' }).toArray())
      .filter((l) => l.from.startsWith(year)).reduce((a, l) => a + l.days, 0);
    const total = emp.annualLeave ?? 14;
    return { total, used, left: total - used };
  }

  async function decideLeave(actor, leaveId, input = {}) {
    requirePerm(actor, 'hr.manage');
    const l = await LV().findOne({ _id: checkId(leaveId) });
    if (!l) throw notFound();
    const status = oneOf(input.status, ['approved', 'rejected'], 'status');
    if (l.status === status) return viewLeave(l);
    if (l.status !== 'pending') throw conflict('LEAVE_ALREADY_DECIDED');
    if (status === 'approved') await assertOpenMonth(l.employeeId, ...leaveMonths(l.from, l.to));
    if (status === 'approved' && l.type === 'annual') {
      const emp = await EMP().findOne({ _id: l.employeeId });
      const bal = await leaveBalance(emp, l.from.slice(0, 4));
      if (l.days > bal.left) throw bad('LEAVE_BALANCE', String(bal.left));
    }
    const r = await LV().updateOne({ _id: l._id, status: 'pending' }, { $set: { status, decidedAt: now(), decidedBy: actor.name, note: str(input.note, { field: 'note', max: 160, optional: true }) } });
    if (!r.matchedCount) throw conflict('LEAVE_ALREADY_DECIDED');
    await audit({ ...ctx, actor }, `hr.leave_${status}`, { name: l.employeeName, from: l.from, to: l.to, days: l.days, type: LEAVE_TYPES[l.type] });
    return viewLeave(await LV().findOne({ _id: l._id }));
  }

  const viewLeave = (l) => ({ id: l._id, employeeId: l.employeeId, employeeName: l.employeeName, from: l.from, to: l.to, days: l.days, type: l.type, typeName: LEAVE_TYPES[l.type], paid: l.paid, reason: l.reason, status: l.status, requestedAt: l.requestedAt, decidedBy: l.decidedBy ?? null, note: l.note ?? null });

  // ---------------------------------------------------------------- الحوافز والغرامات
  async function addAdjustment(actor, input = {}) {
    requirePerm(actor, 'hr.manage');
    const clientId = checkId(input.clientId, 'clientId');
    const prior = await ADJ().findOne({ clientId });
    if (prior) return viewAdj(prior);
    const type = oneOf(input.type, ['bonus', 'fine'], 'type');
    const amount = int(input.amount, { field: 'amount', min: 1, max: 100_000_000 });
    const reason = str(input.reason, { field: 'reason', min: 2, max: 160 });
    const emp = await EMP().findOne({ _id: checkId(input.employeeId, 'employeeId') });
    if (!emp) throw notFound();
    const t = await tz();
    const day = input.day && DATE.test(input.day) ? input.day : localDate(now(), t);
    if (day > localDate(now(), t)) throw bad('INVALID_DATE');
    await assertOpenMonth(emp._id, monthOf(day));
    const doc = { _id: newId(), clientId, employeeId: emp._id, employeeName: emp.name, type, amount, reason, day, source: input.source ?? 'manual', refId: input.refId ?? null, by: actor.id, byName: actor.name, createdAt: now() };
    try { await ADJ().insertOne(doc); } catch (e) { if (isDup(e)) return viewAdj(await ADJ().findOne({ clientId })); throw e; }
    await audit({ ...ctx, actor }, `hr.${type}`, { name: emp.name, amount, reason });
    return viewAdj(doc);
  }

  async function removeAdjustment(actor, id) {
    requirePerm(actor, 'hr.manage');
    const a = await ADJ().findOne({ _id: checkId(id) });
    if (!a) throw notFound();
    await assertOpenMonth(a.employeeId, monthOf(a.day));
    await ADJ().deleteOne({ _id: a._id });
    await audit({ ...ctx, actor }, 'hr.adjustment_delete', { name: a.employeeName, type: a.type, amount: a.amount, reason: a.reason });
    return { ok: true };
  }

  const viewAdj = (a) => ({ id: a._id, employeeId: a.employeeId, employeeName: a.employeeName, type: a.type, amount: a.amount, reason: a.reason, day: a.day, source: a.source, byName: a.byName });

  // ---------------------------------------------------------------- تصحيح الحضور (نسي الانصراف، وقت خاطئ)
  async function fixAttendance(actor, attId, input = {}) {
    requirePerm(actor, 'hr.manage');
    const a = await ATT().findOne({ _id: checkId(attId) });
    if (!a) throw notFound();
    const inAt = input.inAt ? new Date(input.inAt) : new Date(a.inAt);
    const outAt = input.outAt ? new Date(input.outAt) : null;
    if (Number.isNaN(inAt.getTime()) || (outAt && Number.isNaN(outAt.getTime()))) throw bad('INVALID_DATE');
    if (outAt && (outAt <= inAt || outAt - inAt > 24 * 3600_000)) throw bad('INVALID_RANGE');
    if (inAt > now() || (outAt && outAt > now())) throw bad('INVALID_DATE');
    const note = str(input.note, { field: 'note', min: 2, max: 160 });
    await assertOpenMonth(a.employeeId, a.day && monthOf(a.day), monthOf(localDate(inAt, await tz())));
    const set = { inAt, outAt, open: !outAt, day: localDate(inAt, await tz()), fixed: { byName: actor.name, at: now(), note, before: { inAt: a.inAt, outAt: a.outAt ?? null } } };
    try { await ATT().updateOne({ _id: a._id }, { $set: set }); } catch (e) { if (isDup(e)) throw conflict('ALREADY_CLOCKED_IN'); throw e; }
    await audit({ ...ctx, actor }, 'hr.attendance_fix', { name: a.employeeName, note });
    return viewAtt(await ATT().findOne({ _id: a._id }));
  }

  // ---------------------------------------------------------------- السياسة، جدول الدوام، ملف الموظف
  async function policy() {
    const st = await getSettings(db);
    return { ...HR_POLICY, ...(st.hrPolicy ?? {}) };
  }
  async function getPolicy(actor) { requirePerm(actor, 'hr.manage'); return policy(); }
  async function savePolicy(actor, input = {}) {
    requirePerm(actor, 'admin.employees');
    const cur = await policy();
    const n = (k, min, max) => (input[k] === undefined || input[k] === '' || input[k] === null ? cur[k] : int(input[k], { field: k, min, max }));
    const p = {
      graceMin: n('graceMin', 0, 240), lateStepMin: n('lateStepMin', 1, 240), lateFine: n('lateFine', 0, 10_000_000),
      deductAbsence: input.deductAbsence === undefined ? cur.deductAbsence : input.deductAbsence === true,
      overtimeHourly: n('overtimeHourly', 0, 10_000_000), advanceMaxBp: n('advanceMaxBp', 0, 30000), dayDivisor: cur.dayDivisor,
    };
    await db.collection('settings').updateOne({ _id: 'store' }, { $set: { hrPolicy: p } });
    await audit({ ...ctx, actor }, 'hr.policy', p);
    return p;
  }

  function parseSchedule(list) {
    if (list == null) return null;
    if (!Array.isArray(list) || list.length !== 7) throw bad('INVALID_LIST', 'schedule');
    const out = list.map((d) => {
      if (!d) return null;
      if (!HHMM.test(d.start ?? '') || !HHMM.test(d.end ?? '') || d.start === d.end) throw bad('INVALID_TIME', 'schedule');
      return { start: d.start, end: d.end };
    });
    return out.some(Boolean) ? out : null;
  }
  const planMinutes = (d) => (toMin(d.end) - toMin(d.start) + 1440) % 1440; // دوام يعبر منتصف الليل مقبول

  const profileView = (e, showPay) => ({
    id: e._id, name: e.name, role: e.role, active: e.active, phone: e.phone ?? null, nationalId: e.nationalId ?? null, emergency: e.emergency ?? null,
    notes: e.notes ?? null, hiredAt: e.hiredAt ?? null, schedule: e.schedule ?? null, annualLeave: e.annualLeave ?? 14,
    ...(showPay ? { payType: e.payType ?? 'monthly', salary: e.salary ?? 0, hourlyRate: e.hourlyRate ?? 0 } : {}),
  });

  async function saveProfile(actor, employeeId, input = {}) {
    requirePerm(actor, 'hr.manage');
    const emp = await EMP().findOne({ _id: checkId(employeeId) });
    if (!emp) throw notFound();
    const hiredAt = input.hiredAt ? String(input.hiredAt) : null;
    if (hiredAt && !DATE.test(hiredAt)) throw bad('INVALID_DATE', 'hiredAt');
    const set = {
      phone: str(input.phone, { field: 'phone', max: 20, optional: true }), nationalId: str(input.nationalId, { field: 'nationalId', max: 30, optional: true }),
      emergency: str(input.emergency, { field: 'emergency', max: 60, optional: true }), notes: str(input.notes, { field: 'notes', max: 300, optional: true }),
      hiredAt, schedule: parseSchedule(input.schedule),
    };
    const owner = can(actor.role, 'admin.employees'); // الأجر للمالك فقط
    if (owner) {
      if (input.payType !== undefined) set.payType = oneOf(input.payType, ['monthly', 'hourly'], 'payType');
      if (input.salary !== undefined && input.salary !== null && input.salary !== '') set.salary = int(input.salary, { field: 'salary', min: 0, max: 1_000_000_000 });
      if (input.hourlyRate !== undefined && input.hourlyRate !== null && input.hourlyRate !== '') set.hourlyRate = int(input.hourlyRate, { field: 'hourlyRate', min: 0, max: 10_000_000 });
    }
    await EMP().updateOne({ _id: emp._id }, { $set: set });
    await audit({ ...ctx, actor }, 'hr.profile', { name: emp.name });
    return profileView(await EMP().findOne({ _id: emp._id }), owner);
  }

  // ---------------------------------------------------------------- تحليل أيام الشهر: تأخير، غياب، ساعات إضافية
  function analyze(emp, month, att, leaves, pol, today, t) {
    const sched = emp.schedule ?? null;
    const startDay = emp.hiredAt ?? (emp.createdAt ? localDate(emp.createdAt, t) : `${month}-01`);
    const out = { minutes: 0, lateMin: 0, lateCount: 0, absentDays: 0, overtimeMin: 0, unpaidLeaveDays: 0, paidLeaveDays: 0, preHireDays: 0, late: [], absent: [] };
    for (let d = `${month}-01`; d <= lastDay(month); d = new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)) {
      if (emp.hiredAt && d < emp.hiredAt) { out.preHireDays += 1; continue; } // قبل التعيين: لا راتب ولا غياب
      const plan = sched?.[weekday(d)] ?? null;
      const mine = att.filter((a) => a.day === d).sort((x, y) => new Date(x.inAt) - new Date(y.inAt));
      const leave = leaves.find((l) => l.from <= d && l.to >= d);
      const closed = mine.length > 0 && mine.every((a) => a.outAt);
      const worked = mine.reduce((sum, a) => sum + (!a.outAt && minutesOf(a) > FORGOT_MIN ? 0 : minutesOf(a)), 0);
      out.minutes += worked;
      if (leave) { if (leave.paid) out.paidLeaveDays += 1; else out.unpaidLeaveDays += 1; }
      if (plan && mine.length) {
        const late = Math.floor((new Date(mine[0].inAt).getTime() - (Date.parse(`${d}T${plan.start}:00Z`) - t * 60000)) / 60000);
        if (late > pol.graceMin) {
          out.lateMin += late; out.lateCount += 1;
          out.late.push({ attendanceId: mine[0]._id, employeeId: emp._id, employeeName: emp.name, day: d, start: plan.start, inAt: mine[0].inAt, lateMin: late,
            fine: pol.lateFine ? Math.ceil(late / pol.lateStepMin) * pol.lateFine : 0 });
        }
      }
      if (sched && closed) out.overtimeMin += Math.max(0, worked - (plan ? planMinutes(plan) : 0));
      if (plan && !mine.length && !leave && d < today && d >= startDay) { out.absentDays += 1; out.absent.push(d); }
    }
    return out;
  }

  /** الراتب المستحق للشهر: شهري (ناقص الإجازة بلا راتب والغياب) أو بالساعة، + الإضافي والحوافز − الغرامات − قسط السلف */
  function computePay(emp, month, info, adjs, pol, advances, pays) {
    const payType = emp.payType ?? 'monthly';
    const salary = emp.salary ?? 0;
    const hourlyRate = emp.hourlyRate ?? 0;
    const bonus = adjs.filter((a) => a.type === 'bonus').reduce((x, a) => x + a.amount, 0);
    const fine = adjs.filter((a) => a.type === 'fine').reduce((x, a) => x + a.amount, 0);
    let base; let leaveDeduction = 0; let absenceDeduction = 0; let overtimePay = 0;
    if (payType === 'monthly') {
      // عُيّن خلال الشهر: الراتب بنسبة الأيام من تاريخ التعيين (أجر اليوم = الراتب ÷ 30)
      base = Math.max(0, salary - mulDiv(salary, info.preHireDays, pol.dayDivisor));
      leaveDeduction = Math.min(base, mulDiv(salary, info.unpaidLeaveDays, pol.dayDivisor));
      absenceDeduction = pol.deductAbsence ? Math.min(base - leaveDeduction, mulDiv(salary, info.absentDays, pol.dayDivisor)) : 0;
      overtimePay = mulDiv(pol.overtimeHourly, info.overtimeMin, 60);
    } else {
      base = mulDiv(hourlyRate, info.minutes, 60);
    }
    const gross = base + overtimePay + bonus - fine - leaveDeduction - absenceDeduction;
    let room = Math.max(0, gross);
    const advanceParts = [];
    for (const a of [...advances].sort((x, y) => new Date(x.createdAt) - new Date(y.createdAt))) {
      if (a.startMonth > month) continue;
      const done = pays.filter((p) => p.month !== month).flatMap((p) => p.advanceParts ?? []).filter((x) => x.advanceId === a._id).reduce((x, y) => x + y.amount, 0);
      const take = Math.min(a.perMonth, a.amount - done, room);
      if (take > 0) { advanceParts.push({ advanceId: a._id, amount: take }); room -= take; }
    }
    const advance = advanceParts.reduce((x, y) => x + y.amount, 0);
    return {
      payType, salary, hourlyRate, minutes: info.minutes, base, preHireDays: info.preHireDays, overtimeMin: info.overtimeMin, overtimePay, bonus, fine,
      unpaidLeaveDays: info.unpaidLeaveDays, leaveDeduction, absentDays: info.absentDays, absenceDeduction, gross, advance, advanceParts,
      net: Math.max(0, gross) - advance, shortfall: gross < 0 ? -gross : 0,
    };
  }

  /** أداء الموظف من المبيعات: عدد الطلبات وصافيها، والاسترجاع والإلغاء الذي نفّذه */
  async function performance(month, t, employeeId = null) {
    const from = new Date(Date.parse(`${month}-01T00:00:00Z`) - t * 60000);
    const to = new Date(Date.parse(`${lastDay(month)}T00:00:00Z`) + 86400000 - t * 60000);
    const map = new Map();
    for (const r of await db.collection('receipts').find({ createdAt: { $gte: from, $lt: to }, ...(employeeId ? { employeeId } : {}) }).toArray()) {
      const p = map.get(r.employeeId) ?? { sales: 0, salesTotal: 0, refunds: 0, cancels: 0 };
      if (r.type === 'sale') { p.sales += 1; p.salesTotal += r.totals?.net ?? 0; } else if (r.cancel) p.cancels += 1; else p.refunds += 1;
      map.set(r.employeeId, p);
    }
    return map;
  }

  // ---------------------------------------------------------------- الملخص الشهري والترتيب
  /** opts.perfFor: حساب أداء المبيعات لموظف واحد فقط (سجل الموظف) بدل قراءة إيصالات الشهر كلها */
  async function monthData(month, opts = {}) {
    if (!MONTH.test(String(month ?? ''))) throw new AppError(400, 'INVALID_RANGE');
    const t = await tz();
    const today = localDate(now(), t);
    const pol = await policy();
    const emps = await EMP().find({}).toArray();
    // استعلامات بمدى الشهر (فهرس by_day) لا قراءة كل السجل
    const att = await ATT().find({ day: { $gte: `${month}-01`, $lte: lastDay(month) } }).toArray();
    const adj = await ADJ().find({ day: { $gte: `${month}-01`, $lte: lastDay(month) } }).toArray();
    const lv = await LV().find({ status: 'approved', from: { $lte: lastDay(month) }, to: { $gte: `${month}-01` } }).toArray();
    const award = await AW().findOne({ month });
    const perf = await performance(month, t, opts.perfFor ?? null);
    const detail = new Map();
    const late = [];
    const rows = emps.filter((e) => e.active || att.some((a) => a.employeeId === e._id)).map((e) => {
      const mine = att.filter((a) => a.employeeId === e._id);
      const myAdj = adj.filter((a) => a.employeeId === e._id);
      const info = analyze(e, month, mine, lv.filter((l) => l.employeeId === e._id), pol, today, t);
      detail.set(e._id, { emp: e, info, adj: myAdj });
      late.push(...info.late.map((x) => ({ ...x, fined: myAdj.some((a) => a.source === 'late' && a.refId === x.attendanceId) })));
      return {
        id: e._id, name: e.name, role: e.role, active: e.active, minutes: info.minutes, days: new Set(mine.map((a) => a.day)).size,
        openNow: mine.some((a) => !a.outAt), forgot: mine.some((a) => !a.outAt && minutesOf(a) > FORGOT_MIN),
        bonus: myAdj.filter((a) => a.type === 'bonus').reduce((x, a) => x + a.amount, 0), fine: myAdj.filter((a) => a.type === 'fine').reduce((x, a) => x + a.amount, 0),
        paidLeaveDays: info.paidLeaveDays, unpaidLeaveDays: info.unpaidLeaveDays, lateMin: info.lateMin, lateCount: info.lateCount, absentDays: info.absentDays,
        overtimeMin: info.overtimeMin, hasSchedule: Boolean(e.schedule), perf: perf.get(e._id) ?? { sales: 0, salesTotal: 0, refunds: 0, cancels: 0 },
        salary: e.salary ?? 0, employeeOfMonth: award?.employeeId === e._id,
      };
    });
    rows.sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name, 'ar'));
    rows.forEach((r, i) => { r.rank = r.minutes ? i + 1 : null; });
    late.sort((a, b) => b.day.localeCompare(a.day));
    return { month, rows, late, policy: pol, detail, award: award ? { employeeId: award.employeeId, name: award.name, note: award.note, bonus: award.bonus ?? 0 } : null };
  }


  async function overview(actor, { month } = {}) {
    requirePerm(actor, 'hr.manage');
    const { detail, ...m } = await monthData(month);
    const showPay = can(actor.role, 'admin.employees'); // الرواتب للمالك فقط
    if (showPay) {
      // الصافي التقديري = نفس حساب كشف الرواتب (بالساعة، الغياب، الإجازة بلا راتب، قسط السلفة)
      const pays = await PAY().find({}).toArray();
      const advs = await ADV().find({}).toArray();
      for (const r of m.rows) {
        const paid = pays.find((p) => p.month === m.month && p.employeeId === r.id);
        const d = detail.get(r.id);
        r.net = paid ? paid.net : computePay(d.emp, m.month, d.info, d.adj, m.policy, advs.filter((a) => a.employeeId === r.id), pays.filter((p) => p.employeeId === r.id)).net;
      }
    } else for (const r of m.rows) delete r.salary;
    const t = await tz();
    const today = localDate(now(), t);
    const present = (await ATT().find({ open: true }).toArray()).map(viewAtt);
    const pending = (await LV().find({ status: 'pending' }).toArray()).map(viewLeave).sort((a, b) => a.from.localeCompare(b.from));
    const onLeaveToday = (await LV().find({ status: 'approved', from: { $lte: today }, to: { $gte: today } }).toArray()).map(viewLeave);
    const team = (await EMP().find({ active: true }).toArray()).map((e) => profileView(e, showPay)).sort((a, b) => a.name.localeCompare(b.name, 'ar'));
    return { ...m, present, pending, onLeaveToday, showPay, team };
  }

  /** سجل الموظف: لنفسه، أو لمسؤول الموارد البشرية لأي موظف */
  async function record(actor, employeeId, { month } = {}) {
    if (!actor) throw new AppError(401, 'NOT_AUTHENTICATED');
    const id = employeeId === 'me' ? actor.id : checkId(employeeId);
    if (id !== actor.id) requirePerm(actor, 'hr.manage');
    const emp = await EMP().findOne({ _id: id });
    if (!emp) throw notFound();
    const t = await tz();
    const m = month && MONTH.test(month) ? month : localDate(now(), t).slice(0, 7);
    const att = (await ATT().find({ employeeId: id, day: { $gte: `${m}-01`, $lte: lastDay(m) } }).toArray()).sort((a, b) => new Date(b.inAt) - new Date(a.inAt)).map(viewAtt);
    const adj = (await ADJ().find({ employeeId: id, day: { $gte: `${m}-01`, $lte: lastDay(m) } }).toArray()).sort((a, b) => b.day.localeCompare(a.day)).map(viewAdj);
    const leaves = (await LV().find({ employeeId: id }).toArray()).sort((a, b) => b.from.localeCompare(a.from)).slice(0, 30).map(viewLeave);
    const awards = (await AW().find({ employeeId: id }).toArray()).sort((a, b) => b.month.localeCompare(a.month)).map((a) => a.month);
    const open = await ATT().findOne({ employeeId: id, open: true });
    const md = await monthData(m, { perfFor: id });
    const summary = md.rows.find((r) => r.id === id) ?? { minutes: 0, days: 0, bonus: 0, fine: 0, paidLeaveDays: 0, rank: null, lateMin: 0, lateCount: 0, absentDays: 0, overtimeMin: 0 };
    const showPay = id === actor.id || can(actor.role, 'admin.employees');
    if (!showPay) delete summary.salary; else summary.net = (summary.salary ?? 0) + summary.bonus - summary.fine;
    const d = md.detail.get(id);
    let payroll = null;
    let advances = [];
    if (showPay) {
      const pays = await PAY().find({ employeeId: id }).toArray();
      const advs = await ADV().find({ employeeId: id }).toArray();
      const paid = pays.find((p) => p.month === m);
      payroll = paid ? viewPay(paid) : d ? { ...computePay(emp, m, d.info, d.adj, md.policy, advs, pays), paid: false, month: m, employeeId: id, name: emp.name } : null;
      advances = advs.map((a) => viewAdv(a, pays)).sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)));
      if (payroll) summary.net = payroll.net;
    }
    const self = id === actor.id;
    return {
      employee: { id: emp._id, name: emp.name, role: emp.role, phone: emp.phone ?? null, active: emp.active, annualLeave: emp.annualLeave ?? 14 },
      profile: profileView(emp, can(actor.role, 'admin.employees')),
      month: m, summary, attendance: att, adjustments: adj, leaves, awards, clockedIn: open ? viewAtt(open) : null,
      late: d?.info.late ?? [], absent: d?.info.absent ?? [], payroll, advances,
      leaveBalance: await leaveBalance(emp, m.slice(0, 4)),
      ...(self && can(actor.role, 'hr.manage') ? { pendingLeaves: await LV().countDocuments({ status: 'pending' }) } : {}),
    };
  }

  /** تسجيل غرامات التأخير المقترحة (مرة واحدة لكل حضور متأخر، ويمكن حذفها بعد ذلك كأي غرامة) */
  async function lateFines(actor, input = {}) {
    requirePerm(actor, 'hr.manage');
    const md = await monthData(input.month);
    const ids = Array.isArray(input.attendanceIds) ? new Set(input.attendanceIds.map((x) => checkId(x, 'attendanceIds'))) : null;
    const out = [];
    for (const l of md.late) {
      if (ids && !ids.has(l.attendanceId)) continue;
      if (!l.fine || l.fined) continue;
      if (await PAY().findOne({ employeeId: l.employeeId, month: md.month })) continue;
      out.push(await addAdjustment(actor, { clientId: `late-${l.attendanceId}`.slice(0, 64), employeeId: l.employeeId, type: 'fine', amount: l.fine, reason: `تأخير ${l.lateMin} دقيقة (${l.day})`, day: l.day, source: 'late', refId: l.attendanceId }));
    }
    return { month: md.month, count: out.length, total: out.reduce((a, x) => a + x.amount, 0) };
  }

  // ---------------------------------------------------------------- السلف (بأقساط تُخصم من الراتب)
  const viewAdv = (a, pays) => {
    const repaid = pays.flatMap((p) => p.advanceParts ?? []).filter((x) => x.advanceId === a._id).reduce((x, y) => x + y.amount, 0);
    return { id: a._id, employeeId: a.employeeId, employeeName: a.employeeName, amount: a.amount, installments: a.installments, perMonth: a.perMonth,
      startMonth: a.startMonth, note: a.note, fromDrawer: a.fromDrawer, createdAt: a.createdAt, byName: a.byName, repaid, remaining: a.amount - repaid };
  };

  async function giveAdvance(actor, input = {}) {
    requirePerm(actor, 'hr.manage');
    const clientId = checkId(input.clientId, 'clientId');
    const prior = await ADV().findOne({ clientId });
    if (prior) return viewAdv(prior, await PAY().find({ employeeId: prior.employeeId }).toArray());
    const emp = await EMP().findOne({ _id: checkId(input.employeeId, 'employeeId') });
    if (!emp || !emp.active) throw notFound();
    const amount = int(input.amount, { field: 'amount', min: 1, max: 100_000_000 });
    const installments = int(input.installments ?? 1, { field: 'installments', min: 1, max: 12 });
    const note = str(input.note, { field: 'note', max: 120, optional: true });
    const pol = await policy();
    const pays = await PAY().find({ employeeId: emp._id }).toArray();
    const outstanding = (await ADV().find({ employeeId: emp._id }).toArray()).map((a) => viewAdv(a, pays)).reduce((x, a) => x + a.remaining, 0);
    if ((emp.payType ?? 'monthly') === 'monthly' && emp.salary && pol.advanceMaxBp) {
      const max = mulDiv(emp.salary, pol.advanceMaxBp, 10000);
      if (outstanding + amount > max) throw bad('ADVANCE_LIMIT', String(Math.max(0, max - outstanding)));
    }
    const thisMonth = localDate(now(), await tz()).slice(0, 7);
    const startMonth = pays.some((p) => p.month === thisMonth) ? addMonths(thisMonth, 1) : thisMonth;
    // السلفة نقد خرج من المقهى: تُسجَّل مصروفاً (سلف موظفين) فتبقى المصروفات = ما دُفع فعلاً، وقسطها يُنقص صافي الراتب لاحقاً
    const expense = await ctx.expenses.create(actor, { clientId: `adv-${clientId}`.slice(0, 64), amount, category: 'advances', note: `سلفة ${emp.name}${note ? ` — ${note}` : ''}`.slice(0, 120), fromDrawer: input.fromDrawer === true }, { ref: 'advance' });
    const doc = { _id: newId(), clientId, employeeId: emp._id, employeeName: emp.name, amount, installments, perMonth: Math.ceil(amount / installments), startMonth, note,
      fromDrawer: input.fromDrawer === true, expenseId: expense.id, by: actor.id, byName: actor.name, createdAt: now() };
    try { await ADV().insertOne(doc); } catch (e) { if (isDup(e)) return viewAdv(await ADV().findOne({ clientId }), pays); throw e; }
    await audit({ ...ctx, actor }, 'hr.advance', { name: emp.name, amount, installments });
    return viewAdv(doc, pays);
  }

  async function cancelAdvance(actor, advId) {
    requirePerm(actor, 'hr.manage');
    const a = await ADV().findOne({ _id: checkId(advId) });
    if (!a) throw notFound();
    if (await PAY().findOne({ 'advanceParts.advanceId': a._id })) throw conflict('ADVANCE_IN_USE');
    if (a.expenseId && (await db.collection('expenses').findOne({ _id: a.expenseId }))) await ctx.expenses.remove(actor, a.expenseId, { internal: true });
    await ADV().deleteOne({ _id: a._id });
    await audit({ ...ctx, actor }, 'hr.advance_cancel', { name: a.employeeName, amount: a.amount });
    return { ok: true };
  }

  // ---------------------------------------------------------------- الرواتب: كشف الشهر، الصرف (قسيمة مقفلة + مصروف رواتب)، وإلغاء الصرف
  const viewPay = (p) => ({ ...p, id: p._id, _id: undefined, paid: true });

  async function payroll(actor, { month } = {}) {
    requirePerm(actor, 'admin.employees');
    const md = await monthData(month);
    const pays = await PAY().find({}).toArray();
    const advs = await ADV().find({}).toArray();
    const rows = [];
    for (const r of md.rows) {
      const paid = pays.find((p) => p.month === md.month && p.employeeId === r.id);
      if (paid) { rows.push(viewPay(paid)); continue; }
      const d = md.detail.get(r.id);
      if (!r.active) continue;
      // بلا أجر محدد ولا حوافز أو غرامات أو سلف (المالك عادةً): لا سطر فارغ في كشف الرواتب
      if (!d.emp.salary && !d.emp.hourlyRate && !d.adj.length && !advs.some((a) => a.employeeId === r.id)) continue;
      rows.push({ ...computePay(d.emp, md.month, d.info, d.adj, md.policy, advs.filter((a) => a.employeeId === r.id), pays.filter((p) => p.employeeId === r.id)), paid: false, month: md.month, employeeId: r.id, name: r.name, role: r.role });
    }
    const sum = (k) => rows.reduce((x, r) => x + (r[k] ?? 0), 0);
    return { month: md.month, policy: md.policy, rows, totals: { net: sum('net'), gross: sum('gross'), advance: sum('advance'), paid: rows.filter((r) => r.paid).reduce((x, r) => x + r.net, 0), unpaid: rows.filter((r) => !r.paid).reduce((x, r) => x + r.net, 0) },
      advances: advs.map((a) => viewAdv(a, pays.filter((p) => p.employeeId === a.employeeId))).filter((a) => a.remaining > 0 || a.startMonth >= md.month).sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt))) };
  }

  async function payPayroll(actor, input = {}) {
    requirePerm(actor, 'admin.employees');
    checkId(input.clientId, 'clientId');
    const today = localDate(now(), await tz());
    const md = await monthData(input.month);
    if (md.month > today.slice(0, 7)) throw bad('INVALID_RANGE');
    const want = Array.isArray(input.employeeIds) ? new Set(input.employeeIds.map((x) => checkId(x, 'employeeIds'))) : null;
    const fromDrawer = input.fromDrawer === true;
    const out = [];
    for (const r of md.rows) {
      if (!r.active || (want && !want.has(r.id))) continue;
      const existing = await PAY().findOne({ month: md.month, employeeId: r.id });
      if (existing) { out.push(viewPay(existing)); continue; }
      const d = md.detail.get(r.id);
      const pays = await PAY().find({ employeeId: r.id }).toArray();
      const pay = computePay(d.emp, md.month, d.info, d.adj, md.policy, await ADV().find({ employeeId: r.id }).toArray(), pays);
      if (!pay.net && !pay.gross && !want) continue; // موظف بلا أجر ولا حركة: لا قسيمة فارغة عند الصرف الجماعي
      // المفتاح مشتق من الشهر والموظف: إعادة المحاولة لا تصرف مرتين
      const key = `pay-${md.month}-${r.id}`.slice(0, 64);
      const expense = pay.net > 0 ? await ctx.expenses.create(actor, { clientId: key, amount: pay.net, category: 'salaries', note: `راتب ${r.name} ${md.month}`, fromDrawer }, { ref: 'payroll' }) : null;
      const doc = { _id: newId(), month: md.month, employeeId: r.id, name: r.name, role: r.role, ...pay, expenseId: expense?.id ?? null, fromDrawer: Boolean(expense) && fromDrawer,
        paidAt: now(), paidBy: actor.id, paidByName: actor.name };
      try { await PAY().insertOne(doc); } catch (e) { if (isDup(e)) { out.push(viewPay(await PAY().findOne({ month: md.month, employeeId: r.id }))); continue; } throw e; }
      await audit({ ...ctx, actor }, 'hr.payroll_pay', { name: r.name, month: md.month, net: pay.net, fromDrawer: doc.fromDrawer });
      out.push(viewPay(doc));
    }
    return { month: md.month, rows: out, total: out.reduce((x, r) => x + r.net, 0) };
  }

  async function cancelPayroll(actor, payId) {
    requirePerm(actor, 'admin.employees');
    const p = await PAY().findOne({ _id: checkId(payId) });
    if (!p) throw notFound();
    if (p.expenseId && (await db.collection('expenses').findOne({ _id: p.expenseId }))) await ctx.expenses.remove(actor, p.expenseId, { internal: true });
    await PAY().deleteOne({ _id: p._id });
    await audit({ ...ctx, actor }, 'hr.payroll_cancel', { name: p.name, month: p.month, net: p.net });
    return { ok: true };
  }

  /** توزيع مبلغ حوافز الشهر على الموظفين حسب ساعات عملهم (مجموع الحصص = المبلغ بالضبط) */
  async function distributeIncentives(actor, input = {}) {
    requirePerm(actor, 'hr.manage');
    const clientId = checkId(input.clientId, 'clientId');
    const pool = int(input.pool, { field: 'pool', min: 1, max: 1_000_000_000 });
    const { month, rows } = await monthData(input.month);
    const eligible = rows.filter((r) => r.active && r.minutes > 0);
    if (!eligible.length) throw bad('NO_HOURS');
    const shares = splitByWeight(eligible.map((r) => r.minutes), pool);
    const today = localDate(now(), await tz());
    if (month > today.slice(0, 7)) throw bad('INVALID_RANGE');
    const day = today.startsWith(month) ? today : `${month}-28`;
    const out = [];
    for (const [i, r] of eligible.entries()) {
      if (!shares[i]) continue;
      out.push(await addAdjustment(actor, { clientId: `i${clientId.slice(0, 28)}-${r.id.slice(0, 30)}`, employeeId: r.id, type: 'bonus', amount: shares[i], reason: `حافز الشهر حسب الساعات (${Math.round(r.minutes / 60)} ساعة)`, day, source: 'hours' }));
    }
    return { month, pool, total: out.reduce((a, x) => a + x.amount, 0), rows: out };
  }

  async function setAward(actor, input = {}) {
    requirePerm(actor, 'hr.manage');
    const { month } = await monthData(input.month);
    const emp = await EMP().findOne({ _id: checkId(input.employeeId, 'employeeId') });
    if (!emp) throw notFound();
    const note = str(input.note, { field: 'note', max: 160, optional: true });
    const bonus = input.bonus ? int(input.bonus, { field: 'bonus', min: 0, max: 100_000_000 }) : 0;
    const prev = await AW().findOne({ month });
    if (bonus || prev?.bonus) await assertOpenMonth(emp._id, month);
    if (prev?.bonus && prev.employeeId !== emp._id) await assertOpenMonth(prev.employeeId, month);
    if (prev) await AW().updateOne({ _id: prev._id }, { $set: { employeeId: emp._id, name: emp.name, note, bonus, by: actor.name, at: now() } });
    else {
      try { await AW().insertOne({ _id: newId(), month, employeeId: emp._id, name: emp.name, note, bonus, by: actor.name, at: now() }); } catch (e) { if (!isDup(e)) throw e; }
    }
    if (bonus) {
      // مكافأة موظف الشهر: واحدة لكل شهر؛ تغيير الموظف يلغي مكافأة السابق
      await ADJ().deleteMany({ source: 'award', day: { $gte: `${month}-01`, $lte: `${month}-31` }, employeeId: { $ne: emp._id } });
      await addAdjustment(actor, { clientId: `award-${month}-${emp._id}`.slice(0, 64), employeeId: emp._id, type: 'bonus', amount: bonus, reason: `موظف الشهر ${month}`, day: localDate(now(), await tz()).startsWith(month) ? undefined : `${month}-28`, source: 'award' });
    }
    await audit({ ...ctx, actor }, 'hr.award', { month, name: emp.name, bonus });
    return { month, employeeId: emp._id, name: emp.name, note, bonus };
  }

  return { clock, requestLeave, decideLeave, addAdjustment, removeAdjustment, fixAttendance, overview, record, distributeIncentives, setAward,
    getPolicy, savePolicy, saveProfile, lateFines, giveAdvance, cancelAdvance, payroll, payPayroll, cancelPayroll };
}
