// الاشتراكات اليدوية (تحويل أو نقد) وموافقة المزوّد على كل حساب.
//
// الحساب الجديد «بانتظار الموافقة» ولا يعمل فيه شيء إلا صفحة الاشتراك: يقرأ التفاصيل وبيانات التحويل (يتحكم بها المزوّد)،
// ويرسل طلباً (تحويل برقم ووصل، أو نقد). المزوّد يوافق بمدة (أشهر أو أيام، مدفوع أو مجاني) فينفتح البرنامج حتى تاريخ الانتهاء.
// بعد الانتهاء: القراءة (التقارير) مسموحة والكتابة (البيع…) موقوفة حتى التجديد. الفروع تتبع اشتراك حساب المالك.
import { AppError, bad, id as checkId, str } from './core.js';

const MAX_IMAGE = 600_000; // base64 لوصل التحويل (يصغّره المتصفح قبل الرفع)
const DEFAULT_CONFIG = {
  price: '',
  details: 'اشتراك شهري في مور كاش: البيع، المخزون، الموظفون والرواتب، والتقارير، مع الدعم.',
  methods: [],
  whatsapp: null,
};

/** إضافة أشهر تقويمية (31 كانون الثاني + شهر = آخر شباط) */
export function addMonths(date, months) {
  const d = new Date(date);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

export function createSubscriptions({ db, now, newId, admins = new Set(), enabled = false, onChange = () => {} }) {
  const REQ = () => db.collection('sub_requests');
  const AUDIT = () => db.collection('platform_audit');
  const CONFIG = () => db.collection('platform_config');

  /** حالة اشتراك الحساب: active | trial | expired | pending */
  function stateOf(acc) {
    if (!enabled || !acc || admins.has(acc.email)) return { status: 'active', until: null, free: false, daysLeft: null, unlimited: true };
    const s = acc.sub ?? {};
    const until = s.until ? new Date(s.until) : null;
    if (!until) return { status: 'pending', until: null, free: false, daysLeft: null };
    const ms = until.getTime() - now().getTime();
    if (ms <= 0) return { status: 'expired', until, free: !!s.free, daysLeft: 0 };
    return { status: s.free ? 'trial' : 'active', until, free: !!s.free, daysLeft: Math.ceil(ms / 86400_000) };
  }
  const isOpen = (st) => st.status === 'active' || st.status === 'trial';

  // حالة الحساب تُخزَّن 20 ثانية لكل جهاز لتقليل القراءات؛ تُمسح فوراً عند أي تغيير من المزوّد
  const cache = new Map();
  async function stateForAccount(accountId) {
    const c = cache.get(accountId);
    const t = now().getTime();
    if (c && t - c.at >= 0 && t - c.at < 20_000) return c.state;
    const acc = await db.collection('accounts').findOne({ _id: accountId }, { projection: { email: 1, sub: 1 } });
    const state = stateOf(acc);
    cache.set(accountId, { state, at: t });
    if (cache.size > 5000) cache.clear();
    return state;
  }
  const forget = (accountId) => { cache.delete(accountId); onChange(accountId); };

  /**
   * بوابة كل طلب لمقهى: بانتظار الموافقة = لا شيء غير صفحة الاشتراك؛ منتهٍ = قراءة ودخول الموظف فقط.
   * يُستدعى بعد التأكد من ربط الجهاز.
   */
  async function gate(device, req) {
    if (!enabled) return;
    const st = await stateForAccount(device.accountId);
    if (isOpen(st)) return;
    const key = `${req.method} ${req.path}`;
    if (req.path.startsWith('/api/subscription')) return;
    if (key === 'POST /api/auth/logout') return;
    if (st.status === 'expired' && (req.method === 'GET' || key === 'POST /api/auth/pin')) return;
    throw new AppError(402, st.status === 'expired' ? 'SUBSCRIPTION_EXPIRED' : 'SUBSCRIPTION_PENDING');
  }

  async function config() {
    const c = await CONFIG().findOne({ _id: 'main' });
    return { ...DEFAULT_CONFIG, ...(c ?? {}), _id: undefined };
  }

  const publicRequest = (r) => ({ id: r._id, method: r.method, reference: r.reference ?? null, note: r.note ?? null, phone: r.phone ?? null, hasImage: !!r.image,
    status: r.status, createdAt: r.createdAt, decidedAt: r.decidedAt ?? null, decisionNote: r.decisionNote ?? null, months: r.months ?? null, days: r.days ?? null, free: !!r.free, manual: !!r.manual });

  // ---------------------------------------------------------------- جهة العميل
  async function clientInfo(device) {
    const acc = await db.collection('accounts').findOne({ _id: device.accountId });
    const st = stateOf(acc);
    const requests = (await REQ().find({ accountId: device.accountId }).sort({ createdAt: -1 }).limit(5).toArray()).map(publicRequest);
    return { ...st, enabled, config: await config(), requests };
  }

  async function submitRequest(device, body = {}, shop) {
    if (!enabled) throw new AppError(404, 'NOT_FOUND');
    const acc = await db.collection('accounts').findOne({ _id: device.accountId });
    if (!acc) throw new AppError(401, 'NO_SHOP');
    const method = body.method === 'cash' ? 'cash' : body.method === 'transfer' ? 'transfer' : null;
    if (!method) throw bad('INVALID_CHOICE', 'method');
    const phone = str(body.phone, { field: 'phone', min: 7, max: 20 });
    if (!/^[0-9+\- ]{7,20}$/.test(phone)) throw bad('INVALID_PHONE');
    const reference = str(body.reference, { field: 'reference', max: 60, optional: true });
    const note = str(body.note, { field: 'note', max: 300, optional: true });
    let image = null;
    let mediaType = null;
    if (body.image) {
      if (typeof body.image !== 'string' || body.image.length > MAX_IMAGE || !/^[A-Za-z0-9+/=]+$/.test(body.image)) throw bad('IMAGE_TOO_LARGE');
      mediaType = ['image/jpeg', 'image/png', 'image/webp'].includes(body.mediaType) ? body.mediaType : 'image/jpeg';
      image = body.image;
    }
    if (method === 'transfer' && !reference && !image) throw bad('REQUIRED', 'reference');
    const doc = {
      accountId: acc._id, tenantId: acc.tenantId, email: acc.email, ownerName: acc.name, shopName: shop?.name ?? null,
      method, phone: phone.replace(/[\s-]/g, ''), reference, note, image, mediaType, status: 'pending', createdAt: now(),
    };
    // طلب معلّق واحد لكل حساب: الإرسال من جديد يحدّثه بدل تكرار الطلبات عند المزوّد
    const prev = await REQ().findOne({ accountId: acc._id, status: 'pending' });
    if (prev) await REQ().updateOne({ _id: prev._id }, { $set: { ...doc, createdAt: prev.createdAt, updatedAt: now() } });
    else await REQ().insertOne({ _id: newId(), ...doc });
    return clientInfo(device);
  }

  // ---------------------------------------------------------------- جهة المزوّد
  async function audit(admin, action, data = {}) {
    await AUDIT().insertOne({ _id: newId(), at: now(), admin: admin.email, action, ...data });
  }

  /** تفعيل أو تمديد اشتراك حساب: من نهاية الاشتراك الحالي إن لم ينتهِ، وإلا من اليوم */
  async function extend(acc, { months = 0, days = 0, free = false }) {
    const m = Number.isSafeInteger(months) ? months : 0;
    const d = Number.isSafeInteger(days) ? days : 0;
    if (m < 0 || m > 24 || d < 0 || d > 366 || (!m && !d)) throw bad('INVALID_RANGE', 'duration');
    const current = acc.sub?.until ? new Date(acc.sub.until) : null;
    const base = current && current > now() ? current : now();
    const until = new Date(addMonths(base, m).getTime() + d * 86400_000);
    await db.collection('accounts').updateOne({ _id: acc._id }, { $set: { sub: { until, free: !!free, since: acc.sub?.since ?? now(), updatedAt: now() } } });
    forget(acc._id);
    return until;
  }

  async function accountOfTenant(tenantId) {
    const id = checkId(tenantId);
    return (await db.collection('accounts').findOne({ tenantId: id })) ?? (await db.collection('accounts').findOne({ branches: id }));
  }

  async function listRequests({ status = 'pending' } = {}) {
    const q = status === 'all' ? {} : { status: status === 'decided' ? { $ne: 'pending' } : 'pending' };
    const rows = await REQ().find(q).sort({ createdAt: -1 }).limit(200).project({ image: 0 }).toArray();
    return rows.map((r) => ({ ...publicRequest(r), hasImage: !!r.mediaType, tenantId: r.tenantId, email: r.email, ownerName: r.ownerName, shopName: r.shopName, decidedBy: r.decidedBy ?? null }));
  }

  async function requestImage(id) {
    const r = await REQ().findOne({ _id: checkId(id) });
    if (!r?.image) throw new AppError(404, 'NOT_FOUND');
    return { image: r.image, mediaType: r.mediaType ?? 'image/jpeg' };
  }

  async function decide(admin, id, body = {}, approve) {
    const r = await REQ().findOne({ _id: checkId(id) });
    if (!r) throw new AppError(404, 'NOT_FOUND');
    if (r.status !== 'pending') throw new AppError(409, 'ALREADY_DECIDED');
    const decisionNote = str(body.note, { field: 'note', max: 200, optional: true });
    const acc = await db.collection('accounts').findOne({ _id: r.accountId });
    if (!acc) throw new AppError(404, 'NOT_FOUND');
    let until = null;
    if (approve) until = await extend(acc, { months: body.months, days: body.days, free: body.free === true });
    else if (!decisionNote) throw bad('REQUIRED', 'note');
    await REQ().updateOne({ _id: r._id, status: 'pending' }, { $set: {
      status: approve ? 'approved' : 'rejected', decidedAt: now(), decidedBy: admin.email, decisionNote,
      ...(approve ? { months: body.months ?? 0, days: body.days ?? 0, free: body.free === true, until } : {}),
    } });
    await audit(admin, approve ? 'request.approve' : 'request.reject', { tenantId: r.tenantId, shopName: r.shopName, method: r.method, until, note: decisionNote });
    return { ok: true, until };
  }

  /** من صف العميل مباشرة: تفعيل/تمديد (يُسجَّل طلباً يدوياً للتاريخ)، أو إيقاف الاشتراك الآن */
  async function setForTenant(admin, tenantId, body = {}) {
    const acc = await accountOfTenant(tenantId);
    if (!acc) throw new AppError(404, 'NOT_FOUND');
    const note = str(body.note, { field: 'note', max: 200, optional: true });
    if (body.action === 'stop') {
      await db.collection('accounts').updateOne({ _id: acc._id }, { $set: { 'sub.until': now(), 'sub.updatedAt': now() } });
      forget(acc._id);
      await audit(admin, 'subscription.stop', { tenantId: acc.tenantId, note });
      return { ok: true, until: now() };
    }
    const method = ['cash', 'transfer', 'free'].includes(body.method) ? body.method : 'free';
    const until = await extend(acc, { months: body.months, days: body.days, free: method === 'free' });
    const shop = await db.collection('tenants').findOne({ _id: acc.tenantId });
    await REQ().insertOne({ _id: newId(), accountId: acc._id, tenantId: acc.tenantId, email: acc.email, ownerName: acc.name, shopName: shop?.name ?? null,
      method, phone: null, reference: null, note, status: 'approved', manual: true, createdAt: now(), decidedAt: now(), decidedBy: admin.email,
      months: body.months ?? 0, days: body.days ?? 0, free: method === 'free', until });
    await audit(admin, 'subscription.extend', { tenantId: acc.tenantId, shopName: shop?.name ?? null, method, months: body.months ?? 0, days: body.days ?? 0, until, note });
    return { ok: true, until };
  }

  async function saveConfig(admin, body = {}) {
    const methods = Array.isArray(body.methods) ? body.methods.slice(0, 8).map((m) => ({
      label: str(m?.label, { field: 'methods.label', min: 1, max: 40 }), value: str(m?.value, { field: 'methods.value', min: 1, max: 80 }),
      holder: str(m?.holder, { field: 'methods.holder', max: 60, optional: true }),
    })) : [];
    const whatsapp = body.whatsapp ? str(body.whatsapp, { field: 'whatsapp', max: 20 }).replace(/\D/g, '') : null;
    const c = { price: str(body.price, { field: 'price', max: 80, optional: true }) ?? '', details: str(body.details, { field: 'details', max: 1200, optional: true }) ?? '', methods, whatsapp, updatedAt: now(), updatedBy: admin.email };
    await CONFIG().updateOne({ _id: 'main' }, { $set: c }, { upsert: true });
    await audit(admin, 'config.update', { methods: methods.length });
    return config();
  }

  async function auditLog({ limit = 200 } = {}) {
    return (await AUDIT().find({}).sort({ at: -1 }).limit(Math.min(Number(limit) || 200, 500)).toArray()).map(({ _id, ...x }) => x);
  }

  return { enabled, stateOf, stateForAccount, gate, clientInfo, submitRequest, config, listRequests, requestImage, decide, setForTenant, saveConfig, auditLog, audit, forget };
}
