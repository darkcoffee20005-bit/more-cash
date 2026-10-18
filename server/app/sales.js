// البيع والاسترجاع وشاشة التحضير والتذاكر المفتوحة والعملاء.
//
// قواعد الاعتماد:
//  - الخادم يعيد بناء التذكرة من الكتالوج (الأسعار، الإضافات، الخصومات) ويرفض إن اختلف الإجمالي عن الجهاز.
//  - clientId فريد لكل عملية: إعادة الإرسال تعيد نفس الإيصال دون أي أثر جديد.
//  - الآثار الجانبية (المخزون، النقاط) تُطبَّق بمفاتيح فريدة في الدفاتر، والإيصال يحمل effectsPending
//    حتى تكتمل؛ أي إيصال بقي معلقاً (انقطاع كهرباء) يُستكمل عند تشغيل الخادم.
import { calculateTicket, costOf, pointsEarned, refundPortion, settlePayments, unitPrice } from '../../shared/calc.js';
import { MoneyError } from '../../shared/money.js';
import { can } from '../../shared/perms.js';
import { AppError, audit, bad, conflict, escapeRegex, forbidden, getSettings, id as checkId, int, isDup, nextSeq, notFound, out, requirePerm, str } from './core.js';

const RECEIPT_BASE = 1000;
const PREP_FLOW = { new: 'preparing', preparing: 'ready', ready: 'served' };

export function createSales(ctx) {
  const { db, now, newId } = ctx;
  const C = (n) => db.collection(n);

  // ---------------------------------------------------------------- بناء التذكرة من الكتالوج
  async function buildTicket(actor, input, settings) {
    if (!Array.isArray(input.lines) || input.lines.length === 0) throw bad('EMPTY_TICKET');
    if (input.lines.length > 100) throw bad('TOO_MANY_LINES');
    const variantIds = [...new Set(input.lines.map((l) => checkId(l.variantId, 'variantId')))];
    const variants = new Map((await C('variants').find({ _id: { $in: variantIds }, active: true }).toArray()).map((v) => [v._id, v]));
    const items = new Map((await C('items').find({ _id: { $in: [...new Set([...variants.values()].map((v) => v.itemId))] }, active: true, forSale: true }).toArray()).map((i) => [i._id, i]));
    const categories = new Map((await C('categories').find({}).toArray()).map((c) => [c._id, c]));
    const modifiers = new Map((await C('modifiers').find({}).toArray()).map((m) => [m._id, m]));
    const discounts = new Map((await C('discounts').find({ active: true }).toArray()).map((d) => [d._id, d]));

    const usedDiscounts = [];
    const pickDiscounts = (ids = []) => {
      if (!Array.isArray(ids)) throw bad('INVALID_LIST', 'discountIds');
      return [...new Set(ids)].map((did) => {
        const d = discounts.get(checkId(did, 'discountId'));
        if (!d) throw bad('UNKNOWN_DISCOUNT');
        if (!can(actor.role, 'pos.discount')) throw forbidden('pos.discount');
        if (d.restricted && !can(actor.role, 'pos.discount_restricted')) throw forbidden('pos.discount_restricted');
        usedDiscounts.push(d);
        return { id: d._id, name: d.name, type: d.type, value: d.value };
      });
    };

    const lines = input.lines.map((l, i) => {
      const no = String(i + 1);
      const v = variants.get(l.variantId);
      const item = v && items.get(v.itemId);
      if (!v || !item) throw bad('UNKNOWN_ITEM', no);
      const qty = int(l.qty, { field: `lines.${no}.qty`, min: 1, max: 999 });
      const optionIds = Array.isArray(l.modifierOptionIds) ? l.modifierOptionIds.map((o) => checkId(o, 'modifierOptionId')) : [];
      const chosen = [];
      for (const mid of item.modifierIds) {
        const m = modifiers.get(mid);
        if (!m || m.active === false) continue;
        const sel = m.options.filter((o) => optionIds.includes(o.id));
        if (m.selection === 'single' && sel.length > 1) throw bad('MODIFIER_SINGLE', `${no}:${m.name}`);
        if (m.required && sel.length === 0) throw bad('MODIFIER_REQUIRED', `${no}:${m.name}`);
        for (const o of sel) chosen.push({ modifierId: m._id, modifierName: m.name, optionId: o.id, name: o.name, price: o.price });
      }
      if (chosen.length !== new Set(optionIds).size) throw bad('INVALID_MODIFIERS', no);
      const cat = categories.get(item.categoryId);
      return {
        variant: v,
        itemId: item._id, itemName: item.name, variantId: v._id, variantName: v.name, categoryId: item.categoryId, categoryName: cat?.name ?? '',
        qty, unitPrice: unitPrice(v.price, chosen.map((c) => c.price)), modifiers: chosen,
        note: str(l.note, { field: 'note', max: 120, optional: true }),
        discounts: pickDiscounts(l.discountIds ?? []),
      };
    });
    const ticketDiscounts = pickDiscounts(input.discountIds ?? []);

    let customer = null;
    if (input.customerId) {
      customer = await C('customers').findOne({ _id: checkId(input.customerId, 'customerId') });
      if (!customer) throw bad('UNKNOWN_CUSTOMER');
    }
    const pointsRedeemed = int(input.pointsRedeemed ?? 0, { field: 'pointsRedeemed' });
    if (pointsRedeemed > 0) {
      if (!settings.loyalty?.enabled || !customer) throw bad('POINTS_NOT_AVAILABLE');
      if (pointsRedeemed > customer.points) throw bad('INSUFFICIENT_POINTS');
    }

    let totals;
    try {
      totals = calculateTicket(lines, { discounts: ticketDiscounts, pointsRedeemed, tax: settings.tax });
    } catch (e) {
      if (e instanceof MoneyError) throw bad(e.code, e.detail);
      throw e;
    }
    const dining = settings.diningOptions.find((d) => d.id === (input.diningOption ?? settings.diningOptions[0].id));
    if (!dining) throw bad('UNKNOWN_DINING_OPTION');
    return { lines, ticketDiscounts, customer, pointsRedeemed, totals, dining, usedDiscounts };
  }

  async function lineCost(line) {
    const v = line.variant;
    if (v.recipe?.length) {
      const comps = await C('variants').find({ _id: { $in: v.recipe.map((r) => r.variantId) } }).toArray();
      const byId = new Map(comps.map((c) => [c._id, c]));
      return v.recipe.reduce((acc, r) => acc + costOf(r.qty * line.qty, byId.get(r.variantId)?.costMilli ?? 0), 0);
    }
    return costOf(line.qty, v.costMilli ?? 0);
  }

  // ---------------------------------------------------------------- البيع
  async function createSale(actor, input = {}) {
    requirePerm(actor, 'pos.sell');
    const clientId = checkId(input.clientId, 'clientId');
    const prior = await C('receipts').findOne({ clientId });
    if (prior) {
      if (prior.type !== 'sale') throw conflict('IDEMPOTENCY_KEY_REUSED');
      return { receipt: out(prior), duplicate: true };
    }
    const settings = await getSettings(db);
    const shift = await ctx.shifts.requireOpen();
    const t = await buildTicket(actor, input, settings);

    if (!Number.isSafeInteger(input.clientTotal) || input.clientTotal !== t.totals.total) {
      throw conflict('TOTAL_MISMATCH', `client=${input.clientTotal} server=${t.totals.total}`);
    }

    const types = new Map(settings.paymentTypes.filter((p) => p.active).map((p) => [p.id, p]));
    let payments;
    try {
      payments = settlePayments((input.payments ?? []).map((p) => {
        const type = types.get(p.typeId);
        if (!type) throw bad('UNKNOWN_PAYMENT_TYPE');
        return { typeId: type.id, typeName: type.name, kind: type.kind, amount: p.amount, tendered: p.tendered };
      }), t.totals.total);
    } catch (e) {
      if (e instanceof MoneyError) throw bad(e.code, e.detail);
      throw e;
    }

    // خصم النقاط المستبدلة قبل إنشاء الإيصال (شرط رصيد كافٍ ذرياً)
    if (t.pointsRedeemed > 0) await redeemPoints(t.customer._id, t.pointsRedeemed, clientId);

    const lines = [];
    for (const [i, l] of t.lines.entries()) {
      const calc = t.totals.lines[i];
      lines.push({
        itemId: l.itemId, itemName: l.itemName, variantId: l.variantId, variantName: l.variantName,
        categoryId: l.categoryId, categoryName: l.categoryName, qty: l.qty, unitPrice: l.unitPrice,
        modifiers: l.modifiers.map(({ modifierName, name, price }) => ({ group: modifierName, name, price })),
        discounts: l.discounts.map((d) => d.name), note: l.note,
        gross: calc.gross, discount: calc.discount, net: calc.net, tax: calc.tax, total: calc.total,
        cost: await lineCost(l), refundedQty: 0,
      });
    }

    const earned = settings.loyalty?.enabled && t.customer ? pointsEarned(t.totals.net, settings.loyalty.rateBp) : 0;
    // بيع سُجّل على الجهاز بلا إنترنت: يُحفظ بوقته الفعلي (ضمن الوردية وآخر 72 ساعة) لا بوقت وصوله
    let createdAt = now();
    let offline = false;
    if (input.offlineAt) {
      const at = new Date(input.offlineAt);
      if (!Number.isNaN(at.getTime()) && at <= createdAt && at >= new Date(shift.openedAt) && createdAt - at <= 72 * 3600_000) { createdAt = at; offline = true; }
    }
    const receipt = {
      _id: newId(),
      number: RECEIPT_BASE + (await nextSeq(db, 'receipt')),
      clientId, type: 'sale', status: 'paid', createdAt, ...(offline ? { offline: true } : {}),
      shiftId: shift._id, employeeId: actor.id, employeeName: actor.name,
      diningOption: t.dining.name, diningOptionId: t.dining.id,
      customerId: t.customer?._id ?? null, customerName: t.customer?.name ?? null,
      ticketName: str(input.ticketName, { field: 'ticketName', max: 40, optional: true }),
      lines,
      discounts: t.totals.appliedDiscounts.map((d) => ({ name: d.name, type: d.type, value: d.value, amount: d.amount })),
      pointsRedeemed: t.pointsRedeemed, pointsEarned: earned,
      totals: {
        gross: t.totals.gross, discountTotal: t.totals.discountTotal, net: t.totals.net, tax: t.totals.tax,
        taxMode: t.totals.taxMode, total: t.totals.total, cost: lines.reduce((a, l) => a + l.cost, 0),
      },
      payments, refundTotal: 0,
      prep: { status: settings.features?.kds ? 'new' : 'served', updatedAt: now() },
      effectsPending: true,
    };

    try {
      await C('receipts').insertOne(receipt);
    } catch (e) {
      if (isDup(e) && (await C('receipts').findOne({ clientId }))) return { receipt: out(await C('receipts').findOne({ clientId })), duplicate: true };
      throw e;
    }
    await applySaleEffects(receipt, input.ticketId);
    for (const d of t.usedDiscounts.filter((x) => x.restricted)) await audit({ ...ctx, actor }, 'discount.restricted', { receipt: receipt.number, discount: d.name });
    return { receipt: out(await C('receipts').findOne({ _id: receipt._id })), duplicate: false };
  }

  async function redeemPoints(customerId, points, clientId) {
    try {
      await C('point_moves').insertOne({ _id: newId(), key: `redeem:${clientId}`, customerId, delta: -points, at: now() });
    } catch (e) {
      if (isDup(e)) return; // خُصمت في محاولة سابقة
      throw e;
    }
    const r = await C('customers').updateOne({ _id: customerId, points: { $gte: points } }, { $inc: { points: -points } });
    if (!r.matchedCount) {
      await C('point_moves').deleteOne({ key: `redeem:${clientId}` });
      throw conflict('INSUFFICIENT_POINTS');
    }
  }

  async function applySaleEffects(receipt, ticketId = null) {
    const variantIds = [...new Set(receipt.lines.map((l) => l.variantId))];
    const variants = new Map((await C('variants').find({ _id: { $in: variantIds } }).toArray()).map((v) => [v._id, v]));
    for (const [i, line] of receipt.lines.entries()) {
      const v = variants.get(line.variantId);
      if (!v) continue;
      const parts = v.recipe?.length ? v.recipe.map((r) => ({ variantId: r.variantId, qty: r.qty * line.qty })) : v.trackStock ? [{ variantId: v._id, qty: line.qty }] : [];
      for (const p of parts) {
        await ctx.inventory.applyMove({ key: `sale:${receipt._id}:${i}:${p.variantId}`, variantId: p.variantId, delta: -p.qty, reason: 'sale', refId: receipt._id, by: { id: receipt.employeeId, name: receipt.employeeName } });
      }
    }
    if (receipt.customerId) {
      let fresh = true;
      try {
        await C('point_moves').insertOne({ _id: newId(), key: `sale:${receipt._id}`, customerId: receipt.customerId, delta: receipt.pointsEarned, at: now() });
      } catch (e) {
        if (!isDup(e)) throw e;
        fresh = false;
      }
      if (fresh) {
        await C('customers').updateOne({ _id: receipt.customerId }, {
          $inc: { points: receipt.pointsEarned, visits: 1, totalSpent: receipt.totals.total }, $set: { lastVisitAt: receipt.createdAt },
        });
      }
    }
    if (ticketId) await C('tickets').deleteOne({ _id: ticketId });
    await C('receipts').updateOne({ _id: receipt._id }, { $set: { effectsPending: false } });
  }

  /** يُستدعى عند تشغيل الخادم: يستكمل آثار أي إيصال انقطع تطبيقه */
  async function recoverPending() {
    const pending = await C('receipts').find({ effectsPending: true }).toArray();
    for (const r of pending) {
      if (r.type === 'sale') await applySaleEffects(r);
      else await applyRefundEffects(r);
    }
    return pending.length;
  }

  // ---------------------------------------------------------------- الاسترجاع
  async function refund(actor, saleId, input = {}) {
    requirePerm(actor, 'pos.refund');
    const clientId = checkId(input.clientId, 'clientId');
    const prior = await C('receipts').findOne({ clientId });
    if (prior) {
      if (prior.type !== 'refund' || prior.refundOf !== saleId) throw conflict('IDEMPOTENCY_KEY_REUSED');
      return { receipt: out(prior), duplicate: true };
    }
    const sale = await C('receipts').findOne({ _id: checkId(saleId), type: 'sale' });
    if (!sale) throw notFound('RECEIPT_NOT_FOUND');
    const shift = await ctx.shifts.requireOpen();
    const settings = await getSettings(db);
    const reason = str(input.reason, { field: 'reason', min: 2, max: 120 });

    if (!Array.isArray(input.lines) || input.lines.length === 0) throw bad('EMPTY_REFUND');
    const req = new Map();
    for (const l of input.lines) {
      const index = int(l.index, { field: 'index', max: sale.lines.length - 1 });
      const qty = int(l.qty, { field: 'qty', min: 1, max: 999 });
      req.set(index, (req.get(index) ?? 0) + qty);
    }

    // حجز الكميات ذرياً: يفشل إن تجاوزت أي كمية المتبقي (حتى مع استرجاعين متزامنين)
    const filter = { _id: sale._id };
    const inc = {};
    for (const [index, qty] of req) {
      if (qty > sale.lines[index].qty) throw bad('REFUND_QTY_EXCEEDS', String(index + 1));
      filter[`lines.${index}.refundedQty`] = { $lte: sale.lines[index].qty - qty };
      inc[`lines.${index}.refundedQty`] = qty;
    }
    const reserved = await C('receipts').updateOne(filter, { $inc: inc });
    if (!reserved.matchedCount) throw conflict('REFUND_QTY_EXCEEDS');

    try {
      const previous = await C('receipts').find({ refundOf: sale._id, type: 'refund' }).toArray();
      const already = (index, field) => previous.flatMap((r) => r.lines).filter((x) => x.index === index).reduce((a, x) => a + x[field], 0);
      const alreadyQty = (index) => previous.flatMap((r) => r.lines).filter((x) => x.index === index).reduce((a, x) => a + x.qty, 0);

      const lines = [...req].map(([index, qty]) => {
        const s = sale.lines[index];
        const part = (field) => refundPortion({ amount: s[field], qty: s.qty, refundQty: qty, alreadyQty: alreadyQty(index), alreadyAmount: already(index, field) });
        const gross = part('gross');
        const net = part('net');
        const tax = part('tax');
        return {
          index, itemId: s.itemId, itemName: s.itemName, variantId: s.variantId, variantName: s.variantName,
          categoryId: s.categoryId, categoryName: s.categoryName, qty, unitPrice: s.unitPrice, modifiers: s.modifiers,
          gross, discount: gross - net, net, tax, total: sale.totals.taxMode === 'added' ? net + tax : net, cost: part('cost'),
        };
      });
      const total = lines.reduce((a, l) => a + l.total, 0);
      const typeId = input.paymentTypeId ?? sale.payments[0]?.typeId ?? 'cash';
      const type = settings.paymentTypes.find((p) => p.id === typeId && p.active);
      if (!type) throw bad('UNKNOWN_PAYMENT_TYPE');

      const netRefunded = lines.reduce((a, l) => a + l.net, 0);
      const pointsReversed = sale.pointsEarned && sale.totals.net
        ? Number((BigInt(sale.pointsEarned) * BigInt(netRefunded) * 2n + BigInt(sale.totals.net)) / (2n * BigInt(sale.totals.net))) : 0;

      const doc = {
        _id: newId(), number: RECEIPT_BASE + (await nextSeq(db, 'receipt')), clientId, type: 'refund', refundOf: sale._id,
        refundOfNumber: sale.number, createdAt: now(), shiftId: shift._id, employeeId: actor.id, employeeName: actor.name,
        diningOption: sale.diningOption, customerId: sale.customerId, customerName: sale.customerName, reason,
        restock: input.restock === true,
        // إلغاء قبل بدء التحضير: مكونات الوصفة لم تُستعمل فتعود للمخزون
        restockIngredients: input.restockIngredients === true && sale.prep?.status === 'new', lines,
        totals: {
          gross: lines.reduce((a, l) => a + l.gross, 0), discountTotal: lines.reduce((a, l) => a + l.discount, 0), net: netRefunded,
          tax: lines.reduce((a, l) => a + l.tax, 0), taxMode: sale.totals.taxMode, total, cost: lines.reduce((a, l) => a + l.cost, 0),
        },
        payments: [{ typeId: type.id, typeName: type.name, kind: type.kind, amount: total, tendered: total, change: 0 }],
        pointsReversed, effectsPending: true, prep: { status: 'served' },
      };
      await C('receipts').insertOne(doc);
      const updated = await C('receipts').findOne({ _id: sale._id });
      const fully = updated.lines.every((l) => l.refundedQty >= l.qty);
      const cancelPrep = fully && ['new', 'preparing', 'ready'].includes(updated.prep?.status) ? { 'prep.status': 'cancelled', 'prep.updatedAt': now(), 'prep.cancelledAt': now() } : {};
      await C('receipts').updateOne({ _id: sale._id }, { $set: { status: fully ? 'refunded' : 'partially_refunded', ...cancelPrep }, $inc: { refundTotal: total } });
      await applyRefundEffects(doc);
      await audit({ ...ctx, actor }, 'receipt.refund', { sale: sale.number, refund: doc.number, total, reason, ...(input.source === 'kds' ? { source: 'kds' } : {}) });
      return { receipt: out(await C('receipts').findOne({ _id: doc._id })), duplicate: false };
    } catch (e) {
      // فك الحجز إن لم يُنشأ إيصال الاسترجاع
      const created = await C('receipts').findOne({ clientId });
      if (!created) {
        const undo = {};
        for (const [k, v] of Object.entries(inc)) undo[k] = -v;
        await C('receipts').updateOne({ _id: sale._id }, { $inc: undo });
      }
      if (isDup(e) && created) return { receipt: out(created), duplicate: true };
      throw e;
    }
  }

  async function applyRefundEffects(doc) {
    if (doc.restock || doc.restockIngredients) {
      const variants = new Map((await C('variants').find({ _id: { $in: doc.lines.map((l) => l.variantId) } }).toArray()).map((v) => [v._id, v]));
      const by = { id: doc.employeeId, name: doc.employeeName };
      for (const [i, l] of doc.lines.entries()) {
        const v = variants.get(l.variantId);
        // الصنف الجاهز يعود عند طلب ذلك؛ مكونات المشروب تعود فقط إن أُلغي قبل تحضيره
        if (doc.restock && v?.trackStock && !v.recipe?.length) {
          await ctx.inventory.applyMove({ key: `refund:${doc._id}:${i}`, variantId: v._id, delta: l.qty, reason: 'refund', refId: doc._id, by });
        }
        if (doc.restockIngredients && v?.recipe?.length) {
          for (const r of v.recipe) {
            await ctx.inventory.applyMove({ key: `refund:${doc._id}:${i}:${r.variantId}`, variantId: r.variantId, delta: r.qty * l.qty, reason: 'refund', refId: doc._id, by });
          }
        }
      }
    }
    if (doc.customerId) {
      let fresh = true;
      try {
        await C('point_moves').insertOne({ _id: newId(), key: `refund:${doc._id}`, customerId: doc.customerId, delta: -doc.pointsReversed, at: now() });
      } catch (e) {
        if (!isDup(e)) throw e;
        fresh = false;
      }
      if (fresh) {
        const c = await C('customers').findOne({ _id: doc.customerId });
        if (c) await C('customers').updateOne({ _id: c._id }, { $inc: { points: -Math.min(doc.pointsReversed, c.points), totalSpent: -doc.totals.total } });
      }
    }
    await C('receipts').updateOne({ _id: doc._id }, { $set: { effectsPending: false } });
  }

  // ---------------------------------------------------------------- الإيصالات
  async function getReceipt(actor, receiptId) {
    requirePerm(actor, 'receipts.view');
    const r = await C('receipts').findOne({ _id: checkId(receiptId) });
    if (!r) throw notFound('RECEIPT_NOT_FOUND');
    const refunds = r.type === 'sale' ? await C('receipts').find({ refundOf: r._id }).sort({ createdAt: 1 }).toArray() : [];
    return { ...out(r, ['clientId', 'effectsPending']), refunds: refunds.map((x) => out(x, ['clientId', 'effectsPending'])) };
  }

  async function listReceipts(actor, { search = '', from = null, to = null, limit = 60, before = null } = {}) {
    requirePerm(actor, 'receipts.view');
    const q = {};
    if (from && to) q.createdAt = { $gte: from, $lt: to };
    if (before) q.createdAt = { ...(q.createdAt ?? {}), $lt: before };
    const s = String(search).trim().replace(/^#/, '');
    if (s) {
      if (/^\d+$/.test(s)) q.number = Number(s);
      else q.customerName = { $regex: escapeRegex(s.slice(0, 40)), $options: 'i' };
    }
    const rows = await C('receipts').find(q).sort({ createdAt: -1 }).limit(Math.min(limit, 200)).toArray();
    return rows.map((r) => ({
      id: r._id, number: r.number, type: r.type, status: r.status, createdAt: r.createdAt, total: r.totals.total,
      employeeName: r.employeeName, customerName: r.customerName, diningOption: r.diningOption,
      payments: r.payments.map((p) => p.typeName), refundOfNumber: r.refundOfNumber ?? null,
      itemsCount: r.lines.reduce((a, l) => a + l.qty, 0),
    }));
  }

  // ---------------------------------------------------------------- شاشة التحضير (KDS)
  async function kdsList(actor) {
    requirePerm(actor, 'kds.use');
    const since = new Date(now().getTime() - 12 * 3600_000);
    const rows = await C('receipts').find({ type: 'sale', 'prep.status': { $in: ['new', 'preparing', 'ready'] }, createdAt: { $gte: since } }).sort({ createdAt: 1 }).limit(80).toArray();
    return rows.map((r) => ({
      id: r._id, number: r.number, createdAt: r.createdAt, prep: r.prep, diningOption: r.diningOption, customerName: r.customerName,
      ticketName: r.ticketName, employeeName: r.employeeName, status: r.status, paymentTypeId: r.payments[0]?.typeId ?? null,
      lines: r.lines.map((l) => ({ name: l.itemName, variant: l.variantName, qty: l.qty, refundedQty: l.refundedQty, total: l.total, modifiers: l.modifiers.map((m) => m.name), note: l.note })),
    }));
  }

  async function kdsAdvance(actor, receiptId, { from } = {}) {
    requirePerm(actor, 'kds.use');
    const next = PREP_FLOW[from];
    if (!next) throw bad('INVALID_CHOICE', 'from');
    // الانتقال مشروط بالحالة الحالية: نقرتان متزامنتان لا تقفزان مرحلتين
    const r = await C('receipts').updateOne({ _id: checkId(receiptId), 'prep.status': from }, { $set: { 'prep.status': next, 'prep.updatedAt': now(), [`prep.${next}At`]: now() } });
    return { advanced: r.matchedCount === 1, status: next };
  }

  // ---------------------------------------------------------------- التذاكر المفتوحة
  function cleanTicketLines(lines) {
    if (!Array.isArray(lines) || lines.length > 100) throw bad('INVALID_LIST', 'lines');
    return lines.map((l) => ({
      variantId: checkId(l.variantId, 'variantId'), qty: int(l.qty, { field: 'qty', min: 1, max: 999 }),
      modifierOptionIds: Array.isArray(l.modifierOptionIds) ? l.modifierOptionIds.map((o) => checkId(o, 'modifierOptionId')) : [],
      discountIds: Array.isArray(l.discountIds) ? l.discountIds.map((o) => checkId(o, 'discountId')) : [],
      note: str(l.note, { field: 'note', max: 120, optional: true }),
    }));
  }

  async function saveTicket(actor, input = {}) {
    requirePerm(actor, 'pos.tickets');
    const doc = {
      name: str(input.name, { field: 'name', min: 1, max: 40 }),
      note: str(input.note, { field: 'note', max: 120, optional: true }),
      lines: cleanTicketLines(input.lines),
      discountIds: Array.isArray(input.discountIds) ? input.discountIds.map((d) => checkId(d, 'discountId')) : [],
      customerId: input.customerId ? checkId(input.customerId, 'customerId') : null,
      diningOption: input.diningOption ? checkId(input.diningOption, 'diningOption') : null,
      displayTotal: Number.isSafeInteger(input.displayTotal) ? input.displayTotal : 0,
      updatedAt: now(), updatedBy: actor.name,
    };
    if (doc.lines.length === 0) throw bad('EMPTY_TICKET');
    if (input.id) {
      // تحقق النسخة: جهازان يعدّلان نفس التذكرة لا يكتب أحدهما فوق الآخر
      const r = await C('tickets').updateOne({ _id: checkId(input.id), version: int(input.version, { field: 'version' }) }, { $set: doc, $inc: { version: 1 } });
      if (!r.matchedCount) throw conflict('TICKET_CHANGED');
      return out(await C('tickets').findOne({ _id: input.id }));
    }
    const created = { _id: newId(), ...doc, version: 1, createdAt: now(), employeeId: actor.id, employeeName: actor.name };
    await C('tickets').insertOne(created);
    return out(created);
  }

  async function listTickets(actor) {
    requirePerm(actor, 'pos.tickets');
    return (await C('tickets').find({}).sort({ updatedAt: -1 }).toArray()).map((t) => out(t));
  }

  async function deleteTicket(actor, ticketId) {
    requirePerm(actor, 'pos.void_saved');
    const t = await C('tickets').findOne({ _id: checkId(ticketId) });
    if (!t) throw notFound();
    await C('tickets').deleteOne({ _id: t._id });
    await audit({ ...ctx, actor }, 'ticket.delete', { name: t.name, lines: t.lines.length });
    return { ok: true };
  }

  // ---------------------------------------------------------------- العملاء
  async function listCustomers(actor, { search = '' } = {}) {
    requirePerm(actor, 'customers.manage');
    const s = String(search).trim().slice(0, 40);
    const q = s ? { $or: [{ name: { $regex: escapeRegex(s), $options: 'i' } }, { phone: { $regex: escapeRegex(s) } }] } : {};
    return (await C('customers').find(q).sort({ lastVisitAt: -1, name: 1 }).limit(100).toArray()).map((c) => out(c));
  }

  async function saveCustomer(actor, input = {}) {
    requirePerm(actor, 'customers.manage');
    const phone = str(input.phone, { field: 'phone', max: 20, optional: true });
    if (phone && !/^[0-9+\- ]{7,20}$/.test(phone)) throw bad('INVALID_PHONE');
    const doc = {
      name: str(input.name, { field: 'name', min: 2, max: 50 }),
      phone: phone ? phone.replace(/[\s-]/g, '') : null,
      note: str(input.note, { field: 'note', max: 200, optional: true }),
      updatedAt: now(),
    };
    try {
      if (input.id) {
        const r = await C('customers').updateOne({ _id: checkId(input.id) }, { $set: doc });
        if (!r.matchedCount) throw notFound();
        return out(await C('customers').findOne({ _id: input.id }));
      }
      const created = { _id: newId(), ...doc, points: 0, visits: 0, totalSpent: 0, lastVisitAt: null, createdAt: now() };
      await C('customers').insertOne(created);
      return out(created);
    } catch (e) {
      if (isDup(e)) throw conflict('PHONE_IN_USE');
      throw e;
    }
  }

  async function getCustomer(actor, customerId) {
    requirePerm(actor, 'customers.manage');
    const c = await C('customers').findOne({ _id: checkId(customerId) });
    if (!c) throw notFound();
    const receipts = await C('receipts').find({ customerId: c._id }).sort({ createdAt: -1 }).limit(20).toArray();
    return { ...out(c), receipts: receipts.map((r) => ({ id: r._id, number: r.number, type: r.type, createdAt: r.createdAt, total: r.totals.total })) };
  }

  return {
    createSale, refund, recoverPending, getReceipt, listReceipts, kdsList, kdsAdvance,
    saveTicket, listTickets, deleteTicket, listCustomers, saveCustomer, getCustomer, AppError,
  };
}
