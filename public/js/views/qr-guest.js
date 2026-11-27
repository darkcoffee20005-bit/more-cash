// صفحة الزبون «اطلب من الطاولة» (#/q/<رمز الطاولة>): القائمة، اختيار الحجم والإضافات، السلة، الإرسال، وحالة الطلب.
// بلا حساب: معرّف عشوائي للجهاز في التخزين المحلي (يستخدمه الكاشير للحظر). الخادم يسعّر ويتحقق من شبكة المقهى.
import { unitPrice } from '../../../shared/calc.js';
import { esc, money } from '../../../shared/format.js';
import { get, post } from '../api.js';
import { icon } from '../icons.js';
import { mark } from '../brand.js';
import { itemEmoji } from '../emoji.js';
import { busy, on, render, state, toast } from '../ui.js';

const G = () => state.qrg ?? (state.qrg = { token: null, info: undefined, menu: undefined, error: null, cat: null, cart: [], sheet: null, review: false, orders: [], images: {}, clientId: null });
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
let spyOn = false;
function markCat(id) {
  document.querySelectorAll('.qg-cats button').forEach((b) => {
    const on = b.dataset.id === id;
    b.classList.toggle('on', on);
    // تمرير الشريط أفقياً فقط (scrollIntoView هنا يقطع تمرير الصفحة نحو القسم)
    if (on) { const bar = b.parentElement; bar.scrollTo({ left: b.offsetLeft - (bar.clientWidth - b.clientWidth) / 2, behavior: 'smooth' }); }
  });
}
/** القسم الظاهر يُعلَّم في شريط الأقسام أثناء التمرير (بلا إعادة رسم) */
function spy() {
  if (spyOn) return;
  const root = document.getElementById('app');
  if (!root) return;
  spyOn = true;
  let raf = 0;
  root.addEventListener('scroll', () => {
    if (raf || !location.hash.startsWith('#/q/')) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const bar = document.querySelector('.qg-cats');
      const top = (bar?.getBoundingClientRect().bottom ?? 0) + 8;
      let current = null;
      for (const sec of document.querySelectorAll('.qg-sec')) if (sec.getBoundingClientRect().top <= top + 40) current = sec.dataset.cat;
      current ??= document.querySelector('.qg-sec')?.dataset.cat;
      if (current && current !== G().activeCat) { G().activeCat = current; markCat(current); }
    });
  }, { passive: true });
}
export async function enterGuest(token) {
  spy();
  const g = G();
  if (g.token !== token) Object.assign(g, { token, info: undefined, menu: undefined, error: null, cart: [], orders: [], sheet: null, review: false });
  clearInterval(timer);
  await loadMenu();
  timer = setInterval(() => { if (location.hash.startsWith('#/q/')) loadStatus().catch(() => {}); else clearInterval(timer); }, 10_000);
}

// أولاً «info» (تعمل من أي شبكة): اسم المقهى والطاولة والواي فاي، ثم القائمة إن كان على شبكة المقهى
async function loadMenu() {
  const g = G();
  try {
    g.info = await get('/api/qr/info', { t: g.token });
    if (!g.info.enabled) throw Object.assign(new Error(), { code: 'QR_DISABLED' });
    if (!g.info.onNetwork) throw Object.assign(new Error(), { code: 'QR_NOT_ON_NETWORK' });
    g.menu = await get('/api/qr/menu', { t: g.token });
    g.error = null;
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

const STATUS = { pending: ['بانتظار تأكيد الكاشير', 'warn', 'clock'], accepted: ['انقبل وصار يتحضّر', 'ok', 'check'], rejected: ['ما انقبل', 'bad', 'x'] };

/** شاشة «مو على شبكة المقهى» وباقي الأسباب: مرتبة، بالسبب والخطوات */
function blockedView(g) {
  const info = g.info;
  const shop = info?.shop?.name ? `<div class="qg-brand">${mark()}<b>${esc(info.shop.name)}</b>${info.table?.name ? `<span>${info.table.takeaway ? 'طلب سفري' : esc(info.table.name)}</span>` : ''}</div>` : '';
  if (g.error === 'QR_NOT_ON_NETWORK') {
    return `<div class="qg qg-gate">${shop}
      <div class="qg-gate-card">
        <svg class="qg-wifi" viewBox="0 0 120 96" aria-hidden="true"><path d="M8 34a74 74 0 0 1 104 0" /><path d="M24 50a52 52 0 0 1 72 0" /><path d="M40 66a30 30 0 0 1 40 0" /><circle cx="60" cy="82" r="7" /></svg>
        <h1>اتصل بواي فاي المقهى حتى تطلب</h1>
        <p>حتى نضمن إنّ الطلبات تجي من داخل المقهى، الطلب من الموبايل يشتغل بس على شبكة ${info?.shop?.name ? `<b>${esc(info.shop.name)}</b>` : 'المقهى'}.</p>
        <ol class="qg-steps">
          <li><span>1</span><div>افتح <b>الإعدادات ← Wi-Fi</b> بموبايلك</div></li>
          <li><span>2</span><div>اختار شبكة ${info?.wifi ? `<b class="qg-ssid" dir="auto">${esc(info.wifi)}</b>` : '<b>المقهى</b> (اسألنا عن الاسم وكلمة السر)'}</div></li>
          <li><span>3</span><div>إذا مشغّل <b>بيانات الموبايل</b>، طفّيها شوية</div></li>
          <li><span>4</span><div>ارجع هنا واضغط «حاول مرة ثانية»</div></li>
        </ol>
        <button class="qg-btn" data-action="qg-retry">${icon('wifi', 'sm')} حاول مرة ثانية</button>
        <p class="qg-alt">تگدر تطلب من الكاشير مباشرة هم.</p>
      </div></div>`;
  }
  const [ic, title, text] = ERR[g.error] ?? ['alert', 'تعذّر تحميل القائمة', 'تأكد من الاتصال بالإنترنت وحاول مرة ثانية.'];
  return `<div class="qg qg-gate">${shop}<div class="qg-gate-card"><span class="qg-ic">${icon(ic)}</span><h1>${title}</h1><p>${text}</p>
    <button class="qg-btn" data-action="qg-retry">حاول مرة ثانية</button></div></div>`;
}

export function guestView() {
  const g = G();
  if (g.menu === undefined) return '<div class="qg qg-gate"><div class="qg-loading">جارٍ تحميل المنيو…</div></div>';
  if (!g.menu) return blockedView(g);
  const m = g.menu;
  const count = g.cart.reduce((a, l) => a + l.qty, 0);
  const cats = m.categories.filter((c) => m.items.some((i) => i.categoryId === c.id));
  const takeaway = m.table.takeaway;
  const row = (i) => {
    const out = i.variants.every((v) => v.soldOut);
    const prices = [...new Set(i.variants.filter((v) => !v.soldOut).map((v) => v.price))].sort((a, b) => a - b);
    const src = imgOf(i);
    const inCart = g.cart.filter((l) => l.itemName === i.name).reduce((a, l) => a + l.qty, 0);
    return `<button class="qg-row ${out ? 'out' : ''}" data-action="qg-open" data-id="${i.id}" ${out ? 'disabled' : ''}>
      <span class="qg-thumb" style="--c: var(--tile-${esc(i.color ?? 'olive')}, #0a7c55)">${src ? `<img src="${src}" alt="">` : `<span>${esc(itemEmoji(i, cats.find((c) => c.id === i.categoryId)?.name))}</span>`}${inCart ? `<i>${inCart}</i>` : ''}</span>
      <span class="qg-row-text"><b>${esc(i.name)}</b><small>${i.variants.length > 1 ? i.variants.map((v) => esc(v.name)).filter(Boolean).join(' · ') : ''}</small></span>
      <span class="qg-dots" aria-hidden="true"></span>
      <span class="qg-price">${out ? '<em>نفد</em>' : `${prices.length > 1 ? '<small>من</small> ' : ''}${money(prices[0])}`}</span></button>`;
  };
  return `<div class="qg">
    <header class="qg-hero">${mark()}<h1>${esc(m.shop.name)}</h1>
      <p class="qg-where">${takeaway ? `${icon('sale', 'sm')} طلب سفري — استلمه من الكاشير` : `${icon('table', 'sm')} ${esc(m.table.name)}`}</p>
      <p class="qg-how">اختار من المنيو، أضف للسلة، وأرسل. الدفع عند الكاشير.</p></header>
    ${g.orders.length ? `<section class="qg-orders">${g.orders.slice(0, 3).map((o) => `<div class="qg-order ${STATUS[o.status]?.[1] ?? ''}"><span class="qg-oi">${icon(STATUS[o.status]?.[2] ?? 'clock', 'sm')}</span><div><b>${STATUS[o.status]?.[0] ?? o.status}${o.number ? ` · رقم طلبك Q${o.number}` : ''}</b>
      <span>${o.lines.reduce((a, l) => a + l.qty, 0)} صنف · ${money(o.total)}${o.reason ? ` · ${esc(o.reason)}` : ''}</span></div></div>`).join('')}</section>` : ''}
    <nav class="qg-cats" aria-label="أقسام المنيو">${cats.map((c) => `<button class="${c.id === (g.activeCat ?? cats[0]?.id) ? 'on' : ''}" data-action="qg-cat" data-id="${c.id}">${esc(c.name)}</button>`).join('')}</nav>
    <main class="qg-menu">${cats.map((c) => `<section class="qg-sec" id="qg-sec-${c.id}" data-cat="${c.id}"><h2><span>${esc(c.name)}</span></h2>
      <div class="qg-rows">${m.items.filter((i) => i.categoryId === c.id).map(row).join('')}</div></section>`).join('')}
      <p class="qg-foot">${mark()} يعمل بـ مور كاش</p></main>
    ${count ? `<div class="qg-bar"><button data-action="qg-review"><span class="qg-count">${count}</span> عرض السلة <b>${money(cartTotal())}</b></button></div>` : ''}
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
      <input name="name" id="qg-name" maxlength="30" placeholder="${g.menu.table.takeaway ? 'اسمك (حتى نناديك من يجهز)' : 'اسمك (اختياري)'}" autocomplete="given-name" ${g.menu.table.takeaway ? 'required minlength="2"' : ''}>
      <input name="note" id="qg-onote" maxlength="200" placeholder="ملاحظة للطلب (اختياري)">
      <button class="qg-btn" type="submit" ${state.busy ? 'disabled' : ''}>أرسل الطلب · ${money(cartTotal())}</button>
      <p class="muted small">${g.menu.table.takeaway ? 'يوصل طلبك للكاشير، ونناديك باسمك من يجهز. الدفع عند الاستلام.' : 'يوصل طلبك للكاشير، ومن يقبله يبدأ التحضير. الدفع عند الكاشير.'}</p></form></section>`;
}

on({
  'qg-retry': () => { G().menu = undefined; render(); loadMenu(); },
  'qg-cat': (el) => {
    document.getElementById(`qg-sec-${el.dataset.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    G().activeCat = el.dataset.id;
    markCat(el.dataset.id);
  },
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
    if (g.menu.table.takeaway && String(d.name ?? '').trim().length < 2) { toast('اكتب اسمك حتى نناديك من يجهز طلبك', 'bad'); document.getElementById('qg-name')?.focus(); return; }
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
