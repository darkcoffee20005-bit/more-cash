// صفحة الزبون «اطلب من الطاولة» (#/q/<رمز الطاولة>): القائمة، اختيار الحجم والإضافات، السلة، الإرسال، وحالة الطلب.
// بلا حساب: معرّف عشوائي للجهاز في التخزين المحلي (يستخدمه الكاشير للحظر). الخادم يسعّر ويتحقق من شبكة المقهى.
import { unitPrice } from '../../../shared/calc.js';
import { esc, money } from '../../../shared/format.js';
import { get, post } from '../api.js';
import { icon } from '../icons.js';
import { mark } from '../brand.js';
import { itemEmoji } from '../emoji.js';
import { busy, on, render, state, toast } from '../ui.js';

const G = () => state.qrg ?? (state.qrg = { token: null, menu: undefined, error: null, cat: null, cart: [], sheet: null, review: false, orders: [], images: {}, clientId: null });
const uidv = () => crypto.randomUUID();
function guestId() {
  try {
    let g = localStorage.getItem('mc_guest');
    if (!g || !/^[A-Za-z0-9_-]{8,64}$/.test(g)) { g = uidv(); localStorage.setItem('mc_guest', g); }
    return g;
  } catch { return (G().gid ??= uidv()); }
}

const ERR = {
  QR_NOT_ON_NETWORK: ['wifi', 'اتصل بواي فاي المقهى', 'الطلب من الطاولة يشتغل بس من موبايل متصل بشبكة المقهى. اتصل بالواي فاي وارجع اضغط «حاول مرة ثانية».'],
  QR_DISABLED: ['alert', 'الطلب من الطاولة غير متاح الآن', 'تگدر تطلب من الكاشير مباشرة.'],
  QR_UNKNOWN_TABLE: ['table', 'هذا الرمز قديم', 'امسح الرمز الموجود على طاولتك من جديد، أو اسأل الكاشير.'],
  QR_BLOCKED: ['lock', 'ما تگدر تطلب من هذا الجهاز', 'تواصل ويا الكاشير.'],
  TOO_MANY_ATTEMPTS: ['clock', 'محاولات كثيرة', 'انتظر شوية وارجع حاول.'],
};

let timer = null;
export async function enterGuest(token) {
  const g = G();
  if (g.token !== token) Object.assign(g, { token, menu: undefined, error: null, cart: [], orders: [], sheet: null, review: false });
  clearInterval(timer);
  await loadMenu();
  timer = setInterval(() => { if (location.hash.startsWith('#/q/')) loadStatus().catch(() => {}); else clearInterval(timer); }, 10_000);
}

async function loadMenu() {
  const g = G();
  try {
    g.menu = await get('/api/qr/menu', { t: g.token });
    g.error = null;
    g.cat ??= g.menu.categories.find((c) => g.menu.items.some((i) => i.categoryId === c.id))?.id ?? null;
    loadStatus().catch(() => {});
    if (g.menu.items.some((i) => i.imageV)) get('/api/qr/images', { t: g.token }).then((im) => { g.images = im; render(); }).catch(() => {});
  } catch (e) { g.menu = null; g.error = e.code ?? 'NETWORK'; }
  render();
}
async function loadStatus() {
  const g = G();
  if (!g.menu) return;
  g.orders = await get('/api/qr/status', { t: g.token, g: guestId() });
  render();
}

const modsOf = (item) => (G().menu.modifiers ?? []).filter((m) => item.modifierIds.includes(m.id));
const lineTotal = (l) => unitPrice(l.price, l.options.map((o) => o.price)) * l.qty;
const cartTotal = () => G().cart.reduce((a, l) => a + lineTotal(l), 0);
const imgOf = (item) => { const im = G().images[item.id]; return im && im.v === item.imageV ? im.src : null; };

const STATUS = { pending: ['بانتظار تأكيد الكاشير', 'warn'], accepted: ['انقبل وصار يتحضّر', 'ok'], rejected: ['ما انقبل', 'bad'] };

export function guestView() {
  const g = G();
  if (g.menu === undefined) return '<div class="qg qg-center"><p class="muted">جارٍ تحميل القائمة…</p></div>';
  if (!g.menu) {
    const [ic, title, text] = ERR[g.error] ?? ['alert', 'تعذّر تحميل القائمة', 'تأكد من الاتصال وحاول مرة ثانية.'];
    return `<div class="qg qg-center"><div class="qg-msg"><span class="qg-ic">${icon(ic)}</span><h1>${title}</h1><p>${text}</p>
      <button class="qg-btn" data-action="qg-retry">حاول مرة ثانية</button></div></div>`;
  }
  const m = g.menu;
  const items = m.items.filter((i) => i.categoryId === g.cat);
  const count = g.cart.reduce((a, l) => a + l.qty, 0);
  return `<div class="qg">
    <header class="qg-head">${mark()}<div><b>${esc(m.shop.name)}</b><span>${icon('table', 'sm')} ${esc(m.table.name)}</span></div></header>
    ${g.orders.length ? `<section class="qg-orders">${g.orders.slice(0, 3).map((o) => `<div class="qg-order ${STATUS[o.status]?.[1] ?? ''}"><b>${STATUS[o.status]?.[0] ?? o.status}${o.number ? ` · #Q${o.number}` : ''}</b>
      <span>${o.lines.reduce((a, l) => a + l.qty, 0)} صنف · ${money(o.total)}${o.reason ? ` · ${esc(o.reason)}` : ''}</span></div>`).join('')}</section>` : ''}
    <nav class="qg-cats">${m.categories.filter((c) => m.items.some((i) => i.categoryId === c.id)).map((c) => `<button class="${g.cat === c.id ? 'on' : ''}" data-action="qg-cat" data-id="${c.id}">${esc(c.name)}</button>`).join('')}</nav>
    <main class="qg-items">${items.map((i) => {
      const out = i.variants.every((v) => v.soldOut);
      const from = Math.min(...i.variants.map((v) => v.price));
      const src = imgOf(i);
      return `<button class="qg-item ${out ? 'out' : ''}" data-action="qg-open" data-id="${i.id}" ${out ? 'disabled' : ''}>
        <span class="qg-pic" style="--c: var(--tile-${esc(i.color ?? 'olive')}, #0a7c55)">${src ? `<img src="${src}" alt="">` : `<span>${esc(itemEmoji(i, m.categories.find((c) => c.id === i.categoryId)?.name))}</span>`}</span>
        <span class="qg-name"><b>${esc(i.name)}</b><small>${out ? 'نفد' : `${i.variants.length > 1 ? 'من ' : ''}${money(from)}`}</small></span>
        <span class="qg-plus">${icon(out ? 'x' : 'plus', 'sm')}</span></button>`;
    }).join('') || '<p class="muted">لا أصناف هنا</p>'}</main>
    ${count ? `<div class="qg-bar"><button data-action="qg-review"><span class="qg-count">${count}</span> سلتك <b>${money(cartTotal())}</b></button></div>` : ''}
    ${g.sheet ? itemSheet(g) : ''}${g.review ? reviewSheet(g) : ''}
  </div>`;
}

function itemSheet(g) {
  const sh = g.sheet;
  const item = g.menu.items.find((i) => i.id === sh.itemId);
  const v = item.variants.find((x) => x.id === sh.variantId);
  const groups = modsOf(item);
  const opts = groups.flatMap((gr) => gr.options).filter((o) => sh.options.includes(o.id));
  const total = unitPrice(v.price, opts.map((o) => o.price)) * sh.qty;
  return `<div class="qg-scrim" data-action="qg-close"></div><section class="qg-sheet" role="dialog" aria-label="${esc(item.name)}">
    <header><b>${esc(item.name)}</b><button class="qg-x" data-action="qg-close" aria-label="إغلاق">${icon('x', 'sm')}</button></header>
    ${item.variants.length > 1 ? `<h3>الحجم</h3><div class="qg-choices">${item.variants.map((x) => `<button class="${x.id === sh.variantId ? 'on' : ''}" data-action="qg-variant" data-id="${x.id}" ${x.soldOut ? 'disabled' : ''}>${esc(x.name || 'عادي')}<small>${x.soldOut ? 'نفد' : money(x.price)}</small></button>`).join('')}</div>` : ''}
    ${groups.map((gr) => `<h3>${esc(gr.name)}${gr.required ? ' <span class="qg-req">مطلوب</span>' : gr.selection === 'single' ? '' : ' <span class="muted">(اختياري)</span>'}</h3>
      <div class="qg-choices">${gr.options.map((o) => `<button class="${sh.options.includes(o.id) ? 'on' : ''}" data-action="qg-opt" data-g="${gr.id}" data-id="${o.id}">${esc(o.name)}${o.price ? `<small>+${money(o.price)}</small>` : ''}</button>`).join('')}</div>`).join('')}
    <h3>ملاحظة</h3><input id="qg-note" maxlength="120" placeholder="مثلاً: سكر قليل" value="${esc(sh.note ?? '')}" data-input="qg-note">
    <footer><div class="qg-step"><button data-action="qg-qty" data-d="-1" aria-label="أقل">${icon('minus', 'sm')}</button><b>${sh.qty}</b><button data-action="qg-qty" data-d="1" aria-label="أكثر">${icon('plus', 'sm')}</button></div>
      <button class="qg-btn" data-action="qg-add">أضف للسلة · ${money(total)}</button></footer></section>`;
}

function reviewSheet(g) {
  return `<div class="qg-scrim" data-action="qg-close"></div><section class="qg-sheet" role="dialog" aria-label="سلتك">
    <header><b>سلتك</b><button class="qg-x" data-action="qg-close" aria-label="إغلاق">${icon('x', 'sm')}</button></header>
    <ul class="qg-cart">${g.cart.map((l, i) => `<li><div><b>${esc(l.itemName)}</b>${l.variantName ? ` <small>${esc(l.variantName)}</small>` : ''}
      ${l.options.length ? `<div class="muted small">${l.options.map((o) => esc(o.name)).join(' · ')}</div>` : ''}${l.note ? `<div class="small">✎ ${esc(l.note)}</div>` : ''}</div>
      <div class="qg-step sm"><button data-action="qg-line" data-i="${i}" data-d="-1" aria-label="أقل">${icon(l.qty > 1 ? 'minus' : 'trash', 'sm')}</button><b>${l.qty}</b><button data-action="qg-line" data-i="${i}" data-d="1" aria-label="أكثر">${icon('plus', 'sm')}</button></div>
      <b class="num">${money(lineTotal(l))}</b></li>`).join('')}</ul>
    <form data-form="qg-send" class="qg-form" data-keep>
      <input name="name" id="qg-name" maxlength="30" placeholder="اسمك (اختياري)" autocomplete="given-name">
      <input name="note" id="qg-onote" maxlength="200" placeholder="ملاحظة للطلب (اختياري)">
      <button class="qg-btn" type="submit" ${state.busy ? 'disabled' : ''}>أرسل الطلب · ${money(cartTotal())}</button>
      <p class="muted small">يوصل طلبك للكاشير، ومن يقبله يبدأ التحضير. الدفع عند الكاشير.</p></form></section>`;
}

on({
  'qg-retry': () => { G().menu = undefined; render(); loadMenu(); },
  'qg-cat': (el) => { G().cat = el.dataset.id; render(); },
  'qg-open': (el) => {
    const g = G();
    const item = g.menu.items.find((i) => i.id === el.dataset.id);
    const v = item.variants.find((x) => !x.soldOut) ?? item.variants[0];
    // الاختيار الأول من كل مجموعة مطلوبة جاهز مسبقاً
    const options = modsOf(item).filter((m) => m.required).map((m) => m.options[0]?.id).filter(Boolean);
    g.sheet = { itemId: item.id, variantId: v.id, options, qty: 1, note: '' };
    render();
  },
  'qg-close': () => { const g = G(); g.sheet = null; g.review = false; render(); },
  'qg-variant': (el) => { G().sheet.variantId = el.dataset.id; render(); },
  'qg-opt': (el) => {
    const g = G();
    const gr = g.menu.modifiers.find((m) => m.id === el.dataset.g);
    const sh = g.sheet;
    const id = el.dataset.id;
    if (gr.selection === 'single') {
      const others = gr.options.map((o) => o.id);
      const had = sh.options.includes(id);
      sh.options = sh.options.filter((x) => !others.includes(x));
      if (!had || gr.required) sh.options.push(id);
    } else sh.options = sh.options.includes(id) ? sh.options.filter((x) => x !== id) : [...sh.options, id];
    render();
  },
  'qg-note': (el) => { if (G().sheet) G().sheet.note = el.value; },
  'qg-qty': (el) => { const sh = G().sheet; sh.qty = Math.min(20, Math.max(1, sh.qty + Number(el.dataset.d))); render(); },
  'qg-add': () => {
    const g = G();
    const sh = g.sheet;
    const item = g.menu.items.find((i) => i.id === sh.itemId);
    const missing = modsOf(item).find((m) => m.required && !m.options.some((o) => sh.options.includes(o.id)));
    if (missing) { toast(`اختر ${missing.name}`, 'bad'); return; }
    const v = item.variants.find((x) => x.id === sh.variantId);
    const options = modsOf(item).flatMap((m) => m.options).filter((o) => sh.options.includes(o.id));
    g.cart.push({ variantId: v.id, itemName: item.name, variantName: v.name, price: v.price, options, qty: sh.qty, note: sh.note?.trim() || null });
    g.sheet = null;
    toast('انضاف للسلة', 'ok');
    render();
  },
  'qg-review': () => { G().review = true; G().clientId ??= uidv(); render(); },
  'qg-line': (el) => {
    const g = G();
    const l = g.cart[Number(el.dataset.i)];
    l.qty += Number(el.dataset.d);
    if (l.qty <= 0) g.cart.splice(Number(el.dataset.i), 1);
    else l.qty = Math.min(20, l.qty);
    if (!g.cart.length) g.review = false;
    render();
  },
  'qg-send': (_el, _e, d) => busy(async () => {
    const g = G();
    g.clientId ??= uidv();
    try {
      await post('/api/qr/order', {
        t: g.token, guestId: guestId(), clientId: g.clientId, name: d.name || null, note: d.note || null,
        lines: g.cart.map((l) => ({ variantId: l.variantId, qty: l.qty, modifierOptionIds: l.options.map((o) => o.id), note: l.note })),
      });
    } catch (e) {
      if (ERR[e.code]) { g.menu = null; g.error = e.code; render(); return; }
      throw e;
    }
    Object.assign(g, { cart: [], review: false, clientId: null });
    toast('وصل طلبك للكاشير', 'ok');
    await loadStatus();
  }),
});
