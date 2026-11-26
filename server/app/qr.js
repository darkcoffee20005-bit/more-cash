// «اطلب من الطاولة» بجانب المقهى: قائمة الزبون، استلام طلبه، وقرار الكاشير (قبول/رفض/حظر).
// الزبون بلا حساب ولا جلسة: تتحقق طبقة المنصة من رمز الطاولة ومن أن جهازه على شبكة المقهى قبل الوصول هنا.
// الطلب المقبول يدخل تذكرة الطاولة (أسطره معلّمة «بالمطبخ» sentQty) ويظهر في شاشة التحضير فوراً،
// فإذا دفع الزبون لاحقاً لا يتكرر على شاشة التحضير.
import { unitPrice } from '../../shared/calc.js';
import { AppError, audit, bad, conflict, getSettings, id as checkId, int, isDup, nextSeq, notFound, out, requirePerm, str } from './core.js';

const MAX_LINES = 30;
const MAX_PENDING_PER_GUEST = 3;
const MAX_PENDING_PER_TABLE = 8;
export const QR_STATUS = ['pending', 'accepted', 'rejected'];

export function createQr(ctx) {
  const { db, now, newId, catalog } = ctx;
  const C = (name) => db.collection(name);

  async function context(tableId) {
    const settings = await getSettings(db);
    if (!settings.features?.qr) throw new AppError(403, 'QR_DISABLED');
    const table = (settings.floor?.tables ?? []).find((t) => t.id === tableId && t.kind === 'table');
    if (!table) throw new AppError(404, 'QR_UNKNOWN_TABLE');
    return { settings, table };
  }

  /** قائمة الزبون: الأصناف المعروضة للبيع بأسعارها وإضافاتها، والمتوفر فقط قابل للطلب */
  async function menu(tableId) {
    const { settings, table } = await context(tableId);
    const cat = await catalog.posCatalog();
    const usedMods = new Set(cat.items.flatMap((i) => i.modifierIds ?? []));
    return {
      shop: { name: settings.name }, table: { name: table.name },
      categories: cat.categories.map((c) => ({ id: c.id, name: c.name, color: c.color })),
      items: cat.items.map((i) => ({
        id: i.id, name: i.name, categoryId: i.categoryId, emoji: i.emoji ?? null, color: i.color ?? null, imageV: i.imageV ?? null, description: i.description ?? null,
        modifierIds: i.modifierIds ?? [],
        variants: i.variants.map((v) => ({ id: v.id, name: v.name, price: v.price, soldOut: v.available !== null && v.available <= 0 })),
      })),
      modifiers: cat.modifiers.filter((m) => usedMods.has(m.id)).map((m) => ({ id: m.id, name: m.name, selection: m.selection, required: !!m.required, options: m.options.map((o) => ({ id: o.id, name: o.name, price: o.price })) })),
    };
  }

  /** طلب الزبون: يُسعَّر من القائمة على الخادم (لا يُوثق بسعر الجهاز) ويبقى معلّقاً حتى يقرر الكاشير */
  async function submit(tableId, body = {}, { ipKey } = {}) {
    const { table } = await context(tableId);
    const clientId = checkId(body.clientId, 'clientId');
    const guestId = checkId(body.guestId, 'guestId');
    const existing = await C('qr_orders').findOne({ clientId });
    if (existing) return view(existing);
    if (await C('qr_blocks').findOne({ guestId })) throw new AppError(403, 'QR_BLOCKED');
    if (await C('qr_orders').countDocuments({ guestId, status: 'pending' }) >= MAX_PENDING_PER_GUEST) throw new AppError(429, 'QR_TOO_MANY');
    if (await C('qr_orders').countDocuments({ tableId, status: 'pending' }) >= MAX_PENDING_PER_TABLE) throw new AppError(429, 'QR_TOO_MANY');
    if (!Array.isArray(body.lines) || !body.lines.length || body.lines.length > MAX_LINES) throw bad('INVALID_LIST', 'lines');

    const cat = await catalog.posCatalog();
    const variants = new Map(cat.items.flatMap((i) => i.variants.map((v) => [v.id, { v, item: i }])));
    const mods = new Map(cat.modifiers.map((m) => [m.id, m]));
    const lines = body.lines.map((l, i) => {
      const no = String(i + 1);
      const found = variants.get(checkId(l.variantId, 'variantId'));
      if (!found) throw bad('UNKNOWN_ITEM', no);
      const { v, item } = found;
      if (v.available !== null && v.available <= 0) throw new AppError(409, 'OUT_OF_STOCK', item.name);
      const qty = int(l.qty, { field: 'qty', min: 1, max: 20 });
      const optionIds = Array.isArray(l.modifierOptionIds) ? l.modifierOptionIds.map((o) => checkId(o, 'modifierOptionId')) : [];
      const chosen = [];
      for (const mid of item.modifierIds ?? []) {
        const m = mods.get(mid);
        if (!m) continue;
        const sel = m.options.filter((o) => optionIds.includes(o.id));
        if (m.selection === 'single' && sel.length > 1) throw bad('MODIFIER_SINGLE', `${no}:${m.name}`);
        if (m.required && sel.length === 0) throw bad('MODIFIER_REQUIRED', `${no}:${m.name}`);
        for (const o of sel) chosen.push({ id: o.id, name: o.name, price: o.price });
      }
      if (chosen.length !== new Set(optionIds).size) throw bad('INVALID_MODIFIERS', no);
      const price = unitPrice(v.price, chosen.map((c) => c.price));
      return { variantId: v.id, itemName: item.name, variantName: v.name, qty, modifierOptionIds: chosen.map((c) => c.id), modifiers: chosen.map((c) => c.name),
        note: str(l.note, { field: 'note', max: 120, optional: true }), unitPrice: price, total: price * qty };
    });
    const doc = {
      _id: newId(), clientId, tableId, tableName: table.name, guestId,
      guestName: str(body.name, { field: 'name', max: 30, optional: true }), note: str(body.note, { field: 'note', max: 200, optional: true }),
      lines, total: lines.reduce((a, l) => a + l.total, 0), status: 'pending', createdAt: now(), ipKey: ipKey ?? null,
    };
    try { await C('qr_orders').insertOne(doc); } catch (e) {
      if (isDup(e)) return view(await C('qr_orders').findOne({ clientId }));
      throw e;
    }
    return view(doc);
  }

  const view = ({ ipKey, guestId, ...o }) => out(o);

  /** حالة طلبات الزبون على هذه الطاولة اليوم (ليعرف هل قُبل طلبه) */
  async function guestOrders(tableId, guestId) {
    await context(tableId);
    const since = new Date(now().getTime() - 12 * 3600_000);
    const rows = await C('qr_orders').find({ tableId, guestId: checkId(guestId, 'guestId'), createdAt: { $gte: since } }).sort({ createdAt: -1 }).limit(10).toArray();
    return rows.map(view);
  }

  // ---------------------------------------------------------------- جهة الكاشير
  async function pending(actor) {
    requirePerm(actor, 'pos.sell');
    const rows = await C('qr_orders').find({ status: 'pending' }).sort({ createdAt: 1 }).limit(50).toArray();
    return rows.map((o) => ({ ...view(o), guest: o.guestId.slice(0, 6) }));
  }

  async function decide(actor, orderId, accept, reason) {
    requirePerm(actor, 'pos.sell');
    const id = checkId(orderId);
    const settings = await getSettings(db);
    const set = accept
      ? { status: 'accepted', number: await nextSeq(db, 'qr'), decidedAt: now(), decidedBy: actor.name,
        prep: { status: settings.features?.kds ? 'new' : 'served', updatedAt: now() } }
      : { status: 'rejected', decidedAt: now(), decidedBy: actor.name, reason: str(reason, { field: 'reason', max: 120, optional: true }) };
    // القرار مرة واحدة: كاشيران يضغطان معاً لا يقبلان الطلب مرتين
    const r = await C('qr_orders').updateOne({ _id: id, status: 'pending' }, { $set: set });
    if (!r.matchedCount) throw conflict('QR_ALREADY_DECIDED');
    const o = await C('qr_orders').findOne({ _id: id });
    if (accept) await addToTicket(actor, o, settings);
    await audit({ ...ctx, actor }, accept ? 'qr.accept' : 'qr.reject', { table: o.tableName, total: o.total, reason: set.reason ?? null });
    return view(o);
  }

  /** الطلب المقبول يُضاف لتذكرة الطاولة (تُنشأ إن لم تكن)، بأسطر معلّمة أنها وصلت المطبخ */
  async function addToTicket(actor, o, settings) {
    const lines = o.lines.map((l) => ({ variantId: l.variantId, qty: l.qty, modifierOptionIds: l.modifierOptionIds, discountIds: [], note: l.note ?? null, sentQty: l.qty }));
    for (let attempt = 0; attempt < 3; attempt++) {
      const t = await C('tickets').findOne({ tableId: o.tableId });
      if (t) {
        const r = await C('tickets').updateOne({ _id: t._id, version: t.version }, {
          $push: { lines: { $each: lines } }, $inc: { version: 1, displayTotal: o.total }, $set: { updatedAt: now(), updatedBy: actor.name },
        });
        if (r.matchedCount) return;
        continue;
      }
      const dine = settings.diningOptions.find((d) => d.id === 'dine_in') ?? settings.diningOptions[0];
      try {
        await C('tickets').insertOne({ _id: newId(), name: o.tableName, tableId: o.tableId, note: o.guestName ? `QR: ${o.guestName}` : 'QR', lines, discountIds: [], customerId: null,
          diningOption: dine.id, displayTotal: o.total, version: 1, createdAt: now(), updatedAt: now(), updatedBy: actor.name, employeeId: actor.id, employeeName: actor.name });
        return;
      } catch (e) { if (!isDup(e)) throw e; }
    }
    throw conflict('TICKET_CHANGED');
  }

  /** حظر الزبون (من جهازه): تُرفض طلباته المعلّقة ولا يستطيع الطلب مرة أخرى */
  async function block(actor, orderId) {
    requirePerm(actor, 'pos.sell');
    const o = await C('qr_orders').findOne({ _id: checkId(orderId) });
    if (!o) throw notFound();
    try { await C('qr_blocks').insertOne({ _id: newId(), guestId: o.guestId, tableName: o.tableName, guestName: o.guestName ?? null, at: now(), by: actor.name }); } catch (e) { if (!isDup(e)) throw e; }
    await C('qr_orders').updateMany({ guestId: o.guestId, status: 'pending' }, { $set: { status: 'rejected', reason: 'محظور', decidedAt: now(), decidedBy: actor.name } });
    await audit({ ...ctx, actor }, 'qr.block', { table: o.tableName, guest: o.guestName ?? null });
    return { ok: true };
  }

  async function blocks(actor) {
    requirePerm(actor, 'pos.sell');
    return (await C('qr_blocks').find({}).sort({ at: -1 }).limit(100).toArray()).map(({ guestId, ...b }) => out(b));
  }

  async function unblock(actor, blockId) {
    requirePerm(actor, 'admin.catalog');
    const r = await C('qr_blocks').deleteOne({ _id: checkId(blockId) });
    if (!r.deletedCount) throw notFound();
    await audit({ ...ctx, actor }, 'qr.unblock', {});
    return { ok: true };
  }

  // ---------------------------------------------------------------- شاشة التحضير
  async function kitchen() {
    const since = new Date(now().getTime() - 12 * 3600_000);
    const rows = await C('qr_orders').find({ status: 'accepted', 'prep.status': { $in: ['new', 'preparing', 'ready', 'served'] }, decidedAt: { $gte: since } }).sort({ decidedAt: 1 }).limit(60).toArray();
    return rows.map((o) => ({
      id: o._id, qr: true, number: `Q${o.number}`, createdAt: o.decidedAt, prep: o.prep, diningOption: 'طاولة', diningOptionId: 'dine_in',
      customerName: o.guestName ?? null, ticketName: o.tableName, status: 'paid', lines: o.lines.map((l) => ({ name: l.itemName, variant: l.variantName, qty: l.qty, refundedQty: 0, sentQty: 0, modifiers: l.modifiers, note: l.note })),
    }));
  }

  return { menu, submit, guestOrders, pending, decide, block, blocks, unblock, kitchen };
}
