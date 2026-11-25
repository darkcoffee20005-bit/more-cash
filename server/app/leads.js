// طلبات «احجز عرضك المجاني» من الموقع التعريفي، ومحتوى الموقع الذي يتحكم به المزوّد (من يثق بمور كاش، وآراء العملاء).
// الطلبات على مستوى المنصة (بلا مقهى): يقرأها المزوّد من لوحته ويتابعها (جديد ← تواصلنا ← اشترك/لم يكمل).
import { AppError, bad, id as checkId, int, isDup, oneOf, str } from './core.js';

export const LEAD_TYPES = { cafe: 'كافيه / كوفي شوب', restaurant: 'مطعم', quick: 'خدمة سريعة', bakery: 'مخبز / حلويات', other: 'غير ذلك' };
export const LEAD_STATUS = ['new', 'contacted', 'won', 'lost'];
const PER_IP = 5; // طلبات لكل عنوان في الساعة
const WINDOW = 3600_000;

const latin = (v) => String(v ?? '').replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0));

/** رقم عراقي أو دولي: 07xxxxxxxxx أو 9647xxxxxxxxx أو +… — يُحفظ أرقاماً فقط */
export function normPhone(v) {
  const d = latin(v).replace(/[^\d+]/g, '').replace(/^\+/, '').replace(/^00/, '');
  if (!/^\d{8,15}$/.test(d)) throw bad('INVALID_PHONE', 'phone');
  return d;
}

export function createLeads({ db, now, audit = async () => {} }) {
  const LEADS = () => db.collection('leads');
  const CONFIG = () => db.collection('platform_config');
  const hits = new Map(); // ip → {count, since}

  function limit(ip) {
    const t = Date.now();
    const h = hits.get(ip);
    if (!h || t - h.since >= WINDOW) { hits.set(ip, { count: 1, since: t }); if (hits.size > 5000) hits.clear(); return; }
    if (h.count >= PER_IP) throw new AppError(429, 'TOO_MANY_ATTEMPTS');
    h.count += 1;
  }

  /** طلب عرض من الزائر: معرّف العميل يجعل إعادة الإرسال آمنة، وحقل «الموقع» المخفي فخ للروبوتات */
  async function submit(body = {}, ip) {
    const clientId = checkId(body.clientId, 'clientId');
    if (body.website) return { ok: true }; // روبوت: نقبل بصمت ولا نحفظ
    const lead = {
      _id: clientId,
      name: str(body.name, { field: 'name', min: 2, max: 60 }),
      shop: str(body.shop, { field: 'shop', min: 2, max: 80 }),
      type: oneOf(body.type ?? 'cafe', Object.keys(LEAD_TYPES), 'type'),
      branches: int(body.branches ?? 1, { field: 'branches', min: 1, max: 500 }),
      phone: normPhone(body.phone),
      city: str(body.city, { field: 'city', max: 40, optional: true }),
      when: str(body.when, { field: 'when', max: 60, optional: true }),
      note: str(body.note, { field: 'note', max: 500, optional: true }),
      status: 'new', createdAt: now(), ip: ip ?? null,
    };
    if (await LEADS().findOne({ _id: clientId }, { projection: { _id: 1 } })) return { ok: true };
    limit(ip ?? 'unknown');
    try { await LEADS().insertOne(lead); } catch (e) { if (!isDup(e)) throw e; }
    return { ok: true };
  }

  const view = ({ ip, ...l }) => ({ ...l, id: l._id, _id: undefined, typeName: LEAD_TYPES[l.type] ?? l.type });

  async function list({ status } = {}) {
    const q = LEAD_STATUS.includes(status) ? { status } : {};
    const rows = await LEADS().find(q).sort({ createdAt: -1 }).limit(500).toArray();
    const all = await LEADS().find({}).project({ status: 1 }).limit(5000).toArray();
    const counts = Object.fromEntries(LEAD_STATUS.map((s) => [s, all.filter((r) => r.status === s).length]));
    return { counts, leads: rows.map(view) };
  }

  async function update(admin, leadId, body = {}) {
    const lid = checkId(leadId);
    const $set = { updatedAt: now(), updatedBy: admin.email };
    if (body.status !== undefined) $set.status = oneOf(body.status, LEAD_STATUS, 'status');
    if (body.adminNote !== undefined) $set.adminNote = str(body.adminNote, { field: 'adminNote', max: 500, optional: true });
    const r = await LEADS().updateOne({ _id: lid }, { $set });
    if (!r.matchedCount) throw new AppError(404, 'NOT_FOUND');
    await audit(admin, 'lead.update', { leadId: lid, status: $set.status ?? null });
    return view(await LEADS().findOne({ _id: lid }));
  }

  // ---------------------------------------------------------------- محتوى الموقع
  async function site() {
    const c = await CONFIG().findOne({ _id: 'site' });
    return { trusted: c?.trusted ?? [], testimonials: c?.testimonials ?? [] };
  }

  async function saveSite(admin, body = {}) {
    const trusted = (Array.isArray(body.trusted) ? body.trusted : []).slice(0, 12).map((t) => ({
      name: str(t?.name, { field: 'trusted.name', min: 1, max: 40 }),
      city: str(t?.city, { field: 'trusted.city', max: 30, optional: true }),
    }));
    const testimonials = (Array.isArray(body.testimonials) ? body.testimonials : []).slice(0, 9).map((t) => ({
      name: str(t?.name, { field: 'testimonials.name', min: 2, max: 40 }),
      shop: str(t?.shop, { field: 'testimonials.shop', max: 60, optional: true }),
      quote: str(t?.quote, { field: 'testimonials.quote', min: 5, max: 300 }),
    }));
    await CONFIG().updateOne({ _id: 'site' }, { $set: { trusted, testimonials, updatedAt: now(), updatedBy: admin.email } }, { upsert: true });
    await audit(admin, 'site.update', { trusted: trusted.length, testimonials: testimonials.length });
    return site();
  }

  return { submit, list, update, site, saveSite };
}
