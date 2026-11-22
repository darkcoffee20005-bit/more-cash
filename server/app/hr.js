// الموارد البشرية: الحضور والانصراف، الحوافز والغرامات، الإجازات (طلب وموافقة ورصيد مدفوع)،
// سجل لكل موظف، ترتيب الحوافز حسب ساعات العمل، وموظف الشهر.
// كل عملية كتابة من الجهاز تحمل clientId (لا تتكرر عند إعادة الإرسال)، والمبالغ دنانير صحيحة.
import { localDate } from '../../shared/format.js';
import { AppError, audit, bad, conflict, getSettings, id as checkId, int, isDup, notFound, oneOf, requirePerm, str } from './core.js';
import { can } from '../../shared/perms.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;
const LEAVE_TYPES = { annual: 'إجازة سنوية', sick: 'إجازة مرضية', unpaid: 'إجازة بدون راتب' };
const FORGOT_MIN = 16 * 60; // حضور مفتوح أكثر من 16 ساعة: غالباً نُسي الانصراف

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
  const EMP = () => db.collection('employees');
  const tz = async () => (await getSettings(db)).tzOffsetMin;

  const minutesOf = (a, at = now()) => Math.max(0, Math.floor(((a.outAt ? new Date(a.outAt) : at) - new Date(a.inAt)) / 60000));
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
    const doc = { _id: newId(), clientId, employeeId: emp._id, employeeName: emp.name, type, amount, reason, day, source: input.source ?? 'manual', by: actor.id, byName: actor.name, createdAt: now() };
    try { await ADJ().insertOne(doc); } catch (e) { if (isDup(e)) return viewAdj(await ADJ().findOne({ clientId })); throw e; }
    await audit({ ...ctx, actor }, `hr.${type}`, { name: emp.name, amount, reason });
    return viewAdj(doc);
  }

  async function removeAdjustment(actor, id) {
    requirePerm(actor, 'hr.manage');
    const a = await ADJ().findOne({ _id: checkId(id) });
    if (!a) throw notFound();
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
    const set = { inAt, outAt, open: !outAt, day: localDate(inAt, await tz()), fixed: { byName: actor.name, at: now(), note, before: { inAt: a.inAt, outAt: a.outAt ?? null } } };
    try { await ATT().updateOne({ _id: a._id }, { $set: set }); } catch (e) { if (isDup(e)) throw conflict('ALREADY_CLOCKED_IN'); throw e; }
    await audit({ ...ctx, actor }, 'hr.attendance_fix', { name: a.employeeName, note });
    return viewAtt(await ATT().findOne({ _id: a._id }));
  }

  // ---------------------------------------------------------------- الملخص الشهري والترتيب
  async function monthData(month) {
    if (!MONTH.test(String(month ?? ''))) throw new AppError(400, 'INVALID_RANGE');
    const emps = await EMP().find({}).toArray();
    const att = (await ATT().find({}).toArray()).filter((a) => a.day?.startsWith(month));
    const adj = (await ADJ().find({}).toArray()).filter((a) => a.day.startsWith(month));
    const lv = (await LV().find({}).toArray()).filter((l) => l.status === 'approved' && l.from <= `${month}-31` && l.to >= `${month}-01`);
    const award = await AW().findOne({ month });
    const rows = emps.filter((e) => e.active || att.some((a) => a.employeeId === e._id)).map((e) => {
      const mine = att.filter((a) => a.employeeId === e._id);
      const bonus = adj.filter((a) => a.employeeId === e._id && a.type === 'bonus').reduce((s, a) => s + a.amount, 0);
      const fine = adj.filter((a) => a.employeeId === e._id && a.type === 'fine').reduce((s, a) => s + a.amount, 0);
      // الحضور المنسي (أكثر من 16 ساعة) لا يُحسب حتى يُصحَّح، كي لا يتضخم الترتيب
      const minutes = mine.reduce((s, a) => s + (!a.outAt && minutesOf(a) > FORGOT_MIN ? 0 : minutesOf(a)), 0);
      return {
        id: e._id, name: e.name, role: e.role, active: e.active, minutes, days: new Set(mine.map((a) => a.day)).size,
        openNow: mine.some((a) => !a.outAt), forgot: mine.some((a) => !a.outAt && minutesOf(a) > FORGOT_MIN),
        bonus, fine, paidLeaveDays: lv.filter((l) => l.employeeId === e._id && l.paid).reduce((s, l) => s + l.days, 0),
        salary: e.salary ?? 0, employeeOfMonth: award?.employeeId === e._id,
      };
    });
    rows.sort((a, b) => b.minutes - a.minutes || a.name.localeCompare(b.name, 'ar'));
    rows.forEach((r, i) => { r.rank = r.minutes ? i + 1 : null; });
    return { month, rows, award: award ? { employeeId: award.employeeId, name: award.name, note: award.note, bonus: award.bonus ?? 0 } : null };
  }

  async function overview(actor, { month } = {}) {
    requirePerm(actor, 'hr.manage');
    const m = await monthData(month);
    const showPay = can(actor.role, 'admin.employees'); // الرواتب للمالك فقط
    for (const r of m.rows) { if (!showPay) delete r.salary; else r.net = r.salary + r.bonus - r.fine; }
    const t = await tz();
    const today = localDate(now(), t);
    const present = (await ATT().find({ open: true }).toArray()).map(viewAtt);
    const pending = (await LV().find({ status: 'pending' }).toArray()).map(viewLeave).sort((a, b) => a.from.localeCompare(b.from));
    const onLeaveToday = (await LV().find({ status: 'approved', from: { $lte: today }, to: { $gte: today } }).toArray()).map(viewLeave);
    return { ...m, present, pending, onLeaveToday, showPay };
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
    const att = (await ATT().find({ employeeId: id }).toArray()).filter((a) => a.day?.startsWith(m)).sort((a, b) => new Date(b.inAt) - new Date(a.inAt)).map(viewAtt);
    const adj = (await ADJ().find({ employeeId: id }).toArray()).filter((a) => a.day.startsWith(m)).sort((a, b) => b.day.localeCompare(a.day)).map(viewAdj);
    const leaves = (await LV().find({ employeeId: id }).toArray()).sort((a, b) => b.from.localeCompare(a.from)).slice(0, 30).map(viewLeave);
    const awards = (await AW().find({ employeeId: id }).toArray()).sort((a, b) => b.month.localeCompare(a.month)).map((a) => a.month);
    const open = await ATT().findOne({ employeeId: id, open: true });
    const summary = (await monthData(m)).rows.find((r) => r.id === id) ?? { minutes: 0, days: 0, bonus: 0, fine: 0, paidLeaveDays: 0, rank: null };
    const showPay = id === actor.id || can(actor.role, 'admin.employees');
    if (!showPay) delete summary.salary; else summary.net = (summary.salary ?? 0) + summary.bonus - summary.fine;
    return {
      employee: { id: emp._id, name: emp.name, role: emp.role, phone: emp.phone ?? null, active: emp.active, annualLeave: emp.annualLeave ?? 14 },
      month: m, summary, attendance: att, adjustments: adj, leaves, awards, clockedIn: open ? viewAtt(open) : null,
      leaveBalance: await leaveBalance(emp, m.slice(0, 4)),
    };
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

  return { clock, requestLeave, decideLeave, addAdjustment, removeAdjustment, fixAttendance, overview, record, distributeIncentives, setAward };
}
