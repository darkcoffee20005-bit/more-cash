// الورديات وإدارة النقد (على نهج Loyverse: رصيد افتتاحي، إدخال/سحب نقد، إغلاق بالنقد الفعلي).
// النقد المتوقع = الافتتاحي + المبيعات النقدية − المرتجعات النقدية + الإدخال − السحب
// يُحسب دائماً من الإيصالات وحركات الوردية، ولا يُخزَّن رصيد قابل للانحراف.
import { buildReport } from '../../shared/reports.js';
import { AppError, audit, bad, conflict, getSettings, id as checkId, int, isDup, nextSeq, out, requirePerm, str } from './core.js';

export function createShifts(ctx) {
  const { db, now, newId } = ctx;
  const shifts = () => db.collection('shifts');

  async function summarize(shift) {
    const settings = await getSettings(db);
    const receipts = await db.collection('receipts').find({ shiftId: shift._id }).toArray();
    const report = buildReport(receipts, { tzOffsetMin: settings.tzOffsetMin });
    const cashTypes = new Set(settings.paymentTypes.filter((p) => p.kind === 'cash').map((p) => p.id));
    let cashSales = 0;
    let cashRefunds = 0;
    for (const r of receipts) {
      for (const p of r.payments) {
        if (!cashTypes.has(p.typeId) && p.kind !== 'cash') continue;
        if (r.type === 'refund') cashRefunds += p.amount; else cashSales += p.amount;
      }
    }
    const payIn = shift.movements.filter((m) => m.type === 'pay_in').reduce((a, m) => a + m.amount, 0);
    const payOut = shift.movements.filter((m) => m.type === 'pay_out').reduce((a, m) => a + m.amount, 0);
    return {
      startingCash: shift.startingCash, cashSales, cashRefunds, payIn, payOut,
      expectedCash: shift.startingCash + cashSales - cashRefunds + payIn - payOut,
      gross: report.summary.gross, refunds: report.summary.refunds, discounts: report.summary.discounts,
      net: report.summary.net, tax: report.summary.tax, salesCount: report.summary.salesCount,
      refundsCount: report.summary.refundsCount, byPayment: report.byPayment,
    };
  }

  const view = async (shift) => (shift ? { ...out(shift), live: shift.status === 'open' ? await summarize(shift) : null } : null);

  async function current(actor) {
    if (!actor) throw new AppError(401, 'NOT_AUTHENTICATED');
    return view(await shifts().findOne({ status: 'open' }));
  }

  async function requireOpen() {
    const s = await shifts().findOne({ status: 'open' });
    if (!s) throw conflict('NO_OPEN_SHIFT');
    return s;
  }

  async function open(actor, input = {}) {
    requirePerm(actor, 'shift.manage');
    const startingCash = int(input.startingCash ?? 0, { field: 'startingCash', max: 1_000_000_000 });
    const doc = {
      _id: newId(), number: await nextSeq(db, 'shift'), status: 'open', openedAt: now(), openedBy: actor.id, openedByName: actor.name,
      startingCash, movements: [],
    };
    try {
      await shifts().insertOne(doc);
    } catch (e) {
      if (isDup(e)) throw conflict('SHIFT_ALREADY_OPEN');
      throw e;
    }
    await audit({ ...ctx, actor }, 'shift.open', { shiftId: doc._id, startingCash });
    return view(doc);
  }

  async function move(actor, input = {}) {
    requirePerm(actor, 'shift.cash');
    const type = input.type === 'pay_in' || input.type === 'pay_out' ? input.type : null;
    if (!type) throw bad('INVALID_CHOICE', 'type');
    const clientId = checkId(input.clientId, 'clientId');
    const amount = int(input.amount, { field: 'amount', min: 1, max: 1_000_000_000 });
    const note = str(input.note, { field: 'note', min: 1, max: 120 });
    const shift = await requireOpen();
    const movement = { id: clientId, type, amount, note, at: now(), by: actor.id, byName: actor.name };
    // شرط "لا توجد حركة بنفس المعرف" يجعل إعادة الإرسال آمنة
    const r = await shifts().updateOne({ _id: shift._id, status: 'open', 'movements.id': { $ne: clientId } }, { $push: { movements: movement } });
    if (r.matchedCount) await audit({ ...ctx, actor }, `shift.${type}`, { shiftId: shift._id, amount, note });
    return view(await shifts().findOne({ _id: shift._id }));
  }

  async function close(actor, input = {}) {
    requirePerm(actor, 'shift.manage');
    const shift = await requireOpen();
    const actualCash = int(input.actualCash, { field: 'actualCash', max: 1_000_000_000 });
    const note = str(input.note, { field: 'note', max: 200, optional: true });
    const settings = await getSettings(db);
    const summary = await summarize(shift);
    const difference = actualCash - summary.expectedCash;
    if (Math.abs(difference) > (settings.cashVarianceAlert ?? 0) && !note) throw bad('VARIANCE_NOTE_REQUIRED', String(difference));
    const openTickets = await db.collection('tickets').countDocuments({});
    const r = await shifts().updateOne({ _id: shift._id, status: 'open' }, {
      $set: { status: 'closed', closedAt: now(), closedBy: actor.id, closedByName: actor.name, actualCash, difference, note, summary, openTicketsAtClose: openTickets },
    });
    if (!r.matchedCount) throw conflict('SHIFT_ALREADY_CLOSED');
    await audit({ ...ctx, actor }, 'shift.close', { shiftId: shift._id, expected: summary.expectedCash, actualCash, difference });
    return view(await shifts().findOne({ _id: shift._id }));
  }

  async function list(actor, { from, to } = {}) {
    requirePerm(actor, 'admin.reports');
    const q = from && to ? { openedAt: { $gte: from, $lt: to } } : {};
    return (await shifts().find(q).sort({ openedAt: -1 }).limit(200).toArray()).map((s) => out(s));
  }

  return { current, open, move, close, list, requireOpen };
}
