// المنصة: حسابات المقاهي، ربط الجهاز بمقهى، وتوجيه كل طلب إلى تطبيق ذلك المقهى فقط.
//
// طبقتا دخول:
//   1) حساب المقهى (بريد + كلمة مرور) — مرة واحدة على كل جهاز. ينشئ "جلسة جهاز" طويلة (كوكي mc_device).
//   2) رمز الموظف (PIN) — سريع، لكل وردية/موظف، داخل المقهى المرتبط بالجهاز فقط (كوكي mc_session).
// لذلك لا يمكن تجربة رموز PIN إلا من جهاز سجّل صاحبه الدخول بكلمة المرور.
import { createApp } from './index.js';
import { AppError, bad, conflict, isDup, str } from './core.js';
import { hashPassword, randomToken, sha256, validPin, verifyPassword } from './security.js';
import { scopeDb } from '../db/scoped.js';

const DEVICE_DAYS = 90;
const MAX_FAILS = 5;
const LOCK_MS = 5 * 60_000;
const IP_WINDOW_MS = 10 * 60_000;
const IP_MAX = 20;
const MAX_CACHED_APPS = 300;
const DUMMY_HASH = 'pbkdf2$210000$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000';

export function createPlatform({ db, now = () => new Date(), newId = () => crypto.randomUUID(), pepper = null, log = console, passwordIterations } = {}) {
  const apps = new Map(); // tenantId → {app, ready}
  const ipFails = new Map(); // ip → {count, since}

  function tenantApp(tenantId) {
    let entry = apps.get(tenantId);
    if (entry) {
      apps.delete(tenantId); apps.set(tenantId, entry); // الأحدث استخداماً في النهاية
      return entry;
    }
    const app = createApp({ db: scopeDb(db, tenantId), now, newId, pepper, log });
    entry = { app, ready: app.start().catch((e) => log.error?.(e)) };
    apps.set(tenantId, entry);
    if (apps.size > MAX_CACHED_APPS) apps.delete(apps.keys().next().value);
    return entry;
  }

  async function appFor(tenantId) {
    const entry = tenantApp(tenantId);
    await entry.ready;
    return entry.app;
  }

  // ---------------------------------------------------------------- تحقق
  function email(v) {
    const e = str(v, { field: 'email', min: 5, max: 120 }).toLowerCase().replace(/\s/g, '');
    if (!/^[^@]+@[^@]+\.[a-z]{2,}$/i.test(e)) throw bad('INVALID_EMAIL');
    return e;
  }
  function password(v) {
    if (typeof v !== 'string' || v.length < 8 || v.length > 128) throw bad('WEAK_PASSWORD');
    if (/^\d+$/.test(v) || new Set(v).size < 4) throw bad('WEAK_PASSWORD');
    return v;
  }

  function checkIp(ip) {
    const f = ipFails.get(ip);
    if (f && Date.now() - f.since < IP_WINDOW_MS && f.count >= IP_MAX) throw new AppError(429, 'TOO_MANY_ATTEMPTS');
  }
  function failIp(ip) {
    const f = ipFails.get(ip);
    if (!f || Date.now() - f.since >= IP_WINDOW_MS) ipFails.set(ip, { count: 1, since: Date.now() });
    else f.count += 1;
    if (ipFails.size > 5000) ipFails.clear();
  }

  // ---------------------------------------------------------------- الأجهزة
  async function createDevice(account) {
    const token = randomToken(32);
    await db.collection('devices').insertOne({
      _id: await sha256(token), tenantId: account.tenantId, accountId: account._id,
      createdAt: now(), expiresAt: new Date(now().getTime() + DEVICE_DAYS * 86400_000),
    });
    return token;
  }

  async function resolveDevice(token) {
    if (typeof token !== 'string' || token.length !== 64) return null;
    const d = await db.collection('devices').findOne({ _id: await sha256(token) });
    if (!d || d.expiresAt <= now()) return null;
    return d;
  }

  async function shopInfo(tenantId) {
    const t = await db.collection('tenants').findOne({ _id: tenantId });
    if (!t) return null;
    const s = await db.collection('settings').findOne({ _id: `${tenantId}:store` }, { projection: { name: 1 } });
    return { id: t._id, name: s?.name ?? t.name };
  }

  // ---------------------------------------------------------------- الحساب
  async function signup(body = {}, ip) {
    checkIp(ip);
    const shopName = str(body.shopName, { field: 'shopName', min: 2, max: 60 });
    const ownerName = str(body.ownerName, { field: 'ownerName', min: 2, max: 40 });
    const mail = email(body.email);
    const pass = password(body.password);
    if (!validPin(body.pin)) throw bad('WEAK_PIN');

    const tenantId = newId();
    const account = {
      _id: newId(), email: mail, name: ownerName, tenantId, role: 'owner',
      passwordHash: await hashPassword(pass, passwordIterations ? { iterations: passwordIterations } : undefined),
      failedLogins: 0, lockedUntil: null, createdAt: now(),
    };
    try {
      await db.collection('accounts').insertOne(account);
    } catch (e) {
      if (isDup(e)) { failIp(ip); throw conflict('EMAIL_IN_USE'); }
      throw e;
    }
    try {
      await db.collection('tenants').insertOne({ _id: tenantId, name: shopName, ownerAccountId: account._id, createdAt: now() });
      const app = await appFor(tenantId);
      await app.ctx.services.auth.setup({ storeName: shopName, ownerName, pin: body.pin, seed: body.seed !== false });
      const staff = await app.ctx.services.auth.login({ pin: body.pin }, ip);
      const device = await createDevice(account);
      return { status: 200, body: { shop: { id: tenantId, name: shopName }, employee: staff.employee }, setDevice: device, setToken: staff.token };
    } catch (e) {
      // لا نترك حساباً بلا مقهى
      await db.collection('accounts').deleteOne({ _id: account._id }).catch(() => {});
      await db.collection('tenants').deleteOne({ _id: tenantId }).catch(() => {});
      apps.delete(tenantId);
      throw e;
    }
  }

  async function login(body = {}, ip) {
    checkIp(ip);
    let mail;
    try { mail = email(body.email); } catch { failIp(ip); throw new AppError(401, 'BAD_CREDENTIALS'); }
    const pass = typeof body.password === 'string' ? body.password.slice(0, 128) : '';
    const acc = await db.collection('accounts').findOne({ email: mail });
    if (!acc) {
      await verifyPassword(pass, DUMMY_HASH); // زمن استجابة مماثل: لا يكشف وجود البريد
      failIp(ip);
      throw new AppError(401, 'BAD_CREDENTIALS');
    }
    if (acc.lockedUntil && acc.lockedUntil > now()) {
      throw new AppError(429, 'ACCOUNT_LOCKED', String(Math.ceil((acc.lockedUntil - now()) / 60000)));
    }
    if (!(await verifyPassword(pass, acc.passwordHash))) {
      failIp(ip);
      const fails = (acc.failedLogins ?? 0) + 1;
      const lock = fails >= MAX_FAILS;
      await db.collection('accounts').updateOne({ _id: acc._id }, { $set: {
        failedLogins: lock ? 0 : fails, lockedUntil: lock ? new Date(now().getTime() + LOCK_MS) : acc.lockedUntil ?? null,
      } });
      throw new AppError(401, 'BAD_CREDENTIALS');
    }
    await db.collection('accounts').updateOne({ _id: acc._id }, { $set: { failedLogins: 0, lockedUntil: null, lastLoginAt: now() } });
    const device = await createDevice(acc);
    return { status: 200, body: { shop: await shopInfo(acc.tenantId) }, setDevice: device, setToken: null };
  }

  async function changePassword(device, actor, body = {}) {
    if (!actor || actor.role !== 'owner') throw new AppError(403, 'FORBIDDEN', 'account.password');
    const acc = await db.collection('accounts').findOne({ _id: device.accountId });
    if (!acc || !(await verifyPassword(String(body.current ?? ''), acc.passwordHash))) throw new AppError(400, 'WRONG_PASSWORD');
    const next = password(body.next);
    await db.collection('accounts').updateOne({ _id: acc._id }, { $set: {
      passwordHash: await hashPassword(next, passwordIterations ? { iterations: passwordIterations } : undefined), passwordChangedAt: now(),
    } });
    // تسجيل خروج كل الأجهزة الأخرى
    await db.collection('devices').deleteMany({ accountId: acc._id, _id: { $ne: device._id } });
    return { status: 200, body: { ok: true } };
  }

  // ---------------------------------------------------------------- التوجيه
  /**
   * @param {{method, path, query?, body?, token?, deviceToken?, ip?}} req
   * @returns {Promise<{status, body, setToken?, setDevice?}>}
   */
  async function handle(req) {
    const ip = req.ip ?? 'local';
    const key = `${req.method} ${req.path}`;
    try {
      if (key === 'POST /api/account/signup') return await signup(req.body, ip);
      if (key === 'POST /api/account/login') return await login(req.body, ip);

      const device = await resolveDevice(req.deviceToken);

      if (key === 'POST /api/account/logout') {
        if (device) {
          await db.collection('devices').deleteOne({ _id: device._id });
          if (req.token) await (await appFor(device.tenantId)).handle({ ...req, method: 'POST', path: '/api/auth/logout' });
        }
        return { status: 200, body: { ok: true }, setDevice: null, setToken: null };
      }

      if (key === 'GET /api/state') {
        const shop = device ? await shopInfo(device.tenantId) : null;
        if (!shop) return { status: 200, body: { shop: null, employee: null }, ...(req.deviceToken ? { setDevice: null } : {}) };
        const r = await (await appFor(device.tenantId)).handle(req);
        return { ...r, body: { shop, employee: r.body?.employee ?? null } };
      }

      if (!device) return { status: 401, body: { error: 'NO_SHOP' }, ...(req.deviceToken ? { setDevice: null } : {}) };
      const app = await appFor(device.tenantId);

      if (key === 'POST /api/account/password') {
        const actor = await app.ctx.services.auth.resolve(req.token);
        return await changePassword(device, actor, req.body);
      }
      if (key === 'GET /api/account') {
        const actor = await app.ctx.services.auth.resolve(req.token);
        if (!actor || actor.role !== 'owner') throw new AppError(403, 'FORBIDDEN', 'account.view');
        const acc = await db.collection('accounts').findOne({ _id: device.accountId }, { projection: { email: 1, name: 1, createdAt: 1 } });
        return { status: 200, body: { email: acc?.email ?? null, name: acc?.name ?? null } };
      }
      if (req.path === '/api/setup') return { status: 404, body: { error: 'NOT_FOUND' } };
      return await app.handle(req);
    } catch (e) {
      if (e instanceof AppError) return { status: e.status, body: { error: e.code, detail: e.detail } };
      log.error?.(e);
      return { status: 500, body: { error: 'INTERNAL' } };
    }
  }

  return { handle, appFor };
}
