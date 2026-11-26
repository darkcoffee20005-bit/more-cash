// صفحة الاشتراك للعميل: تفاصيل الاشتراك وبيانات التحويل (يتحكم بها المزوّد)، وطلب اشتراك بالتحويل (رقم ووصل) أو نقداً.
// تظهر بدل البرنامج للحساب الذي ينتظر الموافقة، ومن شريط التنبيه عند قرب الانتهاء أو بعده.
import { dateTime, esc, localDate } from '../../../shared/format.js';
import { get, post } from '../api.js';
import { icon } from '../icons.js';
import { mark } from '../brand.js';
import { busy, fail, field, on, render, state, toast } from '../ui.js';

const S = () => state.sub ?? (state.sub = { info: null, method: 'transfer', image: null });
const day = (d) => (d ? localDate(d, 180) : '');
const STATUS = {
  pending: ['بانتظار الموافقة', 'warn', 'حسابك جاهز، وينفتح البرنامج كامل بعد ما نستلم الاشتراك ونوافق عليه.'],
  active: ['مشترك', 'ok', ''], trial: ['تجريبي مجاني', 'olive', ''],
  expired: ['انتهى الاشتراك', 'bad', 'بياناتك وتقاريرك محفوظة وتقدر تقرأها، والبيع موقوف حتى التجديد.'],
};
const REQ = { pending: ['وصل طلبك وينتظر الموافقة', 'warn'], approved: ['تمت الموافقة', 'ok'], rejected: ['رُفض', 'bad'] };

export async function loadSubscription() {
  try { S().info = await get('/api/subscription'); } catch (e) { fail(e); }
  render();
}

/** شريط في أعلى البرنامج: قرب الانتهاء (للمالك)، أو بعده للجميع */
export function subscriptionBanner(s) {
  const st = s.shop?.subscription;
  if (!st || st.unlimited) return '';
  if (st.status === 'expired') return `<div class="sub-banner bad">${icon('alert', 'sm')} انتهى الاشتراك في ${day(st.until)}: التقارير متاحة والبيع موقوف. <button class="btn sm" data-action="sub-open">تجديد الاشتراك</button></div>`;
  if (st.daysLeft !== null && st.daysLeft <= 5 && s.employee?.role === 'owner') return `<div class="sub-banner warn">${icon('clock', 'sm')} ${st.status === 'trial' ? 'التجربة المجانية' : 'الاشتراك'} ينتهي خلال ${st.daysLeft} ${st.daysLeft === 1 ? 'يوم' : 'أيام'} (${day(st.until)}). <button class="btn sm" data-action="sub-open">تجديد</button></div>`;
  return '';
}

export function subscriptionView(s) {
  const sub = S();
  const info = sub.info;
  const st = info ?? s.shop?.subscription ?? { status: 'pending' };
  const [label, cls, hint] = STATUS[st.status] ?? STATUS.pending;
  const cfg = info?.config;
  const pendingReq = info?.requests?.find((r) => r.status === 'pending');
  const lastRejected = info?.requests?.[0]?.status === 'rejected' ? info.requests[0] : null;
  const canClose = st.status !== 'pending';
  if (!info && !sub.loading) { sub.loading = true; queueMicrotask(() => loadSubscription().finally(() => { sub.loading = false; })); }
  const methods = cfg?.methods ?? [];
  return `<div class="sub-page">
    <header class="sub-head">${mark()}<div style="flex:1"><h1>اشتراك مور كاش</h1><p style="margin:0">${esc(s.shop?.name ?? '')}</p></div>
      ${canClose ? `<button class="btn" data-action="sub-close">${icon('back', 'sm')} رجوع للبرنامج</button>` : `<button class="btn ghost on-dark" data-action="leave-ask">تسجيل خروج هذا الجهاز</button>`}</header>
    <div class="sub-body">
      <section class="card pad stack">
        <div class="row wrap"><h2 style="margin-inline-end:auto">حالة الحساب</h2><span class="pill ${cls}">${label}</span></div>
        ${st.until && st.status !== 'pending' ? `<p style="margin:0">${st.status === 'expired' ? 'انتهى في' : 'فعّال حتى'} <b>${day(st.until)}</b>${st.daysLeft ? ` · باقي ${st.daysLeft} يوم` : ''}</p>` : ''}
        ${hint ? `<p class="muted" style="margin:0">${hint}</p>` : ''}
        ${pendingReq ? `<div class="alert-low" style="background:#eef6e0;border-color:#c9d86b;color:#3f4d0f">${icon('check')}<div><b>وصل طلبك (${pendingReq.method === 'cash' ? 'دفع نقدي' : 'تحويل'})</b><div class="small">أُرسل ${dateTime(pendingReq.createdAt, 180)}. ننتظر تأكيد الدفع، وبعدها ينفتح البرنامج تلقائياً.</div></div></div>
          <button class="btn" data-action="sub-refresh">${icon('check', 'sm')} تحديث الحالة</button>` : ''}
        ${lastRejected && !pendingReq ? `<div class="alert-low">${icon('alert')}<div><b>لم يُقبل الطلب السابق</b><div class="small">${esc(lastRejected.decisionNote ?? '')}</div></div></div>` : ''}
      </section>
      <section class="card pad stack">
        <h2>تفاصيل الاشتراك</h2>
        ${cfg?.plans ? `<div><p class="sub-price" style="margin:0">${cfg.plans.month.toLocaleString('en-US')} د.ع <span style="font-size:.55em">شهرياً</span></p>
          <p class="muted" style="margin:4px 0 0">أو ${cfg.plans.year.toLocaleString('en-US')} د.ع سنوياً${cfg.plans.month * 12 > cfg.plans.year ? ` · توفّر ${(cfg.plans.month * 12 - cfg.plans.year).toLocaleString('en-US')} د.ع` : ''}</p></div>`
          : cfg?.price ? `<p class="sub-price">${esc(cfg.price)}</p>` : ''}
        ${cfg?.details ? `<p style="white-space:pre-line;margin:0">${esc(cfg.details)}</p>` : '<p class="muted">جارٍ التحميل…</p>'}
        ${methods.length ? `<h3 style="margin-top:6px">طرق الدفع</h3>${methods.map((m, i) => `<div class="sub-method"><div style="flex:1;min-width:0"><b>${esc(m.label)}</b>${m.holder ? `<div class="muted small">باسم ${esc(m.holder)}</div>` : ''}
          <div class="sub-number" dir="ltr">${esc(m.value)}</div></div><button class="btn sm" data-action="sub-copy" data-i="${i}">نسخ</button></div>`).join('')}` : ''}
        ${cfg?.whatsapp ? `<a class="btn" href="https://wa.me/${esc(cfg.whatsapp)}" target="_blank" rel="noopener">تواصل عبر واتساب</a>` : ''}
      </section>
      ${st.status === 'active' && (st.daysLeft ?? 99) > 5 && !pendingReq ? '' : `<section class="card pad stack">
        <h2>${st.status === 'pending' ? 'طلب الاشتراك' : 'طلب تجديد'}</h2>
        <div class="seg"><button type="button" class="${sub.method === 'transfer' ? 'on' : ''}" data-action="sub-method" data-k="transfer">دفعت بالتحويل</button>
          <button type="button" class="${sub.method === 'cash' ? 'on' : ''}" data-action="sub-method" data-k="cash">أدفع نقداً</button></div>
        <form class="stack" data-form="sub-submit" id="sub-form">
          ${field('رقم هاتفك للتواصل', '<input name="phone" id="sub-phone" required inputmode="tel" dir="ltr" maxlength="20" placeholder="07xxxxxxxxx">')}
          ${sub.method === 'transfer' ? `${field('رقم الحوالة أو العملية', '<input name="reference" id="sub-ref" maxlength="60" dir="ltr">', 'أو أرفق صورة الوصل')}
            <div class="row wrap"><label class="btn"><input type="file" accept="image/*" hidden data-change="sub-image" id="sub-image">${icon('camera', 'sm')} ${sub.image ? 'تغيير صورة الوصل' : 'صورة الوصل'}</label>
              ${sub.image ? `<img src="${sub.image.src}" alt="الوصل" style="height:64px;border-radius:8px">` : ''}</div>`
            : '<p class="muted small" style="margin:0">نتواصل معك على رقمك لاستلام المبلغ، وبعدها نفعّل الحساب.</p>'}
          ${field('ملاحظة (اختياري)', '<input name="note" id="sub-note" maxlength="300">')}
          <button class="btn primary lg" type="submit" ${s.busy ? 'disabled' : ''}>${pendingReq ? 'تحديث الطلب' : 'إرسال الطلب'}</button></form>
      </section>`}
    </div></div>`;
}

/** صورة الوصل: تُصغَّر لعرض 1400 بكسل كحد أقصى (JPEG) فتبقى مقروءة وصغيرة */
async function shrink(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const scale = Math.min(1, 1400 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * scale);
    c.height = Math.round(img.height * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    for (const q of [0.75, 0.6, 0.45]) {
      const src = c.toDataURL('image/jpeg', q);
      const data = src.split(',')[1];
      if (data.length <= 580_000) return { src, data, mediaType: 'image/jpeg' };
    }
    throw new Error('الصورة كبيرة جداً');
  } finally { URL.revokeObjectURL(url); }
}

on({
  'sub-open': () => { state.subPage = true; render(); loadSubscription(); },
  'sub-close': () => { state.subPage = false; render(); },
  'sub-refresh': () => busy(async () => {
    const st = await get('/api/state');
    state.shop = st.shop;
    await loadSubscription();
    if (['active', 'trial'].includes(st.shop?.subscription?.status)) { state.subPage = false; toast('تم تفعيل حسابك — أهلاً بك', 'ok'); }
    else toast('ما زال الطلب بانتظار الموافقة');
    render();
  }),
  'sub-method': (el) => { S().method = el.dataset.k; render(); },
  'sub-copy': async (el) => {
    const m = S().info?.config?.methods?.[Number(el.dataset.i)];
    if (!m) return;
    try { await navigator.clipboard.writeText(m.value); toast('نُسخ الرقم', 'ok'); } catch { toast('انسخه يدوياً', 'bad'); }
  },
  'sub-image': async (el) => {
    const file = el.files?.[0];
    if (!file) return;
    try { S().image = await shrink(file); render(); } catch (e) { toast(e.message || 'تعذّرت قراءة الصورة', 'bad'); }
  },
  'sub-submit': (_el, _e, d) => busy(async () => {
    const sub = S();
    const body = { method: sub.method, phone: d.phone, note: d.note || null };
    if (sub.method === 'transfer') {
      if (!d.reference && !sub.image) throw new Error('اكتب رقم الحوالة أو أرفق صورة الوصل');
      Object.assign(body, { reference: d.reference || null, ...(sub.image ? { image: sub.image.data, mediaType: sub.image.mediaType } : {}) });
    }
    sub.info = await post('/api/subscription/request', body);
    sub.image = null;
    toast('وصل طلبك — نراجعه ونفعّل حسابك', 'ok');
  }),
});
