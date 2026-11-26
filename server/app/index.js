// تجميع الخدمات وواجهة API كدالة نقية: handle(request) → response.
// خادم Node (server/http.js) والنسخة التجريبية في المتصفح يستخدمان نفس الدالة.
import { dayRange } from '../../shared/format.js';
import { AppError, getSettings, requirePerm } from './core.js';
import { can } from '../../shared/perms.js';
import { createAuth, createSettings, publicEmployee } from './auth.js';
import { createCatalog } from './catalog.js';
import { createInventory } from './inventory.js';
import { createReports } from './reports.js';
import { createExpenses } from './expenses.js';
import { createHr } from './hr.js';
import { createSales } from './sales.js';
import { createShifts } from './shifts.js';

export function createApp({ db, now = () => new Date(), newId = () => crypto.randomUUID(), pepper = null, log = console, readInvoice = null }) {
  const ctx = { db, now, newId, pepper, log, readInvoice };
  ctx.inventory = createInventory(ctx);
  ctx.shifts = createShifts(ctx);
  ctx.expenses = createExpenses(ctx);
  ctx.hr = createHr(ctx);
  const auth = createAuth(ctx);
  const settings = createSettings(ctx);
  const catalog = createCatalog(ctx);
  const sales = createSales(ctx);
  const reports = createReports(ctx);
  ctx.services = { auth, settings, catalog, sales, reports };

  const toRange = async (q) => {
    if (!q.from || !q.to) return {};
    const s = await getSettings(db);
    try { return dayRange(q.from, q.to, s.tzOffsetMin); } catch { throw new AppError(400, 'INVALID_RANGE'); }
  };

  // [method, pattern, handler(actor, req, params), {public}]
  const routes = [
    ['GET', '/api/state', async (actor) => ({ setUp: await auth.isSetUp(), employee: actor ? publicEmployee({ _id: actor.id, ...actor }) : null }), { public: true }],
    ['POST', '/api/setup', async (_a, req) => auth.setup(req.body), { public: true }],
    ['POST', '/api/auth/pin', async (_a, req) => auth.login(req.body, req.ip), { public: true, login: true }],
    // شاشة الحضور المشتركة: تعمل على الجهاز المرتبط بالمقهى قبل دخول أي موظف (الرمز هو التحقق)
    ['GET', '/api/hr/kiosk', async () => ctx.hr.kioskList(), { public: true }],
    ['POST', '/api/hr/kiosk/clock', async (_a, req) => ctx.hr.kioskClock(await auth.verifyPin(req.body?.employeeId, req.body?.pin, req.ip), req.body), { public: true }],
    ['POST', '/api/auth/logout', async (_a, req) => { await auth.logout(req.token); return { ok: true }; }, { public: true, logout: true }],

    ['GET', '/api/pos/bootstrap', async (actor) => ({
      settings: await settings.get(actor), catalog: await catalog.posCatalog(), shift: await ctx.shifts.current(actor),
      ticketsCount: (await db.collection('tickets').countDocuments({})),
    })],
    ['GET', '/api/shifts/current', (actor) => ctx.shifts.current(actor)],
    ['POST', '/api/shifts/open', (actor, req) => ctx.shifts.open(actor, req.body)],
    ['POST', '/api/shifts/move', (actor, req) => ctx.shifts.move(actor, req.body)],
    ['POST', '/api/shifts/close', (actor, req) => ctx.shifts.close(actor, req.body)],
    ['GET', '/api/shifts', async (actor, req) => ctx.shifts.list(actor, await toRange(req.query))],

    ['POST', '/api/sales', (actor, req) => sales.createSale(actor, req.body)],
    ['GET', '/api/receipts', async (actor, req) => sales.listReceipts(actor, { ...(await toRange(req.query)), search: req.query.search ?? '', limit: Number(req.query.limit) || 60 })],
    ['GET', '/api/receipts/:id', (actor, req, p) => sales.getReceipt(actor, p.id)],
    ['POST', '/api/receipts/:id/refund', (actor, req, p) => sales.refund(actor, p.id, req.body)],

    ['GET', '/api/kds', (actor) => sales.kdsList(actor)],
    ['POST', '/api/kds/:id/advance', (actor, req, p) => sales.kdsAdvance(actor, p.id, req.body)],
    ['POST', '/api/kds/:id/urgent', (actor, req, p) => sales.kdsUrgent(actor, p.id, req.body)],

    ['GET', '/api/tickets', (actor) => sales.listTickets(actor)],
    ['POST', '/api/tickets', (actor, req) => sales.saveTicket(actor, req.body)],
    ['DELETE', '/api/tickets/:id', (actor, req, p) => sales.deleteTicket(actor, p.id)],

    ['GET', '/api/customers', (actor, req) => sales.listCustomers(actor, { search: req.query.search ?? '', away: req.query.away })],
    ['GET', '/api/customers/:id', (actor, req, p) => sales.getCustomer(actor, p.id)],
    ['POST', '/api/customers', (actor, req) => sales.saveCustomer(actor, req.body)],

    ['GET', '/api/admin/dashboard', (actor) => reports.dashboard(actor)],
    ['GET', '/api/admin/reports', (actor, req) => reports.report(actor, req.query)],
    ['GET', '/api/admin/reports/daily', (actor, req) => reports.daily(actor, req.query)],
    ['GET', '/api/admin/expenses', (actor, req) => ctx.expenses.list(actor, req.query)],
    ['GET', '/api/admin/expenses/summary', (actor, req) => reports.spending(actor, req.query)],
    // الموارد البشرية
    ['POST', '/api/hr/clock', (actor, req) => ctx.hr.clock(actor, req.body)],
    ['POST', '/api/hr/leaves', (actor, req) => ctx.hr.requestLeave(actor, req.body)],
    ['POST', '/api/hr/leaves/:id/decide', (actor, req, p) => ctx.hr.decideLeave(actor, p.id, req.body)],
    ['GET', '/api/hr/overview', (actor, req) => ctx.hr.overview(actor, req.query)],
    ['GET', '/api/hr/record/:id', (actor, req, p) => ctx.hr.record(actor, p.id, req.query)],
    ['POST', '/api/hr/adjustments', (actor, req) => ctx.hr.addAdjustment(actor, req.body)],
    ['DELETE', '/api/hr/adjustments/:id', (actor, req, p) => ctx.hr.removeAdjustment(actor, p.id)],
    ['POST', '/api/hr/attendance/:id/fix', (actor, req, p) => ctx.hr.fixAttendance(actor, p.id, req.body)],
    ['POST', '/api/hr/incentives', (actor, req) => ctx.hr.distributeIncentives(actor, req.body)],
    ['PUT', '/api/admin/floor', (actor, req) => catalog.saveFloor(actor, req.body)],
    ['POST', '/api/hr/award', (actor, req) => ctx.hr.setAward(actor, req.body)],
    ['GET', '/api/hr/policy', (actor) => ctx.hr.getPolicy(actor)],
    ['POST', '/api/hr/policy', (actor, req) => ctx.hr.savePolicy(actor, req.body)],
    ['POST', '/api/hr/profile/:id', (actor, req, p) => ctx.hr.saveProfile(actor, p.id, req.body)],
    ['POST', '/api/hr/late-fines', (actor, req) => ctx.hr.lateFines(actor, req.body)],
    ['POST', '/api/hr/advances', (actor, req) => ctx.hr.giveAdvance(actor, req.body)],
    ['DELETE', '/api/hr/advances/:id', (actor, req, p) => ctx.hr.cancelAdvance(actor, p.id)],
    ['GET', '/api/hr/payroll', (actor, req) => ctx.hr.payroll(actor, req.query)],
    ['POST', '/api/hr/payroll/pay', (actor, req) => ctx.hr.payPayroll(actor, req.body)],
    ['DELETE', '/api/hr/payroll/:id', (actor, req, p) => ctx.hr.cancelPayroll(actor, p.id)],
    ['POST', '/api/admin/expenses', (actor, req) => ctx.expenses.create(actor, req.body)],
    ['DELETE', '/api/admin/expenses/:id', (actor, req, p) => ctx.expenses.remove(actor, p.id)],
    // سجل العمليات الحساسة: للمالك فقط
    ['GET', '/api/admin/audit', async (actor, req) => {
      requirePerm(actor, 'admin.settings');
      const r = await toRange(req.query);
      if (!r.from) throw new AppError(400, 'INVALID_RANGE');
      const filter = { at: { $gte: r.from, $lt: r.to } };
      const group = String(req.query.group ?? '');
      if (/^[a-z]{2,20}$/.test(group)) filter.action = { $regex: `^${group}\\.` };
      const rows = await db.collection('audit').find(filter).sort({ at: -1 }).limit(500).toArray();
      return rows.map((x) => ({ id: x._id, action: x.action, at: x.at, byName: x.byName, data: x.data }));
    }],
    ['GET', '/api/admin/items', async (actor) => { requireCatalog(actor); return catalog.listItems({ includeInactive: false }); }],
    ['POST', '/api/admin/items', (actor, req) => catalog.saveItem(actor, req.body)],
    ['DELETE', '/api/admin/items/:id', (actor, req, p) => catalog.archive(actor, 'items', p.id)],
    ['POST', '/api/admin/items/:id/image', (actor, req, p) => catalog.setImage(actor, p.id, req.body)],
    ['DELETE', '/api/admin/items/:id/image', (actor, req, p) => catalog.removeImage(actor, p.id)],
    ['GET', '/api/pos/images', async (actor) => {
      if (!['pos.sell', 'kds.use', 'admin.catalog'].some((x) => can(actor.role, x))) throw new AppError(403, 'FORBIDDEN', 'images');
      return catalog.images();
    }],
    ['GET', '/api/admin/categories', async (actor) => { requireCatalog(actor); return catalog.listCategories(); }],
    ['POST', '/api/admin/categories', (actor, req) => catalog.saveCategory(actor, req.body)],
    ['DELETE', '/api/admin/categories/:id', (actor, req, p) => catalog.archive(actor, 'categories', p.id)],
    ['GET', '/api/admin/modifiers', async (actor) => { requireCatalog(actor); return catalog.listModifiers(); }],
    ['POST', '/api/admin/modifiers', (actor, req) => catalog.saveModifier(actor, req.body)],
    ['DELETE', '/api/admin/modifiers/:id', (actor, req, p) => catalog.archive(actor, 'modifiers', p.id)],
    ['GET', '/api/admin/discounts', async (actor) => { requireCatalog(actor); return catalog.listDiscounts(); }],
    ['POST', '/api/admin/discounts', (actor, req) => catalog.saveDiscount(actor, req.body)],
    ['DELETE', '/api/admin/discounts/:id', (actor, req, p) => catalog.archive(actor, 'discounts', p.id)],
    ['GET', '/api/admin/inventory', (actor) => ctx.inventory.list(actor)],
    ['POST', '/api/admin/inventory/adjust', (actor, req) => ctx.inventory.adjust(actor, req.body)],
    ['POST', '/api/admin/inventory/low-stock', (actor, req) => ctx.inventory.setLowStock(actor, req.body)],
    ['GET', '/api/admin/inventory/receipts', (actor, req) => ctx.inventory.receipts(actor, req.query)],
    ['POST', '/api/admin/inventory/receipts/:id/fix', (actor, req, p) => ctx.inventory.fixReceipt(actor, p.id, req.body)],
    ['GET', '/api/admin/inventory/:id/history', (actor, req, p) => ctx.inventory.history(actor, p.id)],
    ['POST', '/api/admin/inventory/reconcile', (actor) => ctx.inventory.reconcile(actor)],
    ['GET', '/api/admin/inventory/stock-items', async (actor) => { requirePerm(actor, 'admin.inventory'); return ctx.inventory.stockItems(); }],
    ['POST', '/api/admin/inventory/scan', (actor, req) => ctx.inventory.scanInvoice(actor, req.body)],
    ['POST', '/api/admin/inventory/receive', (actor, req) => ctx.inventory.receiveBatch(actor, req.body)],
    ['GET', '/api/admin/employees', (actor) => auth.listEmployees(actor)],
    ['POST', '/api/admin/employees', (actor, req) => auth.saveEmployee(actor, req.body)],
    ['GET', '/api/admin/settings', (actor) => settings.get(actor)],
    ['PUT', '/api/admin/settings', (actor, req) => settings.update(actor, req.body)],
  ].map(([method, pattern, fn, opts = {}]) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([A-Za-z0-9_-]{1,64})'; })}$`);
    return { method, re, keys, fn, opts };
  });

  function requireCatalog(actor) {
    if (!actor) throw new AppError(401, 'NOT_AUTHENTICATED');
    if (!['owner', 'manager'].includes(actor.role)) throw new AppError(403, 'FORBIDDEN', 'admin.catalog');
  }

  /**
   * @param {{method:string, path:string, query?:object, body?:any, token?:string|null, ip?:string}} req
   * @returns {Promise<{status:number, body:any, setToken?:string|null}>}
   */
  async function handle(req) {
    const route = routes.find((r) => r.method === req.method && r.re.test(req.path));
    if (!route) return { status: 404, body: { error: 'NOT_FOUND' } };
    const params = Object.fromEntries(route.keys.map((k, i) => [k, req.path.match(route.re)[i + 1]]));
    try {
      const actor = await auth.resolve(req.token);
      if (!route.opts.public && !actor) throw new AppError(401, 'NOT_AUTHENTICATED');
      const result = await route.fn(actor, { ...req, query: req.query ?? {}, body: req.body ?? {} }, params);
      if (route.opts.login) return { status: 200, body: { employee: result.employee }, setToken: result.token };
      if (route.opts.logout) return { status: 200, body: result, setToken: null };
      return { status: 200, body: result ?? { ok: true } };
    } catch (e) {
      if (e instanceof AppError) return { status: e.status, body: { error: e.code, detail: e.detail } };
      log.error?.(e);
      return { status: 500, body: { error: 'INTERNAL' } };
    }
  }

  async function start() {
    const recovered = await sales.recoverPending().catch((e) => { log.error?.(e); return 0; });
    if (recovered) log.warn?.(`استُكملت آثار ${recovered} إيصال معلّق`);
  }

  return { handle, start, ctx };
}
