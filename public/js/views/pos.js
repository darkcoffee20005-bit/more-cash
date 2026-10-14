// شاشة البيع: الأصناف ← التذكرة ← الدفع. الحساب للعرض بنفس كود الخادم (shared/calc.js).
import { calculateTicket, unitPrice } from '../../../shared/calc.js';
import { esc, money, parseAmount, pct, time } from '../../../shared/format.js';
import { del, get, post, uid } from '../api.js';
import { icon } from '../icons.js';
import { busy, can, closeModal, fail, field, modalFrame, on, openModal, render, set, state, toast } from '../ui.js';
import { printReceipt } from './receipts.js';

// ---------------------------------------------------------------- البيانات
export async function loadBootstrap() {
  const b = await get('/api/pos/bootstrap');
  state.settings = b.settings;
  state.catalog = b.catalog;
  state.shift = b.shift;
  state.ticketsCount = b.ticketsCount;
  if (!state.pos) state.pos = { categoryId: null, search: '', cart: emptyCart() };
}

function emptyCart() {
  return { lines: [], discountIds: [], customer: null, pointsRedeemed: 0, diningOption: state.settings?.diningOptions?.[0]?.id ?? null, ticket: null };
}

const itemById = (id) => state.catalog.items.find((i) => i.id === id);
const discountById = (id) => state.catalog.discounts.find((d) => d.id === id);
const modifierById = (id) => state.catalog.modifiers.find((m) => m.id === id);
const lineUnit = (l) => unitPrice(l.price, l.modifiers.map((m) => m.price));

export function cartTotals(cart = state.pos.cart) {
  if (!cart.lines.length) return { gross: 0, discountTotal: 0, net: 0, tax: 0, total: 0, lines: [], appliedDiscounts: [], lineDiscount: 0, ticketDiscount: 0, pointsDiscount: 0 };
  return calculateTicket(
    cart.lines.map((l) => ({ qty: l.qty, unitPrice: lineUnit(l), discounts: l.discountIds.map(discountById).filter(Boolean) })),
    { discounts: cart.discountIds.map(discountById).filter(Boolean), pointsRedeemed: cart.pointsRedeemed, tax: state.settings.tax },
  );
}

function safeTotals() {
  try { return cartTotals(); } catch { state.pos.cart.pointsRedeemed = 0; return cartTotals(); }
}

const discountLabel = (d) => (d.type === 'percent' ? pct(d.value) : money(d.value));

// ---------------------------------------------------------------- العرض
export const routes = {
  pos(s) {
    if (!s.catalog) return '<div class="page"><p class="muted">جارٍ تحميل القائمة…</p></div>';
    if (!s.shift) return shiftGate();
    return `<div class="pos">${catalogPane(s)}${ticketPane(s)}</div>`;
  },
};

function shiftGate() {
  if (!can('shift.manage')) {
    return `<div class="page"><div class="card pad empty">${icon('clock')}<h2>لا توجد وردية مفتوحة</h2><p>اطلب من المدير أو الكاشير فتح الوردية.</p></div></div>`;
  }
  return `<div class="page" style="max-width:560px"><form class="card pad stack" data-form="open-shift">
    <div class="row">${icon('clock')}<h2>فتح وردية جديدة</h2></div>
    <p class="muted">عدّ النقد الموجود في الدرج وأدخله. سيُحسب النقد المتوقع عند الإغلاق من هذا الرقم.</p>
    ${field('النقد في الدرج (د.ع)', '<input class="amount-input" name="startingCash" id="shift-start" inputmode="numeric" placeholder="0" autocomplete="off" autofocus>')}
    <button class="btn primary lg block" type="submit" ${state.busy ? 'disabled' : ''}>فتح الوردية</button>
  </form></div>`;
}

function catalogPane(s) {
  const { categoryId, search } = s.pos;
  const q = search.trim();
  const items = s.catalog.items.filter((i) => {
    if (q) return i.name.includes(q) || i.variants.some((v) => v.sku && v.sku.toLowerCase() === q.toLowerCase());
    return !categoryId || i.categoryId === categoryId;
  });
  const cats = [`<button class="chip cat-chip c-slate ${!categoryId && !q ? 'on' : ''}" data-action="pos-cat" data-id="">الكل</button>`,
    ...s.catalog.categories.map((c) => `<button class="chip cat-chip c-${c.color} ${categoryId === c.id && !q ? 'on' : ''}" data-action="pos-cat" data-id="${c.id}">${esc(c.name)}</button>`)];
  const tz = s.settings?.tzOffsetMin ?? 180;
  return `<section class="catalog" aria-label="الأصناف">
    <div class="catalog-head">
      <div class="pos-top"><h1>${esc(s.settings?.name ?? '')}</h1>
        ${s.shift ? `<span class="pill ok">${icon('clock', 'sm')} وردية #${s.shift.number}</span>` : ''}
        <span class="clock">${time(Date.now(), tz)}</span></div>
      <div class="search-box">${icon('search', 'sm')}<input type="search" id="pos-search" placeholder="ابحث باسم الصنف أو SKU" value="${esc(search)}" data-input="pos-search" autocomplete="off"></div>
      <div class="cats" role="tablist">${cats.join('')}</div>
    </div>
    <div class="tiles" data-keep-scroll="tiles">
      ${items.length ? items.map(tile).join('') : `<div class="empty" style="grid-column:1/-1">${icon('search')}<p>لا أصناف مطابقة</p></div>`}
    </div>
  </section>`;
}

function tile(item) {
  const prices = item.variants.map((v) => v.price);
  const min = Math.min(...prices);
  const out = item.variants.every((v) => v.available !== null && v.available <= 0);
  const low = !out && item.variants.some((v) => v.available !== null && v.available > 0 && v.available <= 3);
  const meta = [item.variants.length === 2 ? 'حجمان' : item.variants.length > 2 ? `${item.variants.length} أحجام` : item.variants[0].name, item.modifierIds.length ? 'إضافات' : ''].filter(Boolean).join(' · ');
  return `<button class="tile c-${item.color} ${out ? 'out' : ''}" data-action="pos-item" data-id="${item.id}">
    ${out ? '<span class="t-flag pill bad">نفد</span>' : low ? '<span class="t-flag pill warn">قليل</span>' : ''}
    <span class="t-name">${esc(item.name)}</span>
    ${meta ? `<span class="t-meta">${esc(meta)}</span>` : ''}
    <span class="t-price num">${prices.length > 1 && Math.max(...prices) !== min ? 'من ' : ''}${money(min)}</span>
  </button>`;
}

function ticketPane(s) {
  const cart = s.pos.cart;
  const t = safeTotals();
  const customer = cart.customer;
  const lines = cart.lines.map((l, i) => {
    const calc = t.lines[i];
    const sub = [l.variantName, ...l.modifiers.map((m) => m.name)].filter(Boolean).join(' · ');
    const discounted = calc && calc.discount > 0 && l.discountIds.length;
    return `<li class="line" data-action="pos-line" data-key="${l.key}" role="button" tabindex="0">
      <span class="qty-badge">${l.qty}</span>
      <div><div class="l-name">${esc(l.itemName)}</div>${sub ? `<div class="l-sub">${esc(sub)}</div>` : ''}
        ${l.note ? `<div class="l-sub">✎ ${esc(l.note)}</div>` : ''}
        ${l.discountIds.length ? `<div class="l-disc">${l.discountIds.map((d) => esc(discountById(d)?.name ?? '')).join('، ')}</div>` : ''}</div>
      <div class="l-total num">${discounted ? `<s>${money(calc.gross, { symbol: false })}</s>` : ''}${money(discounted ? calc.gross - calc.discount + 0 : lineUnit(l) * l.qty, { symbol: false })}</div>
    </li>`;
  }).join('');
  const ticketDiscNames = cart.discountIds.map((d) => discountById(d)?.name).filter(Boolean);
  const dining = s.settings.diningOptions;

  return `<aside class="ticket ${cart.lines.length ? '' : 'is-empty'}" aria-label="التذكرة">
    <div class="ticket-head">
      <div class="ticket-title">
        <h2>${cart.ticket ? esc(cart.ticket.name) : 'طلب جديد'}</h2>
        <span class="spacer"></span>
        ${s.settings.features.openTickets && can('pos.tickets') ? `<button class="btn sm" data-action="pos-tickets">${icon('ticket', 'sm')} التذاكر${s.ticketsCount ? ` (${s.ticketsCount})` : ''}</button>` : ''}
        <button class="icon-btn" data-action="pos-clear" title="مسح الطلب" ${cart.lines.length ? '' : 'disabled'}>${icon('trash', 'sm')}</button>
      </div>
      <div class="ticket-meta">
        <select id="pos-dining" data-change="pos-dining" aria-label="نوع الطلب">${dining.map((d) => `<option value="${d.id}" ${cart.diningOption === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>
        <button class="customer-chip ${customer ? 'set' : ''}" data-action="pos-customer">${icon('user', 'sm')} ${customer ? `${esc(customer.name)} · ${customer.points} نقطة` : 'إضافة عميل'}</button>
      </div>
    </div>
    <ul class="lines" data-keep-scroll="lines">${lines || `<li class="empty">${icon('cup')}<p>اختر مشروباً لبدء الطلب</p></li>`}</ul>
    <div class="totals">
      <div class="t-row"><span>المجموع</span><span class="num">${money(t.gross)}</span></div>
      ${t.lineDiscount || t.ticketDiscount ? `<div class="t-row disc"><span>الخصم${ticketDiscNames.length ? ` (${esc(ticketDiscNames.join('، '))})` : ''}</span><span class="num">−${money(t.lineDiscount + t.ticketDiscount)}</span></div>` : ''}
      ${t.pointsDiscount ? `<div class="t-row disc"><span>استبدال نقاط</span><span class="num">−${money(t.pointsDiscount)}</span></div>` : ''}
      ${t.tax ? `<div class="t-row"><span>${esc(s.settings.tax.name)} ${s.settings.tax.mode === 'included' ? '(مشمولة)' : ''}</span><span class="num">${money(t.tax)}</span></div>` : ''}
    </div>
    <div class="ticket-actions">
      <div class="row">
        <button class="btn" data-action="pos-discounts" ${cart.lines.length && can('pos.discount') && s.catalog.discounts.length ? '' : 'disabled'}>${icon('tag', 'sm')} خصم</button>
        ${s.settings.features.openTickets && can('pos.tickets') ? `<button class="btn" data-action="pos-save" ${cart.lines.length && !s.busy ? '' : 'disabled'}>${icon('save', 'sm')} ${cart.ticket ? 'تحديث' : 'حفظ'}</button>` : ''}
      </div>
      <button class="btn primary lg block charge" data-action="pos-charge" ${cart.lines.length && !s.busy ? '' : 'disabled'}>
        <span>دفع</span><span class="amount num">${money(t.total)}</span>
      </button>
    </div>
  </aside>`;
}

// ---------------------------------------------------------------- النوافذ
export const modals = {
  item(s) {
    const m = s.modal;
    const item = itemById(m.itemId);
    const variant = item.variants.find((v) => v.id === m.variantId);
    const groups = item.modifierIds.map(modifierById).filter(Boolean);
    const chosen = groups.flatMap((g) => g.options.filter((o) => m.options.includes(o.id)));
    const unit = unitPrice(variant.price, chosen.map((o) => o.price));
    const missing = groups.filter((g) => g.required && !g.options.some((o) => m.options.includes(o.id)));
    const body = `
      ${item.variants.length > 1 ? `<div class="opt-group"><h3>الحجم</h3><div class="opts">${item.variants.map((v) => `
        <button class="opt ${v.id === variant.id ? 'on' : ''}" data-action="item-variant" data-id="${v.id}">
          <span>${esc(v.name)}</span><small>${money(v.price)}${v.available !== null && v.available <= 0 ? ' · نفد' : ''}</small></button>`).join('')}</div></div>` : ''}
      ${groups.map((g) => `<div class="opt-group"><h3>${esc(g.name)} ${g.required ? '<span class="pill petrol">إلزامي</span>' : '<span class="pill">اختياري</span>'}${g.selection === 'multi' ? '<span class="muted small">أكثر من خيار</span>' : ''}</h3>
        <div class="opts">${g.options.map((o) => `<button class="opt ${m.options.includes(o.id) ? 'on' : ''}" data-action="item-option" data-group="${g.id}" data-id="${o.id}">
          <span>${esc(o.name)}</span><small>${o.price ? `+${money(o.price)}` : 'بلا إضافة'}</small></button>`).join('')}</div></div>`).join('')}
      <div class="row wrap"><h3 style="margin-inline-end:auto">الكمية</h3>
        <div class="stepper"><button data-action="item-qty" data-d="-1" aria-label="إنقاص">−</button><span>${m.qty}</span><button data-action="item-qty" data-d="1" aria-label="زيادة">+</button></div></div>
      ${field('ملاحظة للباريستا', `<input id="item-note" maxlength="120" value="${esc(m.note ?? '')}" data-input="item-note" placeholder="مثلاً: حار جداً، بدون رغوة">`)}`;
    const foot = `${m.lineKey ? `<button class="btn danger" data-action="item-remove">${icon('trash', 'sm')} حذف</button>` : ''}
      <button class="btn primary lg" data-action="item-save" ${missing.length ? 'disabled' : ''}>${missing.length ? `اختر ${esc(missing[0].name)}` : `${m.lineKey ? 'حفظ' : 'إضافة'} · ${money(unit * m.qty)}`}</button>`;
    return modalFrame({ title: item.name, body, foot, cls: 'wide' });
  },

  line(s) {
    const line = s.pos.cart.lines.find((l) => l.key === s.modal.key);
    if (!line) return '';
    const item = itemById(line.itemId);
    const editable = item && (item.variants.length > 1 || item.modifierIds.length);
    const discounts = s.catalog.discounts.filter((d) => !d.restricted || can('pos.discount_restricted'));
    const body = `
      <div class="row wrap"><h3 style="margin-inline-end:auto">الكمية</h3>
        <div class="stepper"><button data-action="line-qty" data-d="-1">−</button><span>${line.qty}</span><button data-action="line-qty" data-d="1">+</button></div></div>
      ${field('ملاحظة', `<input id="line-note" maxlength="120" value="${esc(line.note ?? '')}" data-input="line-note">`)}
      ${can('pos.discount') && discounts.length ? `<div class="opt-group"><h3>خصم على هذا الصنف</h3><div class="opts">${discounts.map((d) => `
        <button class="opt ${line.discountIds.includes(d.id) ? 'on' : ''}" data-action="line-discount" data-id="${d.id}"><span>${esc(d.name)}</span><small>${discountLabel(d)}${d.restricted ? ' · مقيد' : ''}</small></button>`).join('')}</div></div>` : ''}
      ${editable ? `<button class="btn" data-action="line-edit">${icon('edit', 'sm')} تغيير الحجم أو الإضافات</button>` : ''}`;
    return modalFrame({ title: line.itemName, sub: esc([line.variantName, ...line.modifiers.map((m) => m.name)].filter(Boolean).join(' · ')), body,
      foot: `<button class="btn danger" data-action="line-remove">${icon('trash', 'sm')} حذف الصنف</button><button class="btn primary" data-action="close-modal">تم</button>` });
  },

  discounts(s) {
    const cart = s.pos.cart;
    const list = s.catalog.discounts.filter((d) => !d.restricted || can('pos.discount_restricted'));
    return modalFrame({ title: 'خصم على الطلب', body: `<div class="opts">${list.map((d) => `
      <button class="opt ${cart.discountIds.includes(d.id) ? 'on' : ''}" data-action="ticket-discount" data-id="${d.id}">
        <span>${esc(d.name)}</span><small>${discountLabel(d)}${d.restricted ? ' · يتطلب مديراً' : ''}</small></button>`).join('')}</div>
      <p class="muted small">النسبة تُحسب على المجموع بعد خصومات الأصناف، ثم يُطرح الخصم الثابت. يوزَّع الخصم على الأصناف لحساب الأرباح بدقة.</p>`,
    foot: '<button class="btn primary" data-action="close-modal">تم</button>' });
  },

  customer(s) {
    const m = s.modal;
    const cart = s.pos.cart;
    const loyalty = s.settings.loyalty?.enabled;
    const current = cart.customer;
    const list = (m.results ?? []).map((c) => `<tr class="click" data-action="customer-pick" data-id="${c.id}">
      <td><b>${esc(c.name)}</b><div class="muted small">${esc(c.phone ?? '')}</div></td>
      <td class="num">${c.visits} زيارة</td><td class="num">${loyalty ? `${c.points} نقطة` : ''}</td></tr>`).join('');
    const body = current ? `
      <div class="card pad row wrap"><div class="avatar">${esc(current.name.slice(0, 1))}</div>
        <div><b>${esc(current.name)}</b><div class="muted small">${current.points} نقطة متاحة</div></div><span class="spacer"></span>
        <button class="btn sm danger" data-action="customer-remove">إزالة</button></div>
      ${loyalty && current.points > 0 ? `<form class="stack" data-form="customer-points">
        ${field('استبدال نقاط (1 نقطة = 1 د.ع)', `<input class="amount-input" name="points" id="cust-points" inputmode="numeric" value="${cart.pointsRedeemed || ''}" placeholder="0">`, `بحد أقصى ${Math.min(current.points, cartTotals({ ...cart, pointsRedeemed: 0 }).net)} نقطة`)}
        <button class="btn olive" type="submit">${icon('star', 'sm')} تطبيق</button></form>` : ''}`
      : `<div class="search-box">${icon('search', 'sm')}<input type="search" id="cust-search" placeholder="اسم العميل أو رقم الهاتف" value="${esc(m.search ?? '')}" data-input="customer-search" autofocus autocomplete="off"></div>
      ${list ? `<div class="table-wrap"><table><tbody>${list}</tbody></table></div>` : `<p class="muted small">${m.search ? 'لا نتائج' : 'ابحث، أو أضف عميلاً جديداً'}</p>`}
      <form class="card pad stack" data-form="customer-create"><h3>عميل جديد</h3>
        <div class="grid-2">${field('الاسم', '<input name="name" id="cust-name" required minlength="2" maxlength="50">')}${field('الهاتف', '<input name="phone" id="cust-phone" inputmode="tel" maxlength="20" dir="ltr">')}</div>
        <button class="btn" type="submit">${icon('plus', 'sm')} إضافة وربط بالطلب</button></form>`;
    return modalFrame({ title: 'العميل', body, cls: 'wide' });
  },

  tickets(s) {
    const list = s.modal.list;
    const rows = list === undefined ? '<p class="muted">جارٍ التحميل…</p>' : list.length ? `<div class="table-wrap"><table>
      <thead><tr><th>التذكرة</th><th>الأصناف</th><th>آخر تعديل</th><th class="num">الإجمالي</th><th></th></tr></thead><tbody>
      ${list.map((t) => `<tr class="click" data-action="ticket-open" data-id="${t.id}"><td><b>${esc(t.name)}</b>${t.note ? `<div class="muted small">${esc(t.note)}</div>` : ''}</td>
        <td class="num">${t.lines.reduce((a, l) => a + l.qty, 0)}</td><td class="muted small">${esc(t.updatedBy ?? '')}</td><td class="num">${money(t.displayTotal)}</td>
        <td>${can('pos.void_saved') ? `<button class="icon-btn" data-action="ticket-delete" data-id="${t.id}" aria-label="حذف التذكرة">${icon('trash', 'sm')}</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`
      : `<div class="empty">${icon('ticket')}<p>لا توجد تذاكر محفوظة</p></div>`;
    return modalFrame({ title: 'التذاكر المفتوحة', body: rows, cls: 'wide' });
  },

  'save-ticket'(s) {
    const cart = s.pos.cart;
    return modalFrame({ title: 'حفظ التذكرة', body: `<form class="stack" data-form="ticket-save" id="ticket-form">
      ${field('اسم التذكرة', `<input name="name" id="ticket-name" required maxlength="40" value="${esc(cart.ticket?.name ?? '')}" placeholder="طاولة 3، أو اسم العميل" autofocus>`)}
      <div class="row wrap">${['طاولة 1', 'طاولة 2', 'طاولة 3', 'طاولة 4', 'سفري'].map((n) => `<button type="button" class="chip" data-action="ticket-name" data-name="${n}">${n}</button>`).join('')}</div>
      ${field('ملاحظة', '<input name="note" id="ticket-note" maxlength="120">')}
      <button class="btn primary lg" type="submit" ${s.busy ? 'disabled' : ''}>حفظ</button></form>` });
  },

  pay(s) {
    const m = s.modal;
    if (m.stage === 'done') return doneView(m);
    const total = m.total;
    const paid = m.payments.reduce((a, p) => a + p.amount, 0);
    const remaining = total - paid;
    const types = s.settings.paymentTypes.filter((p) => p.active);
    const type = types.find((p) => p.id === m.typeId) ?? types[0];
    const isCash = type.kind === 'cash';
    const amount = parseAmount(m.amountText) ?? remaining;
    const tendered = parseAmount(m.tenderedText) ?? amount;
    const quick = [...new Set([remaining, Math.ceil(remaining / 1000) * 1000, Math.ceil(remaining / 5000) * 5000, Math.ceil(remaining / 10000) * 10000, 25000, 50000].filter((x) => x >= remaining))].slice(0, 4);
    const valid = Number.isSafeInteger(amount) && amount > 0 && amount <= remaining && (!isCash || (Number.isSafeInteger(tendered) && tendered >= amount));
    return `<div class="modal full" role="dialog" aria-modal="true" aria-label="الدفع" data-stop><div class="pay">
      <section class="pay-side">
        <div class="row"><button class="icon-btn" style="color:#fff" data-action="close-modal" aria-label="رجوع">${icon('arrow')}</button><span class="label" style="color:#b8bf98">${s.pos.cart.ticket ? esc(s.pos.cart.ticket.name) : 'طلب جديد'}</span></div>
        <div><div class="due-label">المستحق</div><div class="due num">${money(total)}</div></div>
        <div class="pay-summary">${s.pos.cart.lines.map((l) => `<div><span>${l.qty}× ${esc(l.itemName)}${l.variantName ? ` ${esc(l.variantName)}` : ''}</span><span class="num">${money(lineUnit(l) * l.qty, { symbol: false })}</span></div>`).join('')}
          ${s.pos.cart.customer ? `<div><span>${icon('user', 'sm')} ${esc(s.pos.cart.customer.name)}</span></div>` : ''}</div>
        ${m.payments.length ? `<div class="split">${m.payments.map((p, i) => `<div class="split-row"><span>${esc(p.typeName)}</span><span class="num">${money(p.amount)}</span>
          <button class="icon-btn" style="width:28px;height:28px;color:#dde2c8" data-action="pay-remove" data-i="${i}" aria-label="حذف الدفعة">${icon('x', 'sm')}</button></div>`).join('')}
          <div class="row"><span>المتبقي</span><span class="spacer"></span><span class="remaining num">${money(remaining)}</span></div></div>` : ''}
        <div class="spacer"></div>
        <p class="small" style="color:#b8bf98">التقسيم: غيّر المبلغ إلى جزء من المستحق ثم أضف الدفعة، وأكمل الباقي بطريقة أخرى.</p>
      </section>
      <section class="pay-main">
        <div class="pay-types">${types.map((p) => `<button class="pay-type ${p.id === type.id ? 'on' : ''}" data-action="pay-type" data-id="${p.id}">${icon(p.kind === 'cash' ? 'cash' : p.kind === 'card' ? 'card' : 'wallet')} ${esc(p.name)}</button>`).join('')}</div>
        <div class="grid-2">
          ${field('المبلغ لهذه الدفعة', `<input class="amount-input" id="pay-amount" inputmode="numeric" value="${esc(m.amountText ?? String(remaining))}" data-input="pay-amount" autocomplete="off">`)}
          ${isCash ? field('المستلم من العميل', `<input class="amount-input" id="pay-tendered" inputmode="numeric" value="${esc(m.tenderedText ?? '')}" placeholder="${money(amount, { symbol: false })}" data-input="pay-tendered" autocomplete="off" autofocus>`) : field('رقم المرجع (اختياري)', '<input id="pay-ref" maxlength="40" dir="ltr" autocomplete="off">')}
        </div>
        ${isCash ? `<div class="quick">${quick.map((q) => `<button data-action="pay-quick" data-v="${q}">${money(q, { symbol: false })}</button>`).join('')}</div>
          <div class="row"><span class="muted">الباقي للعميل</span><span class="spacer"></span><b class="num" style="font-size:1.3rem">${Number.isSafeInteger(tendered) && tendered >= amount ? money(tendered - amount) : '—'}</b></div>` : ''}
        <div class="spacer"></div>
        ${amount < remaining ? `<button class="btn lg block" data-action="pay-add" ${valid ? '' : 'disabled'}>${icon('plus', 'sm')} إضافة دفعة ${money(Number.isSafeInteger(amount) ? amount : 0)}</button>` : ''}
        <button class="btn primary lg block" data-action="pay-confirm" ${(valid && amount === remaining) || (remaining === 0) ? '' : 'disabled'} ${s.busy ? 'disabled' : ''}>${s.busy ? 'جارٍ الحفظ…' : `${icon('check', 'sm')} تأكيد الدفع`}</button>
      </section></div></div>`;
  },
};

function doneView(m) {
  const change = m.receipt.payments.reduce((a, p) => a + (p.change ?? 0), 0);
  return `<div class="modal" role="dialog" aria-modal="true" aria-label="تم الدفع" data-stop><div class="done">
    <div class="tick">${icon('check')}</div>
    <h2>تم الدفع · إيصال #${m.receipt.number}</h2>
    ${change ? `<div><div class="muted">الباقي للعميل</div><div class="change num">${money(change)}</div></div>` : `<p class="muted">${money(m.receipt.totals.total)}</p>`}
    ${m.receipt.pointsEarned ? `<span class="pill olive">${icon('star', 'sm')} +${m.receipt.pointsEarned} نقطة لـ ${esc(m.receipt.customerName)}</span>` : ''}
    <div class="row" style="width:100%"><button class="btn lg" style="flex:1" data-action="pay-print">${icon('print', 'sm')} طباعة</button>
      <button class="btn primary lg" style="flex:1.4" data-action="pay-new" autofocus>طلب جديد</button></div>
  </div></div>`;
}

// ---------------------------------------------------------------- الإجراءات
function cartLineFrom({ item, variant, optionIds, qty, note, discountIds = [], key }) {
  const mods = item.modifierIds.map(modifierById).filter(Boolean).flatMap((g) => g.options.filter((o) => optionIds.includes(o.id)));
  return {
    key: key ?? uid(), itemId: item.id, itemName: item.name, variantId: variant.id, variantName: variant.name, price: variant.price,
    modifiers: mods.map((o) => ({ id: o.id, name: o.name, price: o.price })), qty, note: note || '', discountIds,
  };
}

function addToCart(line) {
  const cart = state.pos.cart;
  const same = cart.lines.find((l) => l.variantId === line.variantId && !l.note && !line.note && !l.discountIds.length
    && l.modifiers.map((m) => m.id).sort().join() === line.modifiers.map((m) => m.id).sort().join());
  if (same) same.qty += line.qty;
  else cart.lines.push(line);
}

function defaultOptions(item) {
  // الإضافة الإلزامية ذات الاختيار الواحد: يُختار أول خيار تلقائياً (مثل الحليب الكامل)
  return item.modifierIds.map(modifierById).filter((g) => g && g.required && g.selection === 'single').map((g) => g.options[0]?.id).filter(Boolean);
}

on({
  'open-shift': (_el, _e, data) => busy(async () => {
    const startingCash = parseAmount(data.startingCash) ?? 0;
    if (!Number.isSafeInteger(startingCash)) throw new Error('أدخل مبلغاً صحيحاً بالدينار');
    state.shift = await post('/api/shifts/open', { startingCash });
    toast('فُتحت الوردية', 'ok');
  }),
  'pos-search': (el) => { state.pos.search = el.value; render(); },
  'pos-cat': (el) => { state.pos.categoryId = el.dataset.id || null; state.pos.search = ''; render(); },
  'pos-item': (el) => {
    const item = itemById(el.dataset.id);
    if (item.variants.length === 1 && item.modifierIds.length === 0) {
      addToCart(cartLineFrom({ item, variant: item.variants[0], optionIds: [], qty: 1 }));
      return render();
    }
    return openModal({ type: 'item', itemId: item.id, variantId: item.variants[0].id, options: defaultOptions(item), qty: 1, note: '' });
  },
  'item-variant': (el) => { state.modal.variantId = el.dataset.id; render(); },
  'item-option': (el) => {
    const m = state.modal;
    const group = modifierById(el.dataset.group);
    const id = el.dataset.id;
    const inGroup = group.options.map((o) => o.id);
    if (m.options.includes(id)) {
      if (!(group.required && group.selection === 'single')) m.options = m.options.filter((x) => x !== id);
    } else if (group.selection === 'single') m.options = [...m.options.filter((x) => !inGroup.includes(x)), id];
    else m.options = [...m.options, id];
    render();
  },
  'item-qty': (el) => { state.modal.qty = Math.max(1, Math.min(999, state.modal.qty + Number(el.dataset.d))); render(); },
  'item-note': (el) => { state.modal.note = el.value; },
  'item-save': () => {
    const m = state.modal;
    const item = itemById(m.itemId);
    const variant = item.variants.find((v) => v.id === m.variantId);
    const cart = state.pos.cart;
    if (m.lineKey) {
      const idx = cart.lines.findIndex((l) => l.key === m.lineKey);
      cart.lines[idx] = cartLineFrom({ item, variant, optionIds: m.options, qty: m.qty, note: m.note, discountIds: cart.lines[idx].discountIds, key: m.lineKey });
    } else addToCart(cartLineFrom({ item, variant, optionIds: m.options, qty: m.qty, note: m.note }));
    closeModal();
  },
  'item-remove': () => { state.pos.cart.lines = state.pos.cart.lines.filter((l) => l.key !== state.modal.lineKey); closeModal(); },
  'pos-line': (el) => openModal({ type: 'line', key: el.dataset.key }),
  'line-qty': (el) => {
    const line = state.pos.cart.lines.find((l) => l.key === state.modal.key);
    line.qty = Math.max(1, Math.min(999, line.qty + Number(el.dataset.d)));
    render();
  },
  'line-note': (el) => { const line = state.pos.cart.lines.find((l) => l.key === state.modal.key); line.note = el.value.slice(0, 120); },
  'line-discount': (el) => {
    const line = state.pos.cart.lines.find((l) => l.key === state.modal.key);
    line.discountIds = line.discountIds.includes(el.dataset.id) ? line.discountIds.filter((d) => d !== el.dataset.id) : [...line.discountIds, el.dataset.id];
    render();
  },
  'line-remove': () => { state.pos.cart.lines = state.pos.cart.lines.filter((l) => l.key !== state.modal.key); closeModal(); },
  'line-edit': () => {
    const line = state.pos.cart.lines.find((l) => l.key === state.modal.key);
    openModal({ type: 'item', itemId: line.itemId, variantId: line.variantId, options: line.modifiers.map((m) => m.id), qty: line.qty, note: line.note, lineKey: line.key });
  },
  'pos-discounts': () => openModal({ type: 'discounts' }),
  'ticket-discount': (el) => {
    const cart = state.pos.cart;
    cart.discountIds = cart.discountIds.includes(el.dataset.id) ? cart.discountIds.filter((d) => d !== el.dataset.id) : [...cart.discountIds, el.dataset.id];
    render();
  },
  'pos-dining': (el) => { state.pos.cart.diningOption = el.value; },
  'pos-clear': () => {
    if (!state.view.confirmClear) {
      state.view.confirmClear = true;
      toast('اضغط مرة أخرى لمسح الطلب');
      setTimeout(() => { state.view.confirmClear = false; }, 2500);
      return;
    }
    state.view.confirmClear = false;
    state.pos.cart = emptyCart();
    render();
  },

  // ---- العميل
  'pos-customer': () => openModal({ type: 'customer', search: '', results: [] }),
  'customer-search': (el) => {
    const m = state.modal;
    m.search = el.value;
    clearTimeout(m.timer);
    m.timer = setTimeout(async () => {
      try { m.results = await get('/api/customers', { search: m.search }); render(); } catch (e) { fail(e); }
    }, 220);
  },
  'customer-pick': (el) => {
    const c = state.modal.results.find((x) => x.id === el.dataset.id);
    state.pos.cart.customer = { id: c.id, name: c.name, points: c.points };
    state.pos.cart.pointsRedeemed = 0;
    closeModal();
  },
  'customer-create': (_el, _e, data) => busy(async () => {
    const c = await post('/api/customers', { name: data.name, phone: data.phone || null });
    state.pos.cart.customer = { id: c.id, name: c.name, points: c.points };
    state.modal = null;
    toast(`أُضيف ${c.name}`, 'ok');
  }),
  'customer-remove': () => { state.pos.cart.customer = null; state.pos.cart.pointsRedeemed = 0; render(); },
  'customer-points': (_el, _e, data) => {
    const cart = state.pos.cart;
    const pts = parseAmount(data.points) ?? 0;
    const max = Math.min(cart.customer.points, cartTotals({ ...cart, pointsRedeemed: 0 }).net);
    if (!Number.isSafeInteger(pts) || pts < 0 || pts > max) { toast(`الحد الأقصى ${max} نقطة`, 'bad'); return; }
    cart.pointsRedeemed = pts;
    closeModal();
  },

  // ---- التذاكر المفتوحة
  'pos-tickets': async () => {
    openModal({ type: 'tickets' });
    try { state.modal.list = await get('/api/tickets'); render(); } catch (e) { fail(e); }
  },
  'pos-save': () => {
    if (state.pos.cart.ticket) return saveTicket({ name: state.pos.cart.ticket.name, note: state.pos.cart.ticket.note });
    return openModal({ type: 'save-ticket' });
  },
  'ticket-name': (el) => { document.getElementById('ticket-name').value = el.dataset.name; },
  'ticket-save': (_el, _e, data) => saveTicket(data),
  'ticket-open': (el) => {
    const t = state.modal.list.find((x) => x.id === el.dataset.id);
    const lines = [];
    let missing = 0;
    for (const l of t.lines) {
      const item = state.catalog.items.find((i) => i.variants.some((v) => v.id === l.variantId));
      if (!item) { missing += 1; continue; }
      const variant = item.variants.find((v) => v.id === l.variantId);
      lines.push(cartLineFrom({ item, variant, optionIds: l.modifierOptionIds, qty: l.qty, note: l.note, discountIds: l.discountIds }));
    }
    state.pos.cart = { lines, discountIds: t.discountIds, customer: null, pointsRedeemed: 0, diningOption: t.diningOption ?? state.settings.diningOptions[0].id,
      ticket: { id: t.id, version: t.version, name: t.name, note: t.note } };
    if (t.customerId) get(`/api/customers/${t.customerId}`).then((c) => { state.pos.cart.customer = { id: c.id, name: c.name, points: c.points }; render(); }).catch(() => {});
    if (missing) toast(`${missing} صنف لم يعد متوفراً وأُزيل من التذكرة`, 'bad');
    closeModal();
  },
  'ticket-delete': (el) => busy(async () => {
    if (state.modal.confirmDelete !== el.dataset.id) { state.modal.confirmDelete = el.dataset.id; toast('اضغط مرة أخرى لتأكيد حذف التذكرة'); return; }
    await del(`/api/tickets/${el.dataset.id}`);
    state.modal.list = state.modal.list.filter((t) => t.id !== el.dataset.id);
    state.ticketsCount = state.modal.list.length;
    if (state.pos.cart.ticket?.id === el.dataset.id) state.pos.cart = emptyCart();
  }),

  // ---- الدفع
  'pos-charge': () => {
    let total;
    try { total = cartTotals().total; } catch (e) { fail(e); return; }
    const cash = state.settings.paymentTypes.find((p) => p.active && p.kind === 'cash');
    openModal({ type: 'pay', stage: 'pay', total, payments: [], typeId: cash?.id, amountText: String(total), tenderedText: '', clientId: uid() });
  },
  'pay-type': (el) => { const m = state.modal; m.typeId = el.dataset.id; m.tenderedText = ''; render(); },
  'pay-amount': (el) => { state.modal.amountText = el.value; render(); },
  'pay-tendered': (el) => { state.modal.tenderedText = el.value; render(); },
  'pay-quick': (el) => { state.modal.tenderedText = el.dataset.v; render(); },
  'pay-add': () => {
    const m = state.modal;
    const p = currentPayment(m);
    if (!p) return;
    m.payments.push(p);
    const remaining = m.total - m.payments.reduce((a, x) => a + x.amount, 0);
    m.amountText = String(remaining);
    m.tenderedText = '';
    render();
  },
  'pay-remove': (el) => {
    const m = state.modal;
    m.payments.splice(Number(el.dataset.i), 1);
    m.amountText = String(m.total - m.payments.reduce((a, x) => a + x.amount, 0));
    render();
  },
  'pay-confirm': () => busy(async () => {
    const m = state.modal;
    const payments = [...m.payments];
    const remaining = m.total - payments.reduce((a, x) => a + x.amount, 0);
    if (remaining > 0) {
      const p = currentPayment(m);
      if (!p || p.amount !== remaining) throw new Error('أكمل المبلغ المتبقي');
      payments.push(p);
    }
    const cart = state.pos.cart;
    const body = {
      clientId: m.clientId,
      lines: cart.lines.map((l) => ({ variantId: l.variantId, qty: l.qty, modifierOptionIds: l.modifiers.map((x) => x.id), note: l.note || null, discountIds: l.discountIds })),
      discountIds: cart.discountIds, customerId: cart.customer?.id ?? null, pointsRedeemed: cart.pointsRedeemed,
      diningOption: cart.diningOption, ticketId: cart.ticket?.id ?? null, ticketName: cart.ticket?.name ?? null,
      clientTotal: m.total, payments: payments.map((p) => ({ typeId: p.typeId, amount: p.amount, tendered: p.tendered })),
    };
    const r = await post('/api/sales', body);
    state.modal = { type: 'pay', stage: 'done', receipt: r.receipt };
    if (cart.ticket) state.ticketsCount = Math.max(0, state.ticketsCount - 1);
    state.pos.cart = emptyCart();
    refreshAvailability();
  }),
  'pay-print': () => printReceipt(state.modal.receipt),
  'pay-new': () => closeModal(),
});

function currentPayment(m) {
  const type = state.settings.paymentTypes.find((p) => p.id === m.typeId);
  const remaining = m.total - m.payments.reduce((a, x) => a + x.amount, 0);
  const amount = parseAmount(m.amountText) ?? remaining;
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > remaining) { toast('مبلغ غير صالح', 'bad'); return null; }
  let tendered = amount;
  if (type.kind === 'cash') {
    tendered = parseAmount(m.tenderedText) ?? amount;
    if (!Number.isSafeInteger(tendered) || tendered < amount) { toast('المستلم أقل من المبلغ', 'bad'); return null; }
  }
  return { typeId: type.id, typeName: type.name, amount, tendered };
}

async function saveTicket(data) {
  await busy(async () => {
    const cart = state.pos.cart;
    const body = {
      id: cart.ticket?.id, version: cart.ticket?.version, name: data.name, note: data.note || null,
      lines: cart.lines.map((l) => ({ variantId: l.variantId, qty: l.qty, modifierOptionIds: l.modifiers.map((x) => x.id), discountIds: l.discountIds, note: l.note || null })),
      discountIds: cart.discountIds, customerId: cart.customer?.id ?? null, diningOption: cart.diningOption, displayTotal: cartTotals().total,
    };
    await post('/api/tickets', body);
    if (!cart.ticket) state.ticketsCount += 1;
    state.pos.cart = emptyCart();
    state.modal = null;
    toast(`حُفظت التذكرة: ${data.name}`, 'ok');
  });
}

async function refreshAvailability() {
  try { state.catalog = (await get('/api/pos/bootstrap')).catalog; render(); } catch { /* غير حرج */ }
}

export async function enter() {
  if (!state.catalog) await loadBootstrap();
  else {
    const b = await get('/api/pos/bootstrap');
    Object.assign(state, { settings: b.settings, catalog: b.catalog, shift: b.shift, ticketsCount: b.ticketsCount });
  }
}
