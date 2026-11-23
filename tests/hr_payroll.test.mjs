// الموارد البشرية — الرواتب: جدول الدوام (تأخير، غياب، إضافي)، الإجازة بلا راتب، السحب من الراتب (يُخصم كاملاً نهاية الشهر)، الصرف بقسيمة مقفلة ومصروف مرتبط،
// الأجر بالساعة، أداء المبيعات، وملف الموظف. كل الأرقام محسوبة يدوياً في التعليقات.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MemoryDb } from '../server/db/memory.js';
import { ensureIndexes } from '../server/db/indexes.js';
import { createApp } from '../server/app/index.js';
import { calculateTicket, unitPrice } from '../shared/calc.js';

async function boot() {
  const db = new MemoryDb({ newId: randomUUID });
  await ensureIndexes(db);
  let clock = new Date('2026-10-14T07:00:00Z'); // الأربعاء 10:00 بتوقيت بغداد
  const app = createApp({ db, now: () => clock, log: { error: (e) => process.env.DEBUG_LOG && console.error(e), warn() {}, info() {} } });
  const tokens = {};
  const call = async (who, method, path, body, query) => {
    const r = await app.handle({ method, path, body, query, token: tokens[who] ?? null, ip: who });
    if (r.setToken !== undefined) tokens[who] = r.setToken;
    return r;
  };
  const ok = async (who, method, path, body, query) => {
    const r = await call(who, method, path, body, query);
    assert.equal(r.status, 200, `${method} ${path} → ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  assert.equal((await call('owner', 'POST', '/api/setup', { storeName: 'مقهى الزيتون', ownerName: 'أحمد', pin: '1357', seed: true })).status, 200);
  await ok('owner', 'POST', '/api/auth/pin', { pin: '1357' });
  return { call, ok, tick: (ms) => { clock = new Date(clock.getTime() + ms); } };
}

const errOf = async (p) => (await p).body.error;
const WEEK = (start, end) => [0, 1, 2, 3, 4, 5, 6].map((d) => (d === 5 ? null : { start, end })); // عطلة الجمعة

test('الرواتب: تأخير وغياب وإضافي وإجازة بلا راتب وسحب من الراتب، صرف مقفل بمصروف مرتبط، وإلغاء الصرف', async () => {
  const { ok, call, tick } = await boot();
  const sara = await ok('owner', 'POST', '/api/admin/employees', { name: 'سارة', role: 'cashier', pin: '2468', salary: 600000 });
  const ali = await ok('owner', 'POST', '/api/admin/employees', { name: 'علي', role: 'barista', pin: '1122' });
  await ok('owner', 'POST', '/api/admin/employees', { name: 'زينب', role: 'manager', pin: '2580' });
  await ok('sara', 'POST', '/api/auth/pin', { pin: '2468' });
  await ok('ali', 'POST', '/api/auth/pin', { pin: '1122' });
  await ok('mgr', 'POST', '/api/auth/pin', { pin: '2580' });

  // السياسة للمالك فقط
  assert.equal((await call('mgr', 'POST', '/api/hr/policy', { lateFine: 1 })).status, 403);
  const pol = await ok('owner', 'POST', '/api/hr/policy', { graceMin: 10, lateStepMin: 15, lateFine: 1000, overtimeHourly: 3000, advanceMaxBp: 5000, deductAbsence: true });
  assert.equal(pol.dayDivisor, 30);
  assert.equal((await ok('mgr', 'GET', '/api/hr/policy')).lateFine, 1000);

  // ملف الموظف: المدير يحفظ الجدول والبيانات، ولا يغيّر الأجر
  assert.equal(await errOf(call('mgr', 'POST', `/api/hr/profile/${sara.id}`, { schedule: WEEK('9:00', '17:00') })), 'INVALID_TIME');
  const prof = await ok('mgr', 'POST', `/api/hr/profile/${sara.id}`, { phone: '07701234567', hiredAt: '2026-10-12', schedule: WEEK('09:00', '17:00'), payType: 'hourly', salary: 1 });
  assert.equal(prof.salary, undefined, 'المدير لا يرى الأجر');
  assert.equal(prof.schedule[5], null);
  await ok('owner', 'POST', `/api/hr/profile/${ali.id}`, { payType: 'hourly', hourlyRate: 2000, hiredAt: '2026-10-14' });
  let rec = await ok('owner', 'GET', `/api/hr/record/${sara.id}`, null, { month: '2026-10' });
  assert.equal(rec.profile.payType, 'monthly', 'محاولة المدير تغيير الأجر لم تُحفظ');
  assert.equal(rec.profile.salary, 600000);

  // حضور متأخر ساعة (الدوام 9:00، الحضور 10:00) وانصراف 19:00 = 9 ساعات (ساعة إضافية)
  await ok('sara', 'POST', '/api/hr/clock', { clientId: randomUUID(), action: 'in' });
  await ok('ali', 'POST', '/api/hr/clock', { clientId: randomUUID(), action: 'in' });
  // أداء المبيعات: سارة تبيع
  await ok('owner', 'POST', '/api/shifts/open', { startingCash: 300000 });
  const { catalog, settings } = await ok('sara', 'GET', '/api/pos/bootstrap');
  const water = catalog.items.find((i) => i.name === 'ماء').variants[0];
  const total = calculateTicket([{ qty: 2, unitPrice: unitPrice(water.price, []) }], { discounts: [], pointsRedeemed: 0, tax: settings.tax }).total;
  await ok('sara', 'POST', '/api/sales', { clientId: randomUUID(), diningOption: 'takeaway', lines: [{ variantId: water.id, qty: 2 }], clientTotal: total, payments: [{ typeId: 'cash', amount: total }] });
  tick(8 * 3600_000);
  await ok('ali', 'POST', '/api/hr/clock', { clientId: randomUUID(), action: 'out' });
  tick(3600_000);
  await ok('sara', 'POST', '/api/hr/clock', { clientId: randomUUID(), action: 'out' });

  // إجازة بلا راتب يومين (20 و21)
  const lv = await ok('sara', 'POST', '/api/hr/leaves', { clientId: randomUUID(), from: '2026-10-20', to: '2026-10-21', type: 'unpaid' });
  const meMgr = await ok('mgr', 'GET', '/api/hr/record/me', null, { month: '2026-10' });
  assert.equal(meMgr.pendingLeaves, 1, 'تنبيه المدير بطلب إجازة معلّق');
  await ok('mgr', 'POST', `/api/hr/leaves/${lv.id}/decide`, { status: 'approved' });

  let ov = await ok('mgr', 'GET', '/api/hr/overview', null, { month: '2026-10' });
  const row = (id) => ov.rows.find((r) => r.id === id);
  assert.equal(row(sara.id).lateCount, 1);
  assert.equal(row(sara.id).lateMin, 60);
  assert.equal(row(sara.id).absentDays, 2, 'الإثنين والثلاثاء بعد التعيين بلا حضور ولا إجازة');
  assert.equal(row(sara.id).overtimeMin, 60);
  assert.equal(row(sara.id).unpaidLeaveDays, 2);
  assert.equal(row(sara.id).perf.sales, 1);
  assert.equal(row(sara.id).perf.salesTotal, total);
  assert.equal(row(ali.id).absentDays, 0, 'علي بلا جدول: لا غياب');
  const late = ov.late.find((l) => l.employeeId === sara.id);
  assert.equal(late.fine, 4000, '60 دقيقة ÷ 15 = 4 × 1,000');
  assert.equal(late.fined, false);

  // غرامات التأخير مرة واحدة فقط
  assert.equal((await ok('mgr', 'POST', '/api/hr/late-fines', { month: '2026-10' })).total, 4000);
  assert.equal((await ok('mgr', 'POST', '/api/hr/late-fines', { month: '2026-10' })).count, 0);
  ov = await ok('mgr', 'GET', '/api/hr/overview', null, { month: '2026-10' });
  assert.equal(ov.late.find((l) => l.employeeId === sara.id).fined, true);
  await ok('mgr', 'POST', '/api/hr/adjustments', { clientId: randomUUID(), employeeId: sara.id, type: 'bonus', amount: 10000, reason: 'خدمة ممتازة' });

  // سحب 200,000 من الراتب نقداً من الدرج (الحد في هذا الاختبار 50% = 300,000)
  const advBody = { clientId: randomUUID(), employeeId: sara.id, amount: 200000, installments: 2, fromDrawer: true, note: 'ظرف طارئ' };
  const adv = await ok('mgr', 'POST', '/api/hr/advances', advBody);
  assert.equal((await ok('mgr', 'POST', '/api/hr/advances', advBody)).id, adv.id, 'إعادة الإرسال لا تكرر السحب');
  assert.equal(adv.perMonth, 200000, 'لا أقساط: يُخصم كاملاً حتى لو أُرسلت أقساط');
  const lim = await call('mgr', 'POST', '/api/hr/advances', { clientId: randomUUID(), employeeId: sara.id, amount: 150000 });
  assert.equal(lim.body.error, 'ADVANCE_LIMIT');
  assert.equal(lim.body.detail, '100000');
  const shift = await ok('owner', 'GET', '/api/shifts/current');
  assert.equal(shift.live.expectedCash, 300000 + total - 200000, 'السحب خرج من الدرج');

  // كشف الرواتب: عُيّنت يوم 12 فالراتب 600,000 − 11 يوماً × 20,000 = 380,000، + إضافي 3,000 + حافز 10,000 − تأخير 4,000 − إجازة بلا راتب 40,000 − غياب 40,000 = 309,000؛ السحب 200,000 يُخصم كاملاً → الصافي 109,000
  assert.equal((await call('mgr', 'GET', '/api/hr/payroll', null, { month: '2026-10' })).status, 403, 'الرواتب للمالك فقط');
  let pr = await ok('owner', 'GET', '/api/hr/payroll', null, { month: '2026-10' });
  const ps = pr.rows.find((r) => r.employeeId === sara.id);
  assert.deepEqual([ps.base, ps.overtimePay, ps.bonus, ps.fine, ps.leaveDeduction, ps.absenceDeduction, ps.gross, ps.advance, ps.net],
    [380000, 3000, 10000, 4000, 40000, 40000, 309000, 200000, 109000]);
  const pa = pr.rows.find((r) => r.employeeId === ali.id);
  assert.equal(pa.payType, 'hourly');
  assert.equal(pa.net, 16000, '8 ساعات × 2,000');

  // الصرف من الدرج لا يتجاوز ما فيه، ولا يترك قسيمة نصف مصروفة
  const payBody = { clientId: randomUUID(), month: '2026-10', employeeIds: [sara.id], fromDrawer: true };
  assert.equal(await errOf(call('owner', 'POST', '/api/hr/payroll/pay', payBody)), 'DRAWER_INSUFFICIENT');
  pr = await ok('owner', 'GET', '/api/hr/payroll', null, { month: '2026-10' });
  assert.equal(pr.rows.find((r) => r.employeeId === sara.id).paid, false);
  const paid = await ok('owner', 'POST', '/api/hr/payroll/pay', { ...payBody, fromDrawer: false });
  assert.equal(paid.total, 109000);
  assert.equal((await ok('owner', 'POST', '/api/hr/payroll/pay', { ...payBody, fromDrawer: false })).rows[0].id, paid.rows[0].id, 'لا يُصرف مرتين');

  // القسيمة مقفلة: لا حوافز ولا غرامات ولا إجازات في الشهر المصروف، والمصروف المرتبط لا يُحذف من صفحة المصروفات
  assert.equal(await errOf(call('mgr', 'POST', '/api/hr/adjustments', { clientId: randomUUID(), employeeId: sara.id, type: 'fine', amount: 1000, reason: 'كسر كوب' })), 'PAYROLL_LOCKED');
  const exp = await ok('owner', 'GET', '/api/admin/expenses', null, { from: '2026-10-01', to: '2026-10-31' });
  assert.equal(exp.byCategory.salaries, 309000, 'الرواتب = الصافي المصروف + السحب = الراتب المستحق');
  assert.equal(exp.byCategory.advances, undefined);
  assert.equal(exp.total, 309000);
  const salExp = exp.rows.find((r) => r.category === 'salaries');
  assert.equal(await errOf(call('owner', 'DELETE', `/api/admin/expenses/${salExp.id}`)), 'EXPENSE_LINKED');
  assert.equal(await errOf(call('mgr', 'DELETE', `/api/hr/advances/${adv.id}`)), 'ADVANCE_IN_USE');

  // سجل الموظف: يرى قسيمته المصروفة، والسحب خُصم كاملاً
  rec = await ok('sara', 'GET', '/api/hr/record/me', null, { month: '2026-10' });
  assert.equal(rec.payroll.paid, true);
  assert.equal(rec.payroll.net, 109000);
  assert.equal(rec.advances[0].remaining, 0);
  // الشهر القادم: القسط الثاني يُخصم تلقائياً
  rec = await ok('owner', 'GET', `/api/hr/record/${sara.id}`, null, { month: '2026-11' });
  assert.equal(rec.payroll.advance, 0, 'لا شيء يُرحّل للشهر القادم');
  assert.equal(rec.payroll.net, 600000);

  // إلغاء الصرف يحذف المصروف ويفتح الشهر للتعديل
  await ok('owner', 'DELETE', `/api/hr/payroll/${paid.rows[0].id}`);
  assert.equal((await ok('owner', 'GET', '/api/admin/expenses', null, { from: '2026-10-01', to: '2026-10-31' })).total, 200000);
  await ok('mgr', 'POST', '/api/hr/adjustments', { clientId: randomUUID(), employeeId: sara.id, type: 'fine', amount: 1000, reason: 'كسر كوب' });
  pr = await ok('owner', 'GET', '/api/hr/payroll', null, { month: '2026-10' });
  assert.equal(pr.rows.find((r) => r.employeeId === sara.id).net, 108000);
  // بلا قسيمة: السحب يُلغى ويُحذف مصروفها ويعود نقدها للدرج
  await ok('mgr', 'DELETE', `/api/hr/advances/${adv.id}`);
  assert.equal((await ok('owner', 'GET', '/api/shifts/current')).live.expectedCash, 300000 + total);
  assert.equal((await ok('owner', 'GET', '/api/hr/payroll', null, { month: '2026-10' })).rows.find((r) => r.employeeId === sara.id).net, 308000);
});

test('الرواتب: موظف عُيّن خلال الشهر يأخذ راتبه بنسبة الأيام، ولا غياب قبل تعيينه', async () => {
  const { ok } = await boot();
  const emp = await ok('owner', 'POST', '/api/admin/employees', { name: 'مريم', role: 'cashier', pin: '7531', salary: 900000 });
  await ok('owner', 'POST', `/api/hr/profile/${emp.id}`, { hiredAt: '2026-10-11', schedule: WEEK('09:00', '17:00') });
  const r = (await ok('owner', 'GET', '/api/hr/payroll', null, { month: '2026-10' })).rows.find((x) => x.employeeId === emp.id);
  assert.equal(r.preHireDays, 10);
  assert.equal(r.base, 900000 - 300000, '10 أيام × (900,000 ÷ 30)');
  assert.equal(r.absentDays, 3, 'الأحد 11 والإثنين 12 والثلاثاء 13 فقط، لا ما قبل التعيين');
  assert.equal(r.net, 600000 - 90000);
});

test('الرواتب: الخصومات لا تجعل الصافي سالباً، والغرامات الزائدة تظهر كعجز', async () => {
  const { ok } = await boot();
  const emp = await ok('owner', 'POST', '/api/admin/employees', { name: 'حسن', role: 'barista', pin: '4826', salary: 30000 });
  await ok('owner', 'POST', '/api/hr/adjustments', { clientId: randomUUID(), employeeId: emp.id, type: 'fine', amount: 50000, reason: 'تلف جهاز' });
  const pr = await ok('owner', 'GET', '/api/hr/payroll', null, { month: '2026-10' });
  const r = pr.rows.find((x) => x.employeeId === emp.id);
  assert.equal(r.net, 0);
  assert.equal(r.shortfall, 20000);
  const paid = await ok('owner', 'POST', '/api/hr/payroll/pay', { clientId: randomUUID(), month: '2026-10', employeeIds: [emp.id] });
  assert.equal(paid.rows[0].expenseId, null, 'لا مصروف بصفر');
  assert.equal((await ok('owner', 'GET', '/api/admin/expenses', null, { from: '2026-10-01', to: '2026-10-31' })).total, 0);
});

test('إلى أين ذهبت الفلوس: المصروفات والرواتب والسحوبات والمشتريات ونقص المخزون مرتبطة بمصادرها بلا تكرار', async () => {
  const { ok, call } = await boot();
  const emp = await ok('owner', 'POST', '/api/admin/employees', { name: 'نور', role: 'cashier', pin: '8642', salary: 300000 });
  await ok('owner', 'POST', '/api/admin/expenses', { clientId: randomUUID(), amount: 25000, category: 'utilities', note: 'كهرباء' });
  // مشتريات: 1,000 مل حليب بسعر 2.5 = 2,500، ثم تصحيح إلى 2,000 مل بنفس السعر (+2,500)
  const inv = await ok('owner', 'GET', '/api/admin/inventory');
  const milk = inv.rows.find((r) => r.name === 'حليب كامل');
  await ok('owner', 'POST', '/api/admin/inventory/receive', { supplier: 'الألبان', lines: [{ id: randomUUID(), variantId: milk.variantId, qty: 1000, total: 2500 }] });
  const rc = (await ok('owner', 'GET', '/api/admin/inventory/receipts')).find((x) => x.variantId === milk.variantId);
  await ok('owner', 'POST', `/api/admin/inventory/receipts/${rc.id}/fix`, { clientId: randomUUID(), qty: 2000, cost: '2.5', note: 'الكمية الصحيحة' });
  // هدر 400 مل بتكلفة الوحدة الحالية
  const before = (await ok('owner', 'GET', '/api/admin/inventory')).rows.find((r) => r.variantId === milk.variantId);
  await ok('owner', 'POST', '/api/admin/inventory/adjust', { clientId: randomUUID(), variantId: milk.variantId, type: 'loss', qty: 400, note: 'انسكب' });
  const lossValue = Math.round((400 * before.costMilli) / 1000);
  // حافز يدخل الراتب، وسحب من الراتب، وصرف الراتب
  await ok('owner', 'POST', '/api/hr/adjustments', { clientId: randomUUID(), employeeId: emp.id, type: 'bonus', amount: 15000, reason: 'ممتاز' });
  await ok('owner', 'POST', '/api/hr/advances', { clientId: randomUUID(), employeeId: emp.id, amount: 50000 });
  const paid = await ok('owner', 'POST', '/api/hr/payroll/pay', { clientId: randomUUID(), month: '2026-10', employeeIds: [emp.id] });
  const net = paid.rows[0].net;
  assert.equal(net, paid.rows[0].gross - 50000, 'الحافز داخل الإجمالي، والسحب مخصوم');

  const sp = await ok('owner', 'GET', '/api/admin/expenses/summary', null, { from: '2026-10-14', to: '2026-10-14' });
  assert.equal(sp.cash.operating, 25000);
  assert.equal(sp.cash.byCategory.utilities, 25000);
  assert.equal(sp.cash.salaries, net + 50000, 'الرواتب = الصافي المصروف + السحب');
  assert.equal(sp.cash.advances, 50000);
  assert.equal(sp.cash.purchases, 5000, 'الاستلام 2,500 + التصحيح 2,500');
  assert.equal(sp.cash.total, 25000 + net + 50000 + 5000);
  assert.equal(sp.hr.bonuses, 15000, 'الحافز يظهر ولا يُضاف مرة ثانية للمصروفات');
  assert.equal(sp.costs.stockLoss, lossValue);
  // صافي الربح: المصروفات (تشغيل + رواتب وسحوبات) ونقص المخزون، وليس المشتريات (الربح يحسب تكلفة ما بيع)
  const rep = await ok('owner', 'GET', '/api/admin/reports', null, { from: '2026-10-14', to: '2026-10-14' });
  assert.equal(rep.summary.stockLoss, lossValue);
  assert.equal(rep.summary.netProfit, rep.summary.profit - (25000 + net + 50000) - lossValue);
  assert.equal(sp.profit.netProfit, rep.summary.netProfit);
  assert.equal((await call('sara', 'GET', '/api/admin/expenses/summary', null, { from: '2026-10-14', to: '2026-10-14' })).status, 401);
});

test('استلام مشتريات مدفوع من درج الوردية: سحب واحد بالمجموع، لا يتكرر، ولا يُكتب شيء إن لم يكفِ النقد', async () => {
  const { ok, call } = await boot();
  const inv = await ok('owner', 'GET', '/api/admin/inventory');
  const milk = inv.rows.find((r) => r.name === 'حليب كامل');
  const bean = inv.rows.find((r) => r.name === 'بن إسبريسو');
  const lines = [{ id: randomUUID(), variantId: milk.variantId, qty: 2000, total: 5000 }, { id: randomUUID(), variantId: bean.variantId, qty: 1000, total: 30000 }];
  assert.equal(await errOf(call('owner', 'POST', '/api/admin/inventory/receive', { lines, fromDrawer: true })), 'NO_OPEN_SHIFT');
  await ok('owner', 'POST', '/api/shifts/open', { startingCash: 20000 });
  // النقد لا يكفي (20,000 < 35,000): لا سحب ولا إضافة للمخزون
  assert.equal(await errOf(call('owner', 'POST', '/api/admin/inventory/receive', { lines, fromDrawer: true })), 'DRAWER_INSUFFICIENT');
  assert.equal((await ok('owner', 'GET', '/api/admin/inventory')).rows.find((r) => r.variantId === milk.variantId).stock, milk.stock);
  assert.equal(await errOf(call('owner', 'POST', '/api/admin/inventory/receive', { lines: [{ ...lines[0], total: null }], fromDrawer: true })), 'PRICE_REQUIRED');
  await ok('owner', 'POST', '/api/shifts/move', { clientId: randomUUID(), type: 'pay_in', amount: 30000, note: 'فكة' });
  const r = await ok('owner', 'POST', '/api/admin/inventory/receive', { supplier: 'الألبان', lines, fromDrawer: true });
  assert.equal(r.paidFromDrawer, 35000);
  assert.equal((await ok('owner', 'POST', '/api/admin/inventory/receive', { supplier: 'الألبان', lines, fromDrawer: true })).received, 0, 'الإعادة لا تضيف ولا تسحب');
  const cur = await ok('owner', 'GET', '/api/shifts/current');
  assert.equal(cur.live.expectedCash, 20000 + 30000 - 35000);
  const after = (await ok('owner', 'GET', '/api/admin/inventory')).rows.find((r2) => r2.variantId === milk.variantId);
  assert.equal(after.stock, milk.stock + 2000);
  // المشتريات بالمبلغ المدفوع فعلاً، ومنها ما خرج من الدرج؛ ولا تدخل صافي الربح كمصروف
  const sp = await ok('owner', 'GET', '/api/admin/expenses/summary', null, { from: '2026-10-14', to: '2026-10-14' });
  assert.equal(sp.cash.purchases, 35000);
  assert.equal(sp.cash.purchasesFromDrawer, 35000);
  assert.equal(sp.profit.expenses, 0);
});
