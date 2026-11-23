// لوحة مزوّد الخدمة (أنت): ترى كل المقاهي ونشاطها، توقف حساباً أو تفعّله، وتنشئ كلمة مرور مؤقتة لصاحب مقهى نسيها.
// الدخول: بريد وكلمة مرور حساب مقهى موجود، بشرط أن يكون البريد ضمن PLATFORM_ADMINS (متغير بيئة).
// هذه الطبقة الوحيدة التي تقرأ بيانات كل المقاهي معاً — للقراءة الإجمالية فقط، ولا تمسّ بيانات البيع.
import { AppError, bad, id as checkId, str } from './core.js';
import { hashPassword, randomToken, sha256, verifyPassword } from './security.js';

const SESSION_HOURS = 4;
const DUMMY_HASH = 'pbkdf2$210000$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000';

export function createPlatformAdmin({ db, now, newId = () => crypto.randomUUID(), admins = [], passwordIterations, checkIp, failIp, onTenantChange = () => {}, log = console, subs = null }) {
  const allowed = new Set(admins.map((e) => String(e).trim().toLowerCase()).filter(Boolean));
  const sessions = () => db.collection('platform_sessions');
  const hashOpts = passwordIterations ? { iterations: passwordIterations } : undefined;

  async function login(body = {}, ip) {
    checkIp(ip);
    const mail = String(body.email ?? '').trim().toLowerCase().replace(/\s/g, '');
    const pass = typeof body.password === 'string' ? body.password.slice(0, 128) : '';
    const acc = allowed.has(mail) ? await db.collection('accounts').findOne({ email: mail }) : null;
    // نفس زمن الاستجابة سواء كان البريد مسموحاً أم لا
    const okPass = await verifyPassword(pass, acc?.passwordHash ?? DUMMY_HASH);
    if (!acc || !okPass) { failIp(ip); throw new AppError(401, 'BAD_CREDENTIALS'); }
    const token = randomToken(32);
    await sessions().insertOne({ _id: await sha256(token), email: mail, createdAt: now(), expiresAt: new Date(now().getTime() + SESSION_HOURS * 3600_000) });
    log.warn?.(`platform login: ${mail}`);
    return { status: 200, body: { email: mail }, setPlatform: token };
  }

  async function resolve(token) {
    if (typeof token !== 'string' || token.length !== 64) return null;
    const s = await sessions().findOne({ _id: await sha256(token) });
    if (!s || s.expiresAt <= now() || !allowed.has(s.email)) return null;
    return s;
  }

  async function shops({ search = '' } = {}) {
    const tenants = await db.collection('tenants').find({}).sort({ createdAt: -1 }).limit(2000).toArray();
    const accounts = await db.collection('accounts').find({}).project({ email: 1, name: 1, tenantId: 1, branches: 1, lastLoginAt: 1, sub: 1, createdAt: 1 }).limit(5000).toArray();
    const pendingReq = new Set((await db.collection('sub_requests').find({ status: 'pending' }).project({ tenantId: 1 }).toArray()).map((r) => r.tenantId));
    // الفروع: كل فرع مقهى مستقل يعود لنفس حساب المالك
    const byTenant = new Map();
    for (const a of accounts) for (const t of [a.tenantId, ...(a.branches ?? [])]) byTenant.set(t, a);
    const since = new Date(now().getTime() - 30 * 86400_000);
    const q = String(search).trim().toLowerCase();
    const rows = [];
    for (const t of tenants) {
      const acc = byTenant.get(t._id);
      if (q && !`${t.name} ${acc?.email ?? ''} ${acc?.name ?? ''}`.toLowerCase().includes(q)) continue;
      const [last, sales30, devices] = await Promise.all([
        db.collection('receipts').find({ tenantId: t._id, type: 'sale' }).sort({ createdAt: -1 }).limit(1).project({ createdAt: 1 }).toArray(),
        db.collection('receipts').countDocuments({ tenantId: t._id, type: 'sale', createdAt: { $gte: since } }),
        db.collection('devices').countDocuments({ tenantId: t._id }),
      ]);
      rows.push({
        id: t._id, name: t.name, ownerName: acc?.name ?? null, email: acc?.email ?? null, createdAt: t.createdAt,
        lastLoginAt: acc?.lastLoginAt ?? null, lastSaleAt: last[0]?.createdAt ?? null, sales30, devices,
        disabled: !!t.disabled, disabledReason: t.disabledReason ?? null, branchOf: t.branchOf ?? null,
        subscription: subs ? subs.stateOf(acc) : null, pendingRequest: pendingReq.has(t._id),
      });
    }
    const weekAgo = now().getTime() - 7 * 86400_000;
    return {
      rows,
      totals: { shops: rows.length, active7: rows.filter((r) => r.lastSaleAt && new Date(r.lastSaleAt).getTime() >= weekAgo).length, disabled: rows.filter((r) => r.disabled).length,
        pending: rows.filter((r) => r.subscription?.status === 'pending' && !r.branchOf).length, expired: rows.filter((r) => r.subscription?.status === 'expired' && !r.branchOf).length,
        paying: rows.filter((r) => r.subscription?.status === 'active' && !r.subscription.unlimited && !r.branchOf).length, trial: rows.filter((r) => r.subscription?.status === 'trial' && !r.branchOf).length,
        requests: pendingReq.size, approval: !!subs?.enabled },
    };
  }

  async function setDisabled(tenantId, disabled, reason, admin) {
    const id = checkId(tenantId);
    const r = await db.collection('tenants').updateOne({ _id: id }, disabled
      ? { $set: { disabled: true, disabledReason: str(reason, { field: 'reason', max: 120, optional: true }), disabledAt: now(), disabledBy: admin.email } }
      : { $set: { disabled: false, disabledReason: null, enabledAt: now(), enabledBy: admin.email } });
    if (!r.matchedCount) throw new AppError(404, 'NOT_FOUND');
    onTenantChange(id);
    return { ok: true };
  }

  /** كلمة مرور مؤقتة تُعطى لصاحب المقهى؛ تُسجّل خروج كل أجهزته، ويُطلب منه تغييرها */
  async function resetPassword(tenantId, admin) {
    const id = checkId(tenantId);
    const acc = await db.collection('accounts').findOne({ tenantId: id }) ?? await db.collection('accounts').findOne({ branches: id });
    if (!acc) throw new AppError(404, 'NOT_FOUND');
    // سهلة القراءة على الهاتف: بلا حروف ملتبسة (0/O، 1/l)
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(10));
    const temp = [...bytes].map((b) => alphabet[b % alphabet.length]).join('').replace(/(.{5})/, '$1-');
    await db.collection('accounts').updateOne({ _id: acc._id }, { $set: {
      passwordHash: await hashPassword(temp, hashOpts), mustChangePassword: true, failedLogins: 0, lockedUntil: null, passwordResetAt: now(), passwordResetBy: admin.email,
    } });
    await db.collection('devices').deleteMany({ accountId: acc._id });
    return { email: acc.email, tempPassword: temp };
  }

  /** نسخة احتياطية كاملة لمقهى (وفروعه) بصيغة JSON، بلا أسرار: لا كلمات مرور ولا رموز ولا جلسات */
  const BACKUP = ['settings', 'employees', 'categories', 'items', 'variants', 'modifiers', 'discounts', 'customers', 'receipts', 'shifts', 'tickets', 'stock_moves',
    'expenses', 'attendance', 'hr_adjustments', 'leaves', 'hr_awards', 'hr_advances', 'payrolls', 'audit', 'point_moves', 'item_images', 'counters'];
  async function backup(tenantId, admin) {
    const id = checkId(tenantId);
    const t = await db.collection('tenants').findOne({ _id: id });
    if (!t) throw new AppError(404, 'NOT_FOUND');
    const data = {};
    for (const name of BACKUP) {
      const rows = await db.collection(name).find({ tenantId: id }).toArray();
      data[name] = rows.map((r) => {
        const { pinLookup, secret, ...rest } = r; // أسرار الدخول لا تخرج في النسخة
        return rest;
      });
    }
    if (subs) await subs.audit(admin, 'backup.download', { tenantId: id, shopName: t.name });
    return { format: 'morecash-backup', version: 1, exportedAt: now(), tenant: { id: t._id, name: t.name, createdAt: t.createdAt }, data };
  }

  async function handle(req) {
    const key = `${req.method} ${req.path}`;
    if (key === 'POST /api/platform/login') {
      if (!allowed.size) throw new AppError(404, 'NOT_FOUND');
      return login(req.body, req.ip);
    }
    if (key === 'POST /api/platform/logout') {
      if (req.platformToken) await sessions().deleteOne({ _id: await sha256(req.platformToken) }).catch(() => {});
      return { status: 200, body: { ok: true }, setPlatform: null };
    }
    const admin = await resolve(req.platformToken);
    if (key === 'GET /api/platform/me') return { status: 200, body: { email: admin?.email ?? null, enabled: allowed.size > 0 } };
    if (!admin) throw new AppError(401, 'PLATFORM_AUTH');
    if (key === 'GET /api/platform/shops') return { status: 200, body: await shops(req.query ?? {}) };
    if (key === 'GET /api/platform/errors') {
      const since = new Date(now().getTime() - 86400_000);
      const recent = await db.collection('platform_errors').find({}).sort({ at: -1 }).limit(30).toArray();
      return { status: 200, body: { count24h: await db.collection('platform_errors').countDocuments({ at: { $gte: since } }), recent: recent.map(({ _id, ...x }) => x) } };
    }
    // الاشتراكات: الطلبات، الموافقة/الرفض، التمديد من صف العميل، بيانات التحويل والتفاصيل، والسجل
    if (subs) {
      if (key === 'GET /api/platform/requests') return { status: 200, body: await subs.listRequests(req.query ?? {}) };
      if (key === 'GET /api/platform/config') return { status: 200, body: await subs.config() };
      if (key === 'PUT /api/platform/config') return { status: 200, body: await subs.saveConfig(admin, req.body) };
      if (key === 'GET /api/platform/audit') return { status: 200, body: await subs.auditLog(req.query ?? {}) };
      const rq = /^\/api\/platform\/requests\/([A-Za-z0-9_-]{1,64})\/(image|approve|reject)$/.exec(req.path);
      if (rq && rq[2] === 'image' && req.method === 'GET') return { status: 200, body: await subs.requestImage(rq[1]) };
      if (rq && req.method === 'POST') return { status: 200, body: await subs.decide(admin, rq[1], req.body, rq[2] === 'approve') };
      const sb = /^\/api\/platform\/shops\/([A-Za-z0-9_-]{1,64})\/subscription$/.exec(req.path);
      if (sb && req.method === 'POST') return { status: 200, body: await subs.setForTenant(admin, sb[1], req.body) };
    }
    const bk = /^\/api\/platform\/shops\/([A-Za-z0-9_-]{1,64})\/backup$/.exec(req.path);
    if (bk && req.method === 'GET') return { status: 200, body: await backup(bk[1], admin) };
    const m = /^\/api\/platform\/shops\/([A-Za-z0-9_-]{1,64})\/(disable|enable|reset-password)$/.exec(req.path);
    if (m && req.method === 'POST') {
      if (m[2] === 'reset-password') {
        const r = await resetPassword(m[1], admin);
        if (subs) await subs.audit(admin, 'account.reset_password', { tenantId: m[1] });
        return { status: 200, body: r };
      }
      if (m[2] === 'disable' && !String(req.body?.reason ?? '').trim()) throw bad('REQUIRED', 'reason');
      const r = await setDisabled(m[1], m[2] === 'disable', req.body?.reason, admin);
      if (subs) await subs.audit(admin, m[2] === 'disable' ? 'shop.disable' : 'shop.enable', { tenantId: m[1], note: req.body?.reason ?? null });
      return { status: 200, body: r };
    }
    throw new AppError(404, 'NOT_FOUND');
  }

  return { handle };
}
