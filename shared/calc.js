// حساب التذكرة — نفس الكود يعمل في المتصفح (للعرض) وفي الخادم (للاعتماد).
// كل المبالغ دنانير عراقية بأعداد صحيحة. الخادم يعيد الحساب من أسعار قاعدة البيانات ويرفض أي اختلاف.
//
// الترتيب:
//   1. إجمالي السطر = سعر الوحدة (الحجم + الإضافات) × الكمية
//   2. خصومات السطر (نسبة من إجمالي السطر، أو مبلغ ثابت للسطر) — بحد أقصى إجمالي السطر
//   3. خصومات التذكرة (النسب أولاً على الأساس بعد خصومات الأسطر، ثم المبالغ) — موزعة على الأسطر
//   4. استبدال النقاط (1 نقطة = 1 د.ع) — خصم إضافي موزع على الأسطر
//   5. الضريبة: بلا / مضافة على الصافي / مشمولة في السعر
import { MoneyError, add, allocateProportionally, bp as checkBp, iqd, percentOf, sub, sum, times } from './money.js';

/** سعر الوحدة = سعر الحجم + مجموع أسعار الإضافات المختارة */
export function unitPrice(variantPrice, modifierPrices = []) {
  return modifierPrices.reduce((acc, p) => add(acc, iqd(p)), iqd(variantPrice));
}

/** قيمة خصم واحد على أساس معين. percent: value بالـ basis points (1000 = 10%) */
export function discountValue(discount, base) {
  if (discount.type === 'percent') return percentOf(base, checkBp(discount.value));
  if (discount.type === 'amount') return Math.min(iqd(discount.value), base);
  throw new MoneyError('INVALID_DISCOUNT_TYPE', discount.type);
}

/**
 * @param {Array<{qty:number, unitPrice:number, discounts?:Array<{type:string,value:number,name?:string}>}>} lines
 * @param {{discounts?:Array, pointsRedeemed?:number, tax?:{mode:'none'|'added'|'included', rateBp:number}}} opts
 */
export function calculateTicket(lines, { discounts = [], pointsRedeemed = 0, tax = { mode: 'none', rateBp: 0 } } = {}) {
  if (!Array.isArray(lines) || lines.length === 0) throw new MoneyError('EMPTY_TICKET');
  iqd(pointsRedeemed);
  if (pointsRedeemed < 0) throw new MoneyError('INVALID_POINTS');

  const rows = lines.map((l, i) => {
    if (!Number.isSafeInteger(l.qty) || l.qty <= 0) throw new MoneyError('INVALID_QUANTITY', String(i + 1));
    if (!Number.isSafeInteger(l.unitPrice) || l.unitPrice < 0) throw new MoneyError('INVALID_PRICE', String(i + 1));
    const gross = times(l.unitPrice, l.qty);
    let lineDiscount = 0;
    for (const d of l.discounts ?? []) lineDiscount = add(lineDiscount, discountValue(d, gross));
    lineDiscount = Math.min(lineDiscount, gross);
    return { gross, lineDiscount, base: sub(gross, lineDiscount) };
  });

  const base = sum(rows.map((r) => r.base));

  // خصومات التذكرة: النسب أولاً ثم المبالغ، والمجموع لا يتجاوز الأساس
  const ordered = [...discounts].sort((a, b) => (a.type === b.type ? 0 : a.type === 'percent' ? -1 : 1));
  let remaining = base;
  const appliedDiscounts = [];
  for (const d of ordered) {
    const value = Math.min(discountValue(d, d.type === 'percent' ? base : remaining), remaining);
    remaining = sub(remaining, value);
    appliedDiscounts.push({ ...d, amount: value });
  }
  const ticketDiscount = sub(base, remaining);
  if (pointsRedeemed > remaining) throw new MoneyError('POINTS_EXCEED_TOTAL');

  const ticketShares = allocateProportionally(rows.map((r) => r.base), ticketDiscount);
  const afterTicket = rows.map((r, i) => sub(r.base, ticketShares[i]));
  const pointShares = allocateProportionally(afterTicket, pointsRedeemed);
  const nets = afterTicket.map((v, i) => sub(v, pointShares[i]));
  const net = sum(nets);

  checkBp(tax.rateBp ?? 0);
  let taxTotal = 0;
  if (tax.mode === 'added') taxTotal = percentOf(net, tax.rateBp);
  else if (tax.mode === 'included') {
    // الضريبة المشمولة: net × r ÷ (1 + r)، تقريب نصف لأعلى
    taxTotal = Number((BigInt(net) * BigInt(tax.rateBp) * 2n + BigInt(10000 + tax.rateBp)) / (2n * BigInt(10000 + tax.rateBp)));
  } else if (tax.mode !== 'none') throw new MoneyError('INVALID_TAX_MODE', tax.mode);
  const lineTaxes = allocateProportionally(nets, taxTotal);

  const gross = sum(rows.map((r) => r.gross));
  const lineDiscountTotal = sum(rows.map((r) => r.lineDiscount));
  return {
    gross,
    lineDiscount: lineDiscountTotal,
    ticketDiscount,
    pointsDiscount: pointsRedeemed,
    discountTotal: add(add(lineDiscountTotal, ticketDiscount), pointsRedeemed),
    net,
    tax: taxTotal,
    taxMode: tax.mode,
    total: tax.mode === 'added' ? add(net, taxTotal) : net,
    appliedDiscounts,
    lines: rows.map((r, i) => ({
      gross: r.gross,
      discount: add(add(r.lineDiscount, ticketShares[i]), pointShares[i]),
      net: nets[i],
      tax: lineTaxes[i],
      total: tax.mode === 'added' ? add(nets[i], lineTaxes[i]) : nets[i],
    })),
  };
}

/**
 * التحقق من الدفعات: المجموع يساوي المستحق تماماً، والنقد المستلم ≥ المطبّق.
 * يعيد الدفعات مع الباقي لكل دفعة نقدية.
 */
export function settlePayments(payments, total) {
  if (!Array.isArray(payments) || payments.length === 0) {
    if (total === 0) return [];
    throw new MoneyError('PAYMENT_REQUIRED');
  }
  const out = payments.map((p) => {
    iqd(p.amount);
    if (p.amount <= 0) throw new MoneyError('INVALID_PAYMENT');
    if (p.kind === 'cash') {
      const tendered = iqd(p.tendered ?? p.amount);
      if (tendered < p.amount) throw new MoneyError('TENDERED_LESS_THAN_DUE');
      return { ...p, tendered, change: sub(tendered, p.amount) };
    }
    return { ...p, tendered: p.amount, change: 0 };
  });
  const paid = sum(out.map((p) => p.amount));
  if (paid !== total) throw new MoneyError(paid > total ? 'OVERPAYMENT' : 'UNDERPAYMENT', `paid=${paid} total=${total}`);
  return out;
}

/** مبلغ استرجاع جزء من سطر: آخر جزء يأخذ الباقي الدقيق حتى لا يتراكم التقريب */
export function refundPortion({ amount, qty, refundQty, alreadyQty = 0, alreadyAmount = 0 }) {
  if (!Number.isSafeInteger(refundQty) || refundQty <= 0 || alreadyQty + refundQty > qty) throw new MoneyError('REFUND_QTY_EXCEEDS');
  if (alreadyQty + refundQty === qty) return sub(amount, alreadyAmount);
  return Number((BigInt(amount) * BigInt(refundQty) * 2n + BigInt(qty)) / (2n * BigInt(qty)));
}

/** نقاط الولاء المكتسبة: نسبة من المبلغ المدفوع فعلاً (بعد كل الخصومات واستبدال النقاط) */
export const pointsEarned = (net, rateBp) => (rateBp > 0 ? percentOf(net, checkBp(rateBp)) : 0);

// ---------------------------------------------------------------- التكلفة بالمللي دينار
// تكلفة الوحدة مخزنة كعدد صحيح = د.ع × 1000 (يدعم 2.5 د.ع/مل دون كسور).

/** "2.5" → 2500 ، "30" → 30000. يرفض أكثر من 3 منازل عشرية */
export function parseMilli(text) {
  const s = String(text ?? '').trim().replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[,٬]/g, '').replace('٫', '.');
  if (s === '') return 0;
  const m = /^(\d+)(?:\.(\d{1,3}))?$/.exec(s);
  if (!m) throw new MoneyError('INVALID_COST', String(text));
  return iqd(Number(m[1]) * 1000 + Number((m[2] ?? '').padEnd(3, '0')));
}

export function formatMilli(milli) {
  const whole = Math.trunc(milli / 1000);
  const frac = Math.abs(milli % 1000);
  return frac ? `${whole}.${String(frac).padStart(3, '0').replace(/0+$/, '')}` : String(whole);
}

/** تكلفة كمية بوحدات أساسية بسعر مللي → دنانير صحيحة (نصف لأعلى) */
export const costOf = (qty, costMilli) => Number((BigInt(qty) * BigInt(costMilli) + 500n) / 1000n);

/** متوسط مرجح عند الاستلام (بالمللي)، رصيد سالب أو صفري يأخذ تكلفة الاستلام */
export function weightedCost(stock, costMilli, recvQty, recvCostMilli) {
  if (stock <= 0) return recvCostMilli;
  const total = BigInt(stock) * BigInt(costMilli) + BigInt(recvQty) * BigInt(recvCostMilli);
  const qty = BigInt(stock + recvQty);
  return Number((total * 2n + qty) / (2n * qty));
}
