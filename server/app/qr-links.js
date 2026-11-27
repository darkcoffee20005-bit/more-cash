// «اطلب من الطاولة» بطبقة المنصة: رمز سري لكل طاولة يدل على مقهاها، والتحقق أن الزبون على شبكة المقهى.
//
// الشبكة نفسها = عنوان الإنترنت العام للزبون يطابق عنوان أحد أجهزة المقهى المرتبطة خلال آخر 12 ساعة
// (كل أجهزة واي فاي المقهى تخرج للإنترنت بعنوان IPv4 واحد، وفي IPv6 تتشارك أول 64 بت من العنوان).
// فلا يطلب أحد من بيته برابط منسوخ، ولا يرسل طلبات وهمية من خارج المقهى.
import { randomToken } from './security.js';
import { AppError, id as checkId } from './core.js';

const SEEN_WINDOW_MS = 12 * 3600_000;
export const TAKEAWAY = 'takeaway';
const TOUCH_EVERY_MS = 5 * 60_000;
const GUEST_PER_IP_HOUR = 30;

function expandV6(s) {
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const fill = tail !== undefined ? Array(Math.max(0, 8 - h.length - t.length)).fill('0') : [];
  return [...h, ...fill, ...t].map((x) => x.replace(/^0+(?=.)/, ''));
}

/** مفتاح الشبكة لعنوان: IPv4 كما هو، وIPv6 أول 64 بت (البادئة المشتركة لأجهزة الشبكة الواحدة) */
export function ipKey(ip) {
  let s = String(ip ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (s.startsWith('::ffff:') && s.includes('.')) s = s.slice(7);
  if (!s) return null;
  if (s.includes(':')) return `${expandV6(s).slice(0, 4).join(':')}::/64`;
  return s;
}

export function createQrLinks({ db, now }) {
  const LINKS = () => db.collection('qr_links');
  const hits = new Map(); // مفتاح الشبكة → {count, since}

  /** يُستدعى مع كل طلب من جهاز مقهى: يحفظ آخر عنوان شبكة له (كتابة كل 5 دقائق كحد أقصى) */
  async function touchDevice(device, ip) {
    const key = ipKey(ip);
    if (!device || !key) return;
    const last = device.lastSeenAt ? new Date(device.lastSeenAt).getTime() : 0;
    if (device.lastNet === key && now().getTime() - last < TOUCH_EVERY_MS) return;
    await db.collection('devices').updateOne({ _id: device._id }, { $set: { lastNet: key, lastSeenAt: now() } });
  }

  async function sameNetwork(tenantId, ip) {
    const key = ipKey(ip);
    if (!key) return false;
    const since = new Date(now().getTime() - SEEN_WINDOW_MS);
    return Boolean(await db.collection('devices').findOne({ tenantId, lastNet: key, lastSeenAt: { $gte: since } }, { projection: { _id: 1 } }));
  }

  /** رمز الطاولة → مقهاها وطاولتها، مع حد للطلبات من نفس الشبكة */
  async function resolve(token, ip, { requireNetwork = true } = {}) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(token)) throw new AppError(404, 'QR_UNKNOWN_TABLE');
    const link = await LINKS().findOne({ token });
    if (!link) throw new AppError(404, 'QR_UNKNOWN_TABLE');
    const key = ipKey(ip) ?? 'unknown';
    const t = Date.now();
    const h = hits.get(key);
    if (!h || t - h.since >= 3600_000) { hits.set(key, { count: 1, since: t }); if (hits.size > 5000) hits.clear(); } else if (++h.count > GUEST_PER_IP_HOUR * 10) throw new AppError(429, 'TOO_MANY_ATTEMPTS');
    const onNetwork = await sameNetwork(link.tenantId, ip);
    if (requireNetwork && !onNetwork) throw new AppError(403, 'QR_NOT_ON_NETWORK');
    return { tenantId: link.tenantId, tableId: link.tableId, key, onNetwork };
  }

  /** رموز طاولات المقهى (تُنشأ للطاولات الجديدة، وتُحذف لطاولات أُزيلت من الخريطة) */
  async function list(tenantId, tables) {
    // رمز «سفري» ثابت لكل مقهى (غير مرتبط بطاولة): يُطبع عند الكاشير أو الباب
    tables = [{ id: TAKEAWAY, name: 'سفري' }, ...tables];
    const ids = new Set(tables.map((t) => t.id));
    await LINKS().deleteMany({ tenantId, tableId: { $nin: [...ids] } });
    const have = new Map((await LINKS().find({ tenantId }).toArray()).map((l) => [l.tableId, l]));
    const outList = [];
    for (const t of tables) {
      let l = have.get(t.id);
      if (!l) {
        l = { _id: `${tenantId}:${t.id}`, tenantId, tableId: t.id, token: randomToken(18), createdAt: now() };
        try { await LINKS().insertOne(l); } catch { l = await LINKS().findOne({ tenantId, tableId: t.id }); }
      }
      outList.push({ tableId: t.id, tableName: t.name, token: l.token, takeaway: t.id === TAKEAWAY });
    }
    return outList;
  }

  /** رمز جديد لطاولة (القديم يتوقف فوراً): إذا صُوّر الرمز وانتشر */
  async function rotate(tenantId, tableId) {
    const id = checkId(tableId, 'tableId');
    const token = randomToken(18);
    const r = await LINKS().updateOne({ tenantId, tableId: id }, { $set: { token, rotatedAt: now() } });
    if (!r.matchedCount) throw new AppError(404, 'QR_UNKNOWN_TABLE');
    return { tableId: id, token };
  }

  return { touchDevice, sameNetwork, resolve, list, rotate };
}
