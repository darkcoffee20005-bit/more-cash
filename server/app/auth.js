// الإعداد الأول، الدخول بالرمز السري، الجلسات، والموظفون.
import { ROLES, permissionsOf } from '../../shared/perms.js';
import { AppError, audit, bad, bool, conflict, getSettings, id as checkId, int, isDup, notFound, oneOf, out, requirePerm, str } from './core.js';
import { normalizePin, pinLookup, randomToken, sha256, validPin } from './security.js';
import { DEFAULT_SETTINGS, seedMenu } from './seed.js';
import { loyaltyOf } from '../../shared/loyalty.js';

const SESSION_HOURS = 12;
const MAX_FAILS = 5;
const LOCK_MS = 60_000;

export function createAuth(ctx) {
  const { db, now, newId, pepper } = ctx;
  const failures = new Map(); // ip → {count, until}

  // سر بصمات الرموز: سر المقهى (عشوائي لكل مقهى) + PIN_PEPPER من بيئة الخادم إن وُجد
  const mix = (storeSecret) => (pepper ? `${pepper}:${storeSecret}` : storeSecret);
  async function secret() {
    return mix((await getSettings(db)).secret);
  }

  async function isSetUp() {
    return !!(await db.collection('settings').findOne({ _id: 'store' }, { projection: { _id: 1 } }));
  }

  async function setup({ storeName, ownerName, pin: rawPin, seed = true } = {}) {
    const pin = normalizePin(rawPin);
    if (await isSetUp()) throw conflict('ALREADY_SET_UP');
    const name = str(storeName, { field: 'storeName', min: 2, max: 60 });
    const owner = str(ownerName, { field: 'ownerName', min: 2, max: 40 });
    if (!validPin(pin)) throw bad('WEAK_PIN');
    const settings = { _id: 'store', ...structuredClone(DEFAULT_SETTINGS), name, secret: randomToken(32), createdAt: now() };
    try {
      await db.collection('settings').insertOne(settings);
    } catch (e) {
      if (isDup(e)) throw conflict('ALREADY_SET_UP');
      throw e;
    }
    await db.collection('employees').insertOne({
      _id: newId(), name: owner, role: 'owner', pinLookup: await pinLookup(mix(settings.secret), pin), active: true, createdAt: now(),
    });
    if (seed) await seedMenu(ctx);
    return { ok: true };
  }

  function checkLock(ip) {
    const f = failures.get(ip);
    if (f && f.until > Date.now()) throw new AppError(429, 'TOO_MANY_ATTEMPTS', String(Math.ceil((f.until - Date.now()) / 1000)));
  }

  function recordFailure(ip) {
    const f = failures.get(ip) ?? { count: 0, until: 0 };
    f.count += 1;
    if (f.count >= MAX_FAILS) { f.until = Date.now() + LOCK_MS; f.count = 0; }
    failures.set(ip, f);
  }

  async function login({ pin: rawPin } = {}, ip = 'local') {
    const pin = normalizePin(rawPin);
    checkLock(ip);
    if (typeof pin !== 'string' || !/^\d{4,6}$/.test(pin)) { recordFailure(ip); throw new AppError(401, 'WRONG_PIN'); }
    const lookup = await pinLookup(await secret(), pin);
    const emp = await db.collection('employees').findOne({ pinLookup: lookup, active: true });
    if (!emp) { recordFailure(ip); throw new AppError(401, 'WRONG_PIN'); }
    failures.delete(ip);
    const token = randomToken(32);
    await db.collection('sessions').insertOne({
      _id: await sha256(token), employeeId: emp._id, createdAt: now(), expiresAt: new Date(now().getTime() + SESSION_HOURS * 3600_000),
    });
    return { token, employee: publicEmployee(emp) };
  }

  /**
   * شاشة الحضور المشتركة على جهاز الكاشير: الموظف يختار اسمه ويكتب رمزه. لا تُنشأ جلسة ولا تتغير جلسة الجهاز.
   * نفس قفل المحاولات الخاطئة لشاشة الرمز.
   */
  async function verifyPin(employeeId, rawPin, ip = 'local') {
    checkLock(ip);
    const pin = normalizePin(rawPin);
    const emp = await db.collection('employees').findOne({ _id: checkId(employeeId, 'employeeId'), active: true });
    if (!emp || typeof pin !== 'string' || !/^\d{4,6}$/.test(pin) || emp.pinLookup !== await pinLookup(await secret(), pin)) {
      recordFailure(ip);
      throw new AppError(401, 'WRONG_PIN');
    }
    failures.delete(ip);
    return { id: emp._id, name: emp.name, role: emp.role };
  }

  /** يعيد الموظف صاحب الجلسة أو null */
  async function resolve(token) {
    if (typeof token !== 'string' || token.length !== 64) return null;
    const session = await db.collection('sessions').findOne({ _id: await sha256(token) });
    if (!session || session.expiresAt <= now()) return null;
    const emp = await db.collection('employees').findOne({ _id: session.employeeId, active: true });
    return emp ? { id: emp._id, name: emp.name, role: emp.role } : null;
  }

  async function logout(token) {
    if (typeof token === 'string') await db.collection('sessions').deleteOne({ _id: await sha256(token) });
  }

  // ---------------------------------------------------------------- الموظفون
  async function listEmployees(actor) {
    requirePerm(actor, 'admin.employees');
    const list = await db.collection('employees').find({}).sort({ active: -1, name: 1 }).toArray();
    return list.map(publicEmployee);
  }

  async function saveEmployee(actor, input = {}) {
    requirePerm(actor, 'admin.employees');
    const name = str(input.name, { field: 'name', min: 2, max: 40 });
    const role = oneOf(input.role, Object.keys(ROLES), 'role');
    const phone = str(input.phone, { field: 'phone', max: 20, optional: true });
    const active = input.active !== false;
    const set = { name, role, phone, active, updatedAt: now() };
    // الموارد البشرية: الراتب الشهري (اختياري) ورصيد الإجازة السنوية المدفوعة بالأيام
    if (input.salary !== undefined && input.salary !== null && input.salary !== '') set.salary = int(input.salary, { field: 'salary', min: 0, max: 1_000_000_000 });
    if (input.annualLeave !== undefined && input.annualLeave !== null && input.annualLeave !== '') set.annualLeave = int(input.annualLeave, { field: 'annualLeave', min: 0, max: 90 });
    if (input.pin) {
      input.pin = normalizePin(input.pin);
      if (!validPin(input.pin)) throw bad('WEAK_PIN');
      set.pinLookup = await pinLookup(await secret(), input.pin);
    }
    const coll = db.collection('employees');
    try {
      if (input.id) {
        const existing = await coll.findOne({ _id: checkId(input.id) });
        if (!existing) throw notFound();
        if (existing.role === 'owner' && (role !== 'owner' || !active)) {
          const owners = await coll.countDocuments({ role: 'owner', active: true });
          if (owners <= 1) throw conflict('LAST_OWNER');
        }
        await coll.updateOne({ _id: existing._id }, { $set: set });
        if (!active || input.pin) await db.collection('sessions').deleteMany({ employeeId: existing._id });
        await audit({ ...ctx, actor }, 'employee.update', { employeeId: existing._id, role, active, pinChanged: !!input.pin });
        return publicEmployee(await coll.findOne({ _id: existing._id }));
      }
      if (!set.pinLookup) throw bad('REQUIRED', 'pin');
      const doc = { _id: newId(), ...set, createdAt: now() };
      await coll.insertOne(doc);
      await audit({ ...ctx, actor }, 'employee.create', { employeeId: doc._id, role });
      return publicEmployee(doc);
    } catch (e) {
      if (isDup(e)) throw conflict('PIN_IN_USE');
      throw e;
    }
  }

  return { isSetUp, setup, login, resolve, logout, listEmployees, saveEmployee, verifyPin };
}

export function publicEmployee(emp) {
  const o = out(emp, ['pinLookup']);
  return { ...o, roleName: ROLES[emp.role], permissions: permissionsOf(emp.role) };
}

export const settingsKeys = ['name', 'address', 'phone', 'reportPhone', 'tax', 'loyalty', 'paymentTypes', 'diningOptions', 'features', 'receipt', 'cashVarianceAlert', 'qrWifi'];

export function createSettings(ctx) {
  const { db, now } = ctx;

  async function get(actor, { full = false } = {}) {
    if (!actor) throw new AppError(401, 'NOT_AUTHENTICATED');
    const s = await getSettings(db);
    const o = out(s, ['secret']);
    if (!full) delete o.createdAt;
    return o;
  }

  async function update(actor, input = {}) {
    requirePerm(actor, 'admin.settings');
    const set = { updatedAt: now() };
    if ('name' in input) set.name = str(input.name, { field: 'name', min: 2, max: 60 });
    if ('address' in input) set.address = str(input.address, { field: 'address', max: 120 });
    if ('phone' in input) set.phone = str(input.phone, { field: 'phone', max: 30 });
    if ('qrWifi' in input) set.qrWifi = str(input.qrWifi, { field: 'qrWifi', max: 40, optional: true });
    if ('reportPhone' in input) {
      // رقم واتساب لاستلام تقرير الوردية: يُخزَّن بصيغة دولية بأرقام فقط (07… العراقية → 9647…)
      let d = normalizePin(String(input.reportPhone ?? '')).replace(/\D/g, '');
      if (d.startsWith('00')) d = d.slice(2);
      if (/^07\d{9}$/.test(d)) d = `964${d.slice(1)}`;
      if (d && !/^\d{8,15}$/.test(d)) throw bad('INVALID_PHONE', 'reportPhone');
      set.reportPhone = d;
    }
    if ('tax' in input) {
      const mode = oneOf(input.tax?.mode, ['none', 'added', 'included'], 'tax.mode');
      const rateBp = mode === 'none' ? 0 : input.tax.rateBp;
      if (!Number.isInteger(rateBp) || rateBp < 0 || rateBp > 5000) throw bad('INVALID_NUMBER', 'tax.rateBp');
      set.tax = { mode, rateBp, name: str(input.tax.name || 'ضريبة', { field: 'tax.name', max: 30 }) };
    }
    if ('loyalty' in input) {
      const rateBp = input.loyalty?.rateBp;
      if (!Number.isInteger(rateBp) || rateBp < 0 || rateBp > 5000) throw bad('INVALID_NUMBER', 'loyalty.rateBp');
      const cur = loyaltyOf(await getSettings(db));
      const L = input.loyalty;
      const tiers = L.tiers === undefined ? cur.tiers : (Array.isArray(L.tiers) && L.tiers.length <= 5 ? L.tiers : (() => { throw bad('INVALID_LIST', 'loyalty.tiers'); })()).map((t) => ({
        id: checkId(t.id, 'loyalty.tiers.id'), name: str(t.name, { field: 'loyalty.tiers.name', min: 1, max: 20 }),
        minSpent: int(t.minSpent, { field: 'loyalty.tiers.minSpent', min: 1, max: 1_000_000_000 }), bonusBp: int(t.bonusBp, { field: 'loyalty.tiers.bonusBp', min: 0, max: 20000 }),
      }));
      set.loyalty = {
        enabled: bool(L.enabled), rateBp, tiers,
        welcomePoints: L.welcomePoints === undefined ? cur.welcomePoints : int(L.welcomePoints, { field: 'loyalty.welcomePoints', min: 0, max: 1_000_000 }),
        awayDays: L.awayDays === undefined ? cur.awayDays : int(L.awayDays, { field: 'loyalty.awayDays', min: 7, max: 365 }),
      };
    }
    if ('paymentTypes' in input) {
      const list = input.paymentTypes;
      if (!Array.isArray(list) || list.length === 0 || list.length > 12) throw bad('INVALID_LIST', 'paymentTypes');
      set.paymentTypes = list.map((p) => ({
        id: checkId(p.id, 'paymentTypes.id'), name: str(p.name, { field: 'paymentTypes.name', min: 1, max: 24 }),
        kind: oneOf(p.kind, ['cash', 'card', 'other'], 'paymentTypes.kind'), active: p.active !== false,
      }));
      if (new Set(set.paymentTypes.map((p) => p.id)).size !== set.paymentTypes.length) throw bad('DUPLICATE_ID', 'paymentTypes');
      if (!set.paymentTypes.some((p) => p.kind === 'cash' && p.active)) throw bad('CASH_REQUIRED');
    }
    if ('diningOptions' in input) {
      const list = input.diningOptions;
      if (!Array.isArray(list) || list.length === 0 || list.length > 8) throw bad('INVALID_LIST', 'diningOptions');
      set.diningOptions = list.map((d) => ({ id: checkId(d.id, 'diningOptions.id'), name: str(d.name, { field: 'diningOptions.name', min: 1, max: 20 }) }));
    }
    if ('features' in input) set.features = { kds: bool(input.features?.kds), openTickets: bool(input.features?.openTickets), qr: bool(input.features?.qr) };
    if ('receipt' in input) {
      set.receipt = {
        header: str(input.receipt?.header, { field: 'receipt.header', max: 200 }),
        footer: str(input.receipt?.footer, { field: 'receipt.footer', max: 200 }),
        showCustomer: input.receipt?.showCustomer !== false,
      };
    }
    if ('cashVarianceAlert' in input) {
      if (!Number.isSafeInteger(input.cashVarianceAlert) || input.cashVarianceAlert < 0) throw bad('INVALID_NUMBER', 'cashVarianceAlert');
      set.cashVarianceAlert = input.cashVarianceAlert;
    }
    await db.collection('settings').updateOne({ _id: 'store' }, { $set: set });
    await audit({ ...ctx, actor }, 'settings.update', { keys: Object.keys(set).filter((k) => k !== 'updatedAt') });
    return get(actor);
  }

  return { get, update };
}
