// لوحة الإدارة (Back Office): المتابعة، التقارير، الأصناف، التصنيفات، الإضافات، الخصومات، المخزون، الموظفون، الورديات، الإعدادات.
import { formatMilli } from '../../../shared/calc.js';
import { dateTime, esc, localDate, money, parseAmount, pct } from '../../../shared/format.js';
import { ROLES } from '../../../shared/perms.js';
import { del, get, post, put, uid } from '../api.js';
import { icon } from '../icons.js';
import { accountCard, loadAccount } from './account.js';
import { printHtml } from './receipts.js';
import { busy, can, fail, field, modalFrame, on, openModal, render, state, toast } from '../ui.js';

const COLORS = { olive: 'أخضر', petrol: 'أخضر داكن', sage: 'مريمية', teal: 'نعناعي', sand: 'ذهبي', clay: 'طيني', mocha: 'موكا', slate: 'رمادي' };
const SECTIONS = [
  ['dashboard', 'المتابعة', 'chart', 'admin.reports'],
  ['daily', 'التقرير اليومي', 'receipt', 'admin.reports'],
  ['reports', 'التقارير', 'list', 'admin.reports'],
  ['shifts', 'الورديات', 'clock', 'admin.reports'],
  ['audit', 'سجل العمليات', 'list', 'admin.settings'],
  ['items', 'الأصناف', 'cup', 'admin.catalog'],
  ['categories', 'التصنيفات', 'layers', 'admin.catalog'],
  ['modifiers', 'الإضافات', 'plus', 'admin.catalog'],
  ['discounts', 'الخصومات', 'tag', 'admin.catalog'],
  ['inventory', 'المخزون', 'box', 'admin.inventory'],
  ['employees', 'الموظفون', 'users', 'admin.employees'],
  ['settings', 'الإعدادات', 'gear', 'admin.settings'],
];

const tz = () => state.settings?.tzOffsetMin ?? 180;
const A = () => state.view.admin ?? (state.view.admin = {});

export const routes = {
  admin(s) {
    const sub = s.params.sub || SECTIONS.find(([, , , p]) => can(p))?.[0];
    const nav = `<nav class="admin-nav" aria-label="أقسام الإدارة"><span class="label">الإدارة</span>
      ${SECTIONS.filter(([, , , p]) => can(p)).map(([k, label, ic]) => `<a href="#/admin/${k}" class="${sub === k ? 'on' : ''}">${icon(ic, 'sm')} ${label}${k === 'inventory' && A().lowCount ? `<span class="count pill warn">${A().lowCount}</span>` : ''}</a>`).join('')}</nav>`;
    const body = (PAGES[sub] ?? (() => ''))(s, A());
    return `<div class="admin">${nav}<div class="page">${body}</div></div>`;
  },
};

// ---------------------------------------------------------------- رسوم بيانية بسيطة (SVG بمقياس واحد)
function barChart(values, labels, { height = 200, highlight = -1, fmt = (v) => money(v, { symbol: false }) } = {}) {
  const w = 600;
  const pad = { t: 18, b: 28, l: 6, r: 6 };
  const max = Math.max(1, ...values);
  const nice = niceMax(max);
  const bw = (w - pad.l - pad.r) / values.length;
  const y = (v) => pad.t + (height - pad.t - pad.b) * (1 - v / nice);
  const grid = [0.5, 1].map((f) => `<line class="grid-line" x1="${pad.l}" x2="${w - pad.r}" y1="${y(nice * f)}" y2="${y(nice * f)}"/><text x="${w - pad.r}" y="${y(nice * f) - 3}" text-anchor="start">${fmt(nice * f)}</text>`).join('');
  const bars = values.map((v, i) => {
    const h = Math.max(v > 0 ? 2 : 0, height - pad.b - y(v));
    return `<rect class="bar ${i === highlight ? 'now' : ''}" x="${pad.l + i * bw + bw * 0.18}" y="${height - pad.b - h}" width="${bw * 0.64}" height="${h}" rx="3"><title>${esc(labels[i])}: ${fmt(v)}</title></rect>`;
  }).join('');
  const step = Math.ceil(values.length / 12);
  const xl = labels.map((l, i) => (i % step === 0 ? `<text x="${pad.l + i * bw + bw / 2}" y="${height - 8}" text-anchor="middle">${esc(l)}</text>` : '')).join('');
  return `<div class="chart"><svg viewBox="0 0 ${w} ${height}" role="img" aria-label="رسم بياني">${grid}${bars}${xl}</svg></div>`;
}
function niceMax(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}

function delta(now, before) {
  if (!before) return now ? '<span class="delta up">جديد اليوم</span>' : '<span class="delta muted">—</span>';
  const d = Math.round(((now - before) / Math.abs(before)) * 100);
  return `<span class="delta ${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '▲' : '▼'} ${Math.abs(d)}% عن أمس</span>`;
}

// ---------------------------------------------------------------- الصفحات
const PAGES = {
  audit(s, a) {
    const groups = [['', 'الكل'], ['receipt', 'الاسترجاع'], ['discount', 'الخصومات'], ['inventory', 'المخزون'], ['item', 'الأصناف والأسعار'], ['shift', 'الورديات والنقد'], ['ticket', 'التذاكر'], ['employee', 'الموظفون'], ['settings', 'الإعدادات']];
    const presets = [['today', 'اليوم'], ['week', '7 أيام'], ['month', 'هذا الشهر']];
    const rows = a.audit;
    return `<div class="page-head"><h1>سجل العمليات</h1><span class="muted small">كل عملية حساسة مع الموظف ووقتها. لا يمكن تعديل السجل أو حذفه.</span></div>
      <div class="toolbar"><div class="seg">${presets.map(([k, l]) => `<button class="${a.auditPreset === k ? 'on' : ''}" data-action="audit-preset" data-k="${k}">${l}</button>`).join('')}</div></div>
      <div class="row wrap">${groups.map(([k, l]) => `<button class="chip ${(a.auditGroup ?? '') === k ? 'on' : ''}" data-action="audit-group" data-k="${k}">${l}</button>`).join('')}</div>
      <div class="table-wrap"><table><thead><tr><th>الوقت</th><th>الموظف</th><th>العملية</th><th>التفاصيل</th></tr></thead>
      <tbody>${rows === undefined || rows === null ? '<tr><td colspan="4" class="muted">جارٍ التحميل…</td></tr>'
        : rows.length ? rows.map((x) => `<tr class="${AUDIT_WARN.has(x.action) ? 'audit-warn' : ''}"><td class="small">${dateTime(x.at, tz())}</td><td>${esc(x.byName ?? '—')}</td>
          <td><b>${esc(AUDIT_LABELS[x.action] ?? x.action)}</b></td><td class="small">${auditDetails(x)}</td></tr>`).join('')
        : '<tr><td colspan="4" class="muted">لا عمليات في هذه الفترة</td></tr>'}</tbody></table></div>`;
  },

  daily(s, a) {
    const d = a.daily;
    const head = `<div class="page-head"><h1>التقرير اليومي</h1>
      <div class="row wrap"><input type="date" id="daily-date" value="${esc(a.dailyDate ?? '')}" data-change="daily-date" aria-label="اليوم" style="width:auto">
        <button class="btn" data-action="daily-share" ${d ? '' : 'disabled'}>${icon('arrow', 'sm')} مشاركة</button>
        <button class="btn primary" data-action="daily-print" ${d ? '' : 'disabled'}>${icon('print', 'sm')} طباعة</button></div></div>`;
    if (!d) return `${head}<p class="muted">جارٍ التحميل…</p>`;
    const sm = d.summary;
    const kpi = (label, value, sub = '') => `<div class="kpi"><span class="muted small">${label}</span><b>${value}</b>${sub ? `<span class="muted small">${sub}</span>` : ''}</div>`;
    return `${head}
      <div class="kpis">
        ${kpi('صافي المبيعات', money(sm.net), `${sm.salesCount} إيصال`)}
        ${kpi('متوسط الفاتورة', money(sm.avgSale))}
        ${kpi('الربح الإجمالي', money(sm.profit), sm.net ? `هامش ${Math.round((sm.profit / sm.net) * 100)}%` : '')}
        ${kpi('تكلفة الموارد المصروفة', money(d.consumptionCost))}
      </div>
      <div class="grid-2" style="align-items:start">
        <section class="card pad stack"><h2>طرق الدفع</h2>
          ${d.byPayment.length ? d.byPayment.map((p) => `<div class="r-line"><span>${esc(p.label)} <span class="muted small">${p.count} عملية</span></span><span class="num">${money(p.net)}</span></div>`).join('') : '<p class="muted">لا مدفوعات</p>'}
          ${sm.refundsCount ? `<div class="r-line"><span>المرتجعات <span class="muted small">${sm.refundsCount}</span></span><span class="num">${neg(sm.refunds)}</span></div>` : ''}
          ${sm.discounts ? `<div class="r-line"><span>الخصومات</span><span class="num">${neg(sm.discounts)}</span></div>` : ''}</section>
        <section class="card pad stack"><h2>الأصناف المباعة</h2>
          ${d.byItem.length ? `<div class="table-wrap"><table><thead><tr><th>الصنف</th><th class="num">الكمية</th><th class="num">الصافي</th></tr></thead><tbody>
            ${d.byItem.map((i) => `<tr><td>${esc(i.label)}</td><td class="num">${i.qty - i.refundedQty}</td><td class="num">${money(i.net)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">لا مبيعات</p>'}</section>
      </div>
      <section class="card pad stack"><h2>الموارد المصروفة اليوم</h2>
        <p class="muted small">محسوبة من الكميات التقريبية في وصفة كل صنف، ومطروحة من المخزون تلقائياً مع كل بيع.</p>
        ${d.consumption.length ? `<div class="table-wrap"><table><thead><tr><th>المادة</th><th class="num">المصروف</th><th class="num">الهدر</th><th class="num">المتبقي</th><th class="num">التكلفة</th></tr></thead><tbody>
          ${d.consumption.map((c) => `<tr><td>${esc(c.name)} ${c.ingredient ? '<span class="pill olive">مكون</span>' : ''}</td><td class="num">${qty(c.used, c.unit)}</td><td class="num">${c.loss ? qty(c.loss, c.unit) : '—'}</td>
            <td class="num"><span class="${c.low ? 'pill warn' : ''}">${qty(c.stock, c.unit)}</span></td><td class="num">${money(c.cost)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">لم يُصرف شيء من المخزون في هذا اليوم</p>'}
      </section>
      ${d.lowStock.length ? `<section class="card pad stack"><h2>${icon('alert', 'sm')} مواد تحت حد التنبيه</h2>
        <div class="row wrap">${d.lowStock.map((c) => `<span class="pill warn">${esc(c.name)}: ${qty(c.stock, c.unit)}</span>`).join('')}</div></section>` : ''}`;
  },

  dashboard(s, a) {
    const d = a.dashboard;
    if (!d) return '<p class="muted">جارٍ التحميل…</p>';
    const t = d.todaySummary;
    const y = d.yesterdaySummary;
    const hourNow = new Date(Date.now() + tz() * 60000).getUTCHours();
    const hours = d.byHour.slice(6, 24);
    const topMax = Math.max(1, ...d.topItems.map((i) => i.net));
    return `<div class="page-head"><h1>اليوم في ${esc(s.settings?.name ?? '')}</h1><span class="muted">${d.today}</span></div>
      <div class="kpis">
        <div class="kpi lead"><span class="label">صافي المبيعات</span><b>${money(t.net)}</b>${delta(t.net, y.net)}</div>
        <div class="kpi"><span class="label">الإيصالات</span><b class="num">${t.salesCount}</b>${delta(t.salesCount, y.salesCount)}</div>
        <div class="kpi"><span class="label">متوسط الفاتورة</span><b>${money(t.avgSale)}</b>${delta(t.avgSale, y.avgSale)}</div>
        <div class="kpi"><span class="label">الربح الإجمالي</span><b>${money(t.profit)}</b><span class="muted small">بعد تكلفة المكونات ${money(t.cogs)}</span></div>
      </div>
      <div class="row wrap">
        ${d.openShift ? `<span class="pill ok">${icon('clock', 'sm')} وردية #${d.openShift.number} مفتوحة · ${esc(d.openShift.openedByName)}</span>` : '<span class="pill">لا وردية مفتوحة</span>'}
        ${d.openTickets ? `<span class="pill petrol">${d.openTickets} تذكرة مفتوحة</span>` : ''}
        ${d.lowStock ? `<a class="pill warn" href="#/admin/inventory">${icon('alert', 'sm')} ${d.lowStock} مادة تحت حد المخزون</a>` : ''}
        ${t.refundsCount ? `<span class="pill bad">${t.refundsCount} استرجاع · ${money(t.refunds)}</span>` : ''}
      </div>
      <div class="split-view">
        <section class="card pad stack"><h2>المبيعات حسب الساعة</h2>${barChart(hours.map((h) => h.net), hours.map((h) => `${h.hour}`), { highlight: hourNow - 6 })}</section>
        <section class="card pad stack"><h2>آخر 7 أيام</h2>${barChart(d.week.map((x) => x.net), d.week.map((x) => x.key.slice(5)), { highlight: 6 })}</section>
      </div>
      <div class="split-view">
        <section class="card pad stack"><h2>الأكثر مبيعاً اليوم</h2>
          ${d.topItems.length ? d.topItems.map((i) => `<div class="stack" style="gap:4px"><div class="r-line"><span>${esc(i.label)} <span class="muted small">× ${i.qty - i.refundedQty}</span></span><span class="num">${money(i.net)}</span></div>
            <div class="meter"><i style="width:${Math.round((i.net / topMax) * 100)}%"></i></div></div>`).join('') : '<p class="muted">لا مبيعات بعد</p>'}</section>
        <section class="card pad stack"><h2>طرق الدفع</h2>
          ${d.byPayment.length ? d.byPayment.map((p) => `<div class="r-line"><span>${esc(p.label)} <span class="muted small">${p.count} عملية</span></span><span class="num">${money(p.net)}</span></div>`).join('') : '<p class="muted">لا مدفوعات بعد</p>'}</section>
      </div>`;
  },

  reports(s, a) {
    const r = a.report;
    const tab = a.reportTab ?? 'items';
    const presets = [['today', 'اليوم'], ['yesterday', 'أمس'], ['week', '7 أيام'], ['month', 'هذا الشهر'], ['lastmonth', 'الشهر الماضي']];
    const TABS = { items: 'الأصناف', categories: 'التصنيفات', employees: 'الموظفون', payments: 'طرق الدفع', modifiers: 'الإضافات', discounts: 'الخصومات', dining: 'نوع الطلب', days: 'الأيام' };
    const sm = r?.summary;
    const head = `<div class="page-head"><h1>التقارير</h1>
      ${globalThis.MORECASH_BACKEND ? '' : `<button class="btn sm" data-action="report-csv" ${r ? '' : 'disabled'}>`}${globalThis.MORECASH_BACKEND ? '' : `${icon('download', 'sm')} تصدير CSV</button>`}</div>
      <div class="toolbar"><div class="seg">${presets.map(([k, l]) => `<button class="${a.preset === k ? 'on' : ''}" data-action="report-preset" data-k="${k}">${l}</button>`).join('')}</div>
        <input type="date" id="rp-from" value="${esc(a.from ?? '')}" data-change="report-from" aria-label="من"><input type="date" id="rp-to" value="${esc(a.to ?? '')}" data-change="report-to" aria-label="إلى"></div>`;
    if (!r) return `${head}<p class="muted">جارٍ التحميل…</p>`;
    const summary = `<div class="table-wrap"><table><tbody>
      <tr><td>إجمالي المبيعات</td><td class="num">${money(sm.gross)}</td><td>الإيصالات</td><td class="num">${sm.salesCount}</td></tr>
      <tr><td>المرتجعات</td><td class="num">${neg(sm.refunds)}</td><td>عمليات الاسترجاع</td><td class="num">${sm.refundsCount}</td></tr>
      <tr><td>الخصومات</td><td class="num">${neg(sm.discounts)}</td><td>متوسط الفاتورة</td><td class="num">${money(sm.avgSale)}</td></tr>
      <tr><td><b>صافي المبيعات</b></td><td class="num"><b>${money(sm.net)}</b></td><td>صافي النقد</td><td class="num">${money(sm.cashNet)}</td></tr>
      <tr><td>تكلفة البضاعة</td><td class="num">${neg(sm.cogs)}</td><td>الضريبة</td><td class="num">${money(sm.tax)}</td></tr>
      <tr><td><b>الربح الإجمالي</b></td><td class="num"><b>${money(sm.profit)}</b></td><td>هامش الربح</td><td class="num">${sm.net ? `${Math.round((sm.profit / sm.net) * 100)}%` : '—'}</td></tr>
    </tbody></table></div>`;
    const table = reportTable(tab, r);
    return `${head}${summary}
      <div class="seg" style="overflow-x:auto;max-width:100%">${Object.entries(TABS).map(([k, l]) => `<button class="${tab === k ? 'on' : ''}" data-action="report-tab" data-k="${k}">${l}</button>`).join('')}</div>
      <div class="table-wrap">${table}</div>`;
  },

  shifts(s, a) {
    const list = a.shifts;
    return `<div class="page-head"><h1>الورديات</h1></div>
      <div class="table-wrap"><table><thead><tr><th>#</th><th>الفتح</th><th>الإغلاق</th><th class="num">المتوقع</th><th class="num">الفعلي</th><th class="num">الفرق</th><th class="num">صافي المبيعات</th><th>ملاحظة</th></tr></thead>
      <tbody>${(list ?? []).map((x) => `<tr><td class="num">${x.number}</td><td class="small">${dateTime(x.openedAt, tz())}<div class="muted">${esc(x.openedByName)}</div></td>
        <td class="small">${x.closedAt ? `${dateTime(x.closedAt, tz())}<div class="muted">${esc(x.closedByName)}</div>` : '<span class="pill ok">مفتوحة</span>'}</td>
        <td class="num">${x.summary ? money(x.summary.expectedCash) : '—'}</td><td class="num">${x.actualCash !== undefined ? money(x.actualCash) : '—'}</td>
        <td class="num">${x.difference !== undefined ? `<span class="pill ${x.difference === 0 ? 'ok' : x.difference < 0 ? 'bad' : 'warn'}">${money(x.difference, { sign: true })}</span>` : '—'}</td>
        <td class="num">${x.summary ? money(x.summary.net) : '—'}</td><td class="small">${esc(x.note ?? '')}</td></tr>`).join('') || `<tr><td colspan="8" class="muted">${list ? 'لا ورديات' : 'جارٍ التحميل…'}</td></tr>`}</tbody></table></div>`;
  },

  items(s, a) {
    const items = a.items;
    const cats = new Map((a.categories ?? []).map((c) => [c.id, c]));
    const f = a.itemFilter ?? 'sale';
    const q = (a.itemSearch ?? '').trim();
    const list = (items ?? []).filter((i) => (f === 'sale' ? i.forSale : !i.forSale) && (!q || i.name.includes(q)));
    return `<div class="page-head"><h1>الأصناف</h1><button class="btn primary" data-action="item-new">${icon('plus', 'sm')} صنف جديد</button></div>
      <div class="toolbar"><div class="seg"><button class="${f === 'sale' ? 'on' : ''}" data-action="items-filter" data-f="sale">للبيع</button><button class="${f === 'ing' ? 'on' : ''}" data-action="items-filter" data-f="ing">المكونات</button></div>
        <input type="search" id="it-search" placeholder="بحث" value="${esc(q)}" data-input="items-search"></div>
      <div class="table-wrap"><table><thead><tr><th>الصنف</th><th>${f === 'sale' ? 'التصنيف' : 'الوحدة'}</th><th>الأحجام</th><th class="num">${f === 'sale' ? 'السعر' : 'التكلفة/وحدة'}</th><th class="num">المخزون</th></tr></thead>
      <tbody>${list.map((i) => `<tr class="click" data-action="item-edit" data-id="${i.id}">
        <td><span class="row"><span class="swatch-dot c-${i.color}" style="width:14px;height:14px;border-radius:4px;background:var(--c);display:inline-block"></span><b>${esc(i.name)}</b></span></td>
        <td>${f === 'sale' ? esc(cats.get(i.categoryId)?.name ?? '—') : esc(i.unit ?? '')}</td>
        <td class="small">${i.variants.map((v) => esc(v.name || '—')).join('، ')}</td>
        <td class="num">${f === 'sale' ? i.variants.map((v) => money(v.price, { symbol: false })).join(' / ') : `${formatMilli(i.variants[0]?.costMilli ?? 0)} د.ع`}</td>
        <td class="num">${i.variants.map((v) => (v.recipe?.length ? '<span class="pill">وصفة</span>' : v.trackStock ? `<span class="pill ${v.stock <= v.lowStock ? 'warn' : ''}">${v.stock}</span>` : '—')).join(' ')}</td></tr>`).join('')
        || `<tr><td colspan="5"><div class="empty">${icon('cup')}<p>${items ? 'لا أصناف' : 'جارٍ التحميل…'}</p></div></td></tr>`}</tbody></table></div>`;
  },

  categories(s, a) {
    return simpleList('التصنيفات', 'category', a.categories, ['الاسم', 'اللون', 'الترتيب'],
      (c) => [`<b>${esc(c.name)}</b>${c.active === false ? ' <span class="pill">مؤرشف</span>' : ''}`, `<span class="pill c-${c.color}" style="background:var(--c);color:#fff">${COLORS[c.color]}</span>`, `<span class="num">${c.sort}</span>`]);
  },
  modifiers(s, a) {
    return simpleList('الإضافات', 'modifier', (a.modifiers ?? []).filter((m) => m.active !== false), ['المجموعة', 'النوع', 'الخيارات'],
      (m) => [`<b>${esc(m.name)}</b>${m.required ? ' <span class="pill petrol">إلزامي</span>' : ''}`, m.selection === 'single' ? 'خيار واحد' : 'متعدد',
        `<span class="small">${m.options.map((o) => `${esc(o.name)}${o.price ? ` (+${money(o.price, { symbol: false })})` : ''}`).join('، ')}</span>`]);
  },
  discounts(s, a) {
    return simpleList('الخصومات', 'discount', (a.discounts ?? []).filter((d) => d.active !== false), ['الخصم', 'القيمة', 'القيود'],
      (d) => [`<b>${esc(d.name)}</b>`, `<span class="num">${d.type === 'percent' ? pct(d.value) : money(d.value)}</span>`, d.restricted ? '<span class="pill warn">يتطلب مديراً</span>' : '<span class="muted">—</span>']);
  },

  inventory(s, a) {
    const inv = a.inventory;
    if (!inv) return '<p class="muted">جارٍ التحميل…</p>';
    const f = a.invFilter ?? 'all';
    const rows = inv.rows.filter((r) => f === 'all' || (f === 'low' ? r.low : f === 'ing' ? r.ingredient : !r.ingredient));
    return `<div class="page-head"><h1>المخزون</h1><span class="muted">قيمة المخزون ${money(inv.totalValue)}</span>
        <div class="row wrap">
          <button class="btn primary" data-action="rcv-open">${icon('plus', 'sm')} استلام مشتريات</button>
          <label class="btn"><input type="file" accept="image/*" capture="environment" hidden data-change="rcv-scan" id="rcv-file">${icon('camera', 'sm')} تصوير فاتورة</label>
          <button class="btn sm ghost" data-action="inv-reconcile">${icon('check', 'sm')} مطابقة مع الدفتر</button></div></div>
      ${inv.lowCount ? `<div class="alert-low" role="alert">${icon('alert')}<div><b>${inv.lowCount} ${inv.lowCount === 1 ? 'مادة' : 'مواد'} تحت حد التنبيه</b>
        <div class="small">${inv.rows.filter((r) => r.low).map((r) => `${esc(r.name)}: ${r.stock.toLocaleString('en-US')} ${esc(r.unit)}`).join(' · ')}</div></div></div>` : ''}
      <div class="toolbar"><div class="seg">${[['all', 'الكل'], ['low', `تحت الحد (${inv.lowCount})`], ['ing', 'المكونات'], ['goods', 'أصناف جاهزة']].map(([k, l]) => `<button class="${f === k ? 'on' : ''}" data-action="inv-filter" data-f="${k}">${l}</button>`).join('')}</div></div>
      <div class="table-wrap"><table><thead><tr><th>المادة</th><th class="num">الرصيد</th><th class="num">حد التنبيه</th><th class="num">التكلفة/وحدة</th><th class="num">القيمة</th><th></th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td><b>${esc(r.name)}</b> ${r.ingredient ? '<span class="pill olive">مكون</span>' : ''}</td>
        <td class="num"><span class="pill ${r.stock <= 0 ? 'bad' : r.low ? 'warn' : 'ok'}">${r.stock.toLocaleString('en-US')} ${esc(r.unit)}</span></td>
        <td class="num">${r.lowStock.toLocaleString('en-US')}</td><td class="num">${formatMilli(r.costMilli)}</td><td class="num">${money(r.value)}</td>
        <td><div class="row" style="justify-content:flex-end"><button class="btn sm" data-action="inv-adjust" data-id="${r.variantId}">تعديل</button>
          <button class="icon-btn" data-action="inv-history" data-id="${r.variantId}" aria-label="السجل">${icon('list', 'sm')}</button></div></td></tr>`).join('')
        || '<tr><td colspan="6" class="muted">لا مواد</td></tr>'}</tbody></table></div>
      <p class="muted small">كل حركة (بيع، استلام، هدر، جرد) تُسجَّل في دفتر لا يُعدَّل. المشروبات تخصم مكوناتها حسب الوصفة لحظة البيع.</p>`;
  },

  employees(s, a) {
    return simpleList('الموظفون', 'employee', a.employees, ['الاسم', 'الدور', 'الحالة'],
      (e) => [`<span class="row"><span class="avatar" style="width:32px;height:32px;font-size:.8rem">${esc(e.name.slice(0, 1))}</span><b>${esc(e.name)}</b></span>`,
        `<span class="pill ${e.role === 'owner' ? 'petrol' : e.role === 'manager' ? 'olive' : ''}">${ROLES[e.role]}</span>`, e.active ? '<span class="pill ok">فعال</span>' : '<span class="pill">معطّل</span>']);
  },

  settings(s, a) {
    const st = a.settings;
    if (!st) return '<p class="muted">جارٍ التحميل…</p>';
    return `<div class="page-head"><h1>الإعدادات</h1></div>
      <form class="stack" data-form="settings-save">
        <section class="card pad stack"><h2>المقهى والإيصال</h2>
          <div class="grid-3">${field('الاسم', `<input name="name" id="st-name" required value="${esc(st.name)}">`)}${field('العنوان', `<input name="address" id="st-address" value="${esc(st.address)}">`)}${field('الهاتف', `<input name="phone" id="st-phone" dir="ltr" value="${esc(st.phone)}">`)}</div>
          <div class="grid-2">${field('ترويسة الإيصال', `<input name="header" id="st-header" value="${esc(st.receipt.header)}">`)}${field('تذييل الإيصال', `<input name="footer" id="st-footer" value="${esc(st.receipt.footer)}">`)}</div>
          <label class="check"><input type="checkbox" name="showCustomer" ${st.receipt.showCustomer ? 'checked' : ''}> إظهار اسم العميل على الإيصال</label></section>
        <section class="card pad stack"><h2>الضريبة والولاء والنقد</h2>
          <div class="grid-3">
            ${field('الضريبة', `<select name="taxMode" id="st-tax-mode"><option value="none" ${st.tax.mode === 'none' ? 'selected' : ''}>بلا ضريبة</option><option value="added" ${st.tax.mode === 'added' ? 'selected' : ''}>مضافة على السعر</option><option value="included" ${st.tax.mode === 'included' ? 'selected' : ''}>مشمولة في السعر</option></select>`)}
            ${field('نسبة الضريبة %', `<input name="taxRate" id="st-tax-rate" inputmode="decimal" value="${st.tax.rateBp / 100}">`)}
            ${field('اسم الضريبة', `<input name="taxName" id="st-tax-name" value="${esc(st.tax.name)}">`)}
          </div>
          <div class="grid-3">
            <label class="check"><input type="checkbox" name="loyaltyEnabled" ${st.loyalty.enabled ? 'checked' : ''}> برنامج النقاط</label>
            ${field('نسبة النقاط %', `<input name="loyaltyRate" id="st-loyalty" inputmode="decimal" value="${st.loyalty.rateBp / 100}">`, 'من المبلغ المدفوع. 1 نقطة = 1 د.ع عند الاستبدال')}
            ${field('تنبيه فرق الصندوق (د.ع)', `<input name="cashVarianceAlert" id="st-var" inputmode="numeric" value="${st.cashVarianceAlert}">`, 'فوقه تُطلب ملاحظة عند الإغلاق')}
          </div></section>
        <section class="card pad stack"><h2>طرق الدفع</h2>
          ${st.paymentTypes.map((p, i) => `<div class="row wrap"><input name="pt_name_${i}" id="pt-name-${i}" value="${esc(p.name)}" style="flex:1;min-width:140px" aria-label="اسم طريقة الدفع">
            <select name="pt_kind_${i}" id="pt-kind-${i}" style="width:auto" aria-label="النوع"><option value="cash" ${p.kind === 'cash' ? 'selected' : ''}>نقد (يدخل الدرج)</option><option value="card" ${p.kind === 'card' ? 'selected' : ''}>بطاقة</option><option value="other" ${p.kind === 'other' ? 'selected' : ''}>محفظة/أخرى</option></select>
            <label class="check"><input type="checkbox" name="pt_active_${i}" ${p.active ? 'checked' : ''}> فعالة</label></div>`).join('')}
          <button type="button" class="btn sm" data-action="settings-add-pt">${icon('plus', 'sm')} طريقة دفع</button></section>
        <section class="card pad stack"><h2>أنواع الطلب والميزات</h2>
          ${field('أنواع الطلب (مفصولة بفاصلة)', `<input name="dining" id="st-dining" value="${esc(st.diningOptions.map((d) => d.name).join('، '))}">`)}
          <label class="check"><input type="checkbox" name="kds" ${st.features.kds ? 'checked' : ''}> شاشة التحضير للباريستا</label>
          <label class="check"><input type="checkbox" name="openTickets" ${st.features.openTickets ? 'checked' : ''}> التذاكر المفتوحة (حفظ الطلبات للطاولات)</label></section>
        <div><button class="btn primary lg" type="submit" ${s.busy ? 'disabled' : ''}>حفظ الإعدادات</button></div>
      </form>
      ${accountCard(s, a.account)}`;
  },
};

const neg = (v) => (v ? `−${money(v)}` : money(0));
// ---------------------------------------------------------------- سجل العمليات
const AUDIT_LABELS = {
  'receipt.refund': 'استرجاع', 'discount.restricted': 'خصم مقيد على بيع', 'discount.update': 'تعديل خصم', 'discounts.archive': 'أرشفة خصم',
  'inventory.receive': 'استلام مخزون', 'inventory.loss': 'هدر/تالف', 'inventory.count': 'جرد', 'inventory.adjust': 'تعديل مخزون', 'inventory.reconcile': 'مطابقة المخزون',
  'item.create': 'صنف جديد', 'item.update': 'تعديل صنف/سعر', 'items.archive': 'أرشفة صنف', 'categories.archive': 'أرشفة تصنيف', 'modifiers.archive': 'أرشفة إضافة',
  'shift.open': 'فتح وردية', 'shift.close': 'إغلاق وردية', 'shift.pay_in': 'إدخال نقد للدرج', 'shift.pay_out': 'سحب نقد من الدرج',
  'ticket.delete': 'حذف تذكرة محفوظة', 'employee.create': 'موظف جديد', 'employee.update': 'تعديل موظف', 'settings.update': 'تعديل الإعدادات',
  'expense.create': 'مصروف', 'expense.delete': 'حذف مصروف',
};
const AUDIT_WARN = new Set(['receipt.refund', 'discount.restricted', 'inventory.loss', 'inventory.adjust', 'shift.pay_out', 'ticket.delete', 'item.update', 'expense.delete']);

function auditDetails(x) {
  const d = x.data ?? {};
  const parts = [];
  if (d.sale) parts.push(`إيصال #${d.sale}${d.refund ? ` ← استرجاع #${d.refund}` : ''}`);
  if (d.receipt) parts.push(`إيصال #${d.receipt}`);
  if (Number.isSafeInteger(d.total)) parts.push(money(d.total));
  if (d.discount) parts.push(esc(d.discount));
  if (d.reason) parts.push(`السبب: ${esc(d.reason)}`);
  if (d.name) parts.push(esc(d.name));
  for (const c of d.priceChanges ?? []) parts.push(`${esc(c.variant || 'السعر')}: ${money(c.from)} ← ${money(c.to)}`);
  if (d.removedSizes) parts.push(`حُذف ${d.removedSizes} حجم`);
  if (Number.isSafeInteger(d.delta)) parts.push(`الكمية ${d.delta > 0 ? '+' : ''}${d.delta.toLocaleString('en-US')}`);
  if (Number.isSafeInteger(d.amount)) parts.push(money(d.amount));
  if (Number.isSafeInteger(d.difference)) parts.push(`الفرق ${money(d.difference, { sign: true })}`);
  if (Number.isSafeInteger(d.startingCash)) parts.push(`بداية ${money(d.startingCash)}`);
  if (d.role) parts.push(esc(ROLES[d.role] ?? d.role));
  if (d.pinChanged) parts.push('تغيير الرمز');
  if (d.active === false) parts.push('تعطيل');
  if (d.category) parts.push(esc(d.category));
  if (d.note) parts.push(esc(d.note));
  if (Array.isArray(d.keys) && d.keys.length) parts.push(esc(d.keys.join('، ')));
  return parts.join(' · ') || '—';
}

const qty = (n, unit) => `${Number(n).toLocaleString('en-US')} ${esc(unit ?? '')}`;

// ---------------------------------------------------------------- التقرير اليومي: نص للمشاركة وورقة للطباعة
function dailyText(d) {
  const sm = d.summary;
  const lines = [
    `📊 التقرير اليومي — ${d.shopName}`, `📅 ${d.date}`, '',
    `صافي المبيعات: ${money(sm.net)}`, `عدد الإيصالات: ${sm.salesCount}`, `متوسط الفاتورة: ${money(sm.avgSale)}`, `الربح الإجمالي: ${money(sm.profit)}`,
    ...(sm.refundsCount ? [`المرتجعات: ${money(sm.refunds)} (${sm.refundsCount})`] : []),
    ...(sm.discounts ? [`الخصومات: ${money(sm.discounts)}`] : []),
    '', '💳 طرق الدفع:', ...d.byPayment.map((p) => `• ${p.label}: ${money(p.net)} (${p.count})`),
    '', '☕ الأصناف المباعة:', ...d.byItem.map((i) => `• ${i.label}: ${i.qty - i.refundedQty} — ${money(i.net)}`),
  ];
  if (d.consumption.length) {
    lines.push('', '📦 الموارد المصروفة:', ...d.consumption.map((c) => `• ${c.name}: ${Number(c.used).toLocaleString('en-US')} ${c.unit}${c.loss ? ` (+هدر ${c.loss})` : ''} — المتبقي ${Number(c.stock).toLocaleString('en-US')}`));
    lines.push(`تكلفة الموارد: ${money(d.consumptionCost)}`);
  }
  if (d.lowStock.length) lines.push('', '⚠️ تحت حد التنبيه:', ...d.lowStock.map((c) => `• ${c.name}: ${Number(c.stock).toLocaleString('en-US')} ${c.unit}`));
  return lines.join('\n');
}

function dailyHtml(d) {
  const sm = d.summary;
  const m = (v) => money(v, { symbol: false });
  const row = (a, b) => `<div class="row80"><span>${a}</span><span>${b}</span></div>`;
  return `<div class="paper80">
    <div class="c big">${esc(d.shopName)}</div><div class="c">التقرير اليومي · ${esc(d.date)}</div><hr>
    ${row('<b>صافي المبيعات د.ع</b>', `<b>${m(sm.net)}</b>`)}${row('الإيصالات', sm.salesCount)}${row('متوسط الفاتورة', m(sm.avgSale))}${row('الربح الإجمالي', m(sm.profit))}
    ${sm.refundsCount ? row(`المرتجعات (${sm.refundsCount})`, `-${m(sm.refunds)}`) : ''}${sm.discounts ? row('الخصومات', `-${m(sm.discounts)}`) : ''}
    <hr><b>طرق الدفع</b>${d.byPayment.map((p) => row(`${esc(p.label)} (${p.count})`, m(p.net))).join('')}
    <hr><b>الأصناف المباعة</b>${d.byItem.map((i) => row(`${i.qty - i.refundedQty}× ${esc(i.label)}`, m(i.net))).join('')}
    ${d.consumption.length ? `<hr><b>الموارد المصروفة</b>${d.consumption.map((c) => row(esc(c.name), `${Number(c.used + c.loss).toLocaleString('en-US')} ${esc(c.unit)}`)).join('')}${row('التكلفة', m(d.consumptionCost))}` : ''}
    ${d.lowStock.length ? `<hr><b>تحت حد التنبيه</b>${d.lowStock.map((c) => row(esc(c.name), `${Number(c.stock).toLocaleString('en-US')} ${esc(c.unit)}`)).join('')}` : ''}
    <hr><div class="c">طُبع ${esc(dateTime(Date.now(), tz()))}</div>
  </div>`;
}

function simpleList(title, kind, list, headers, cells) {
  return `<div class="page-head"><h1>${title}</h1><button class="btn primary" data-action="${kind}-new">${icon('plus', 'sm')} إضافة</button></div>
    <div class="table-wrap"><table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${(list ?? []).map((x) => `<tr class="click" data-action="${kind}-edit" data-id="${x.id}">${cells(x).map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')
      || `<tr><td colspan="${headers.length}" class="muted">${list ? 'لا عناصر' : 'جارٍ التحميل…'}</td></tr>`}</tbody></table></div>`;
}

function reportRows(tab, r) {
  switch (tab) {
    case 'items': return { head: ['الصنف', 'المباع', 'المسترجع', 'صافي المبيعات', 'التكلفة', 'الربح'], rows: r.byItem.map((x) => [x.label, x.qty, x.refundedQty, x.net, x.cogs, x.profit]), money: [3, 4, 5] };
    case 'categories': return { head: ['التصنيف', 'المباع', 'صافي المبيعات', 'التكلفة', 'الربح'], rows: r.byCategory.map((x) => [x.label, x.qty - x.refundedQty, x.net, x.cogs, x.profit]), money: [2, 3, 4] };
    case 'employees': return { head: ['الموظف', 'الإيصالات', 'المرتجعات', 'الخصومات', 'صافي المبيعات', 'متوسط الفاتورة'], rows: r.byEmployee.map((x) => [x.label, x.salesCount, x.refunds, x.discounts, x.net, x.avgSale]), money: [2, 3, 4, 5] };
    case 'payments': return { head: ['طريقة الدفع', 'العمليات', 'المدفوع', 'المسترجع', 'الصافي'], rows: r.byPayment.map((x) => [x.label, x.count, x.paid, x.refunded, x.net]), money: [2, 3, 4] };
    case 'modifiers': return { head: ['الإضافة', 'العدد', 'المبلغ'], rows: r.byModifier.map((x) => [x.label, x.count, x.amount]), money: [2] };
    case 'discounts': return { head: ['الخصم', 'مرات الاستخدام', 'المبلغ'], rows: r.byDiscount.map((x) => [x.label, x.count, x.amount]), money: [2] };
    case 'dining': return { head: ['نوع الطلب', 'الإيصالات', 'صافي المبيعات'], rows: r.byDining.map((x) => [x.label, x.salesCount, x.net]), money: [2] };
    default: return { head: ['اليوم', 'الإيصالات', 'المرتجعات', 'صافي المبيعات', 'الربح'], rows: r.byDay.map((x) => [x.label, x.salesCount, x.refunds, x.net, x.profit]), money: [2, 3, 4] };
  }
}

function reportTable(tab, r) {
  const { head, rows, money: mcols } = reportRows(tab, r);
  if (!rows.length) return '<div class="empty"><p>لا بيانات في هذه الفترة</p></div>';
  const totals = head.map((_, i) => (i === 0 ? 'المجموع' : rows.reduce((a, row) => a + (Number(row[i]) || 0), 0)));
  const cell = (v, i) => (i === 0 ? `<td>${esc(v)}</td>` : `<td class="num">${mcols.includes(i) ? money(v) : Number(v).toLocaleString('en-US')}</td>`);
  return `<table><thead><tr>${head.map((h, i) => `<th class="${i ? 'num' : ''}">${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((row) => `<tr>${row.map(cell).join('')}</tr>`).join('')}</tbody>
    ${['days', 'items', 'categories', 'payments', 'employees'].includes(tab) ? `<tfoot><tr>${totals.map((v, i) => (i === 0 ? `<td>${v}</td>` : tab === 'employees' && i === 5 ? '<td></td>' : cell(v, i))).join('')}</tr></tfoot>` : ''}</table>`;
}

// ---------------------------------------------------------------- النوافذ
export const modals = {
  'item-form'(s) {
    const m = s.modal;
    const it = m.item;
    const cats = A().categories ?? [];
    const mods = (A().modifiers ?? []).filter((x) => x.active !== false);
    const ingredients = (A().items ?? []).filter((i) => !i.forSale).flatMap((i) => i.variants.map((v) => ({ id: v.id, name: v.name ? `${i.name} — ${v.name}` : i.name, unit: i.unit })));
    const variantRows = it.variants.map((v, i) => `<div class="card pad stack" style="padding:14px">
      <div class="row wrap">
        ${it.forSale ? `<input id="v-name-${i}" data-input="v-field" data-i="${i}" data-k="name" value="${esc(v.name)}" placeholder="${it.variants.length > 1 ? 'اسم الحجم (وسط، كبير)' : 'اسم الحجم (اختياري)'}" style="flex:2;min-width:120px" aria-label="اسم الحجم">
          <input id="v-price-${i}" data-input="v-field" data-i="${i}" data-k="price" value="${esc(v.price)}" inputmode="numeric" placeholder="السعر" style="flex:1;min-width:90px" aria-label="السعر">` : ''}
        ${!v.recipe?.length ? `<input id="v-cost-${i}" data-input="v-field" data-i="${i}" data-k="cost" value="${esc(v.cost)}" inputmode="decimal" placeholder="${it.forSale ? 'التكلفة' : `التكلفة لكل ${esc(it.unit || 'وحدة')}`}" style="flex:1;min-width:90px" aria-label="التكلفة">` : ''}
        ${it.forSale ? `<input id="v-sku-${i}" data-input="v-field" data-i="${i}" data-k="sku" value="${esc(v.sku ?? '')}" placeholder="SKU" dir="ltr" style="flex:1;min-width:80px" aria-label="SKU">` : ''}
        ${it.variants.length > 1 ? `<button type="button" class="icon-btn" data-action="v-remove" data-i="${i}" aria-label="حذف الحجم">${icon('trash', 'sm')}</button>` : ''}
      </div>
      ${it.forSale && !v.recipe?.length ? `<label class="check"><input type="checkbox" data-change="v-track" data-i="${i}" ${v.trackStock ? 'checked' : ''}> تتبع مخزون هذا الصنف (مخبوزات، ماء)</label>` : ''}
      ${v.trackStock || !it.forSale ? `<div class="row wrap"><input id="v-low-${i}" data-input="v-field" data-i="${i}" data-k="lowStock" value="${esc(v.lowStock)}" inputmode="numeric" placeholder="حد التنبيه" style="max-width:160px" aria-label="حد التنبيه">
        ${!v.id ? `<input id="v-init-${i}" data-input="v-field" data-i="${i}" data-k="initialStock" value="${esc(v.initialStock ?? '')}" inputmode="numeric" placeholder="الرصيد الافتتاحي" style="max-width:180px" aria-label="الرصيد الافتتاحي">` : '<span class="muted small">عدّل الرصيد من شاشة المخزون</span>'}</div>` : ''}
      ${it.forSale && !v.trackStock ? `<div class="stack" style="gap:8px"><span class="label">الكميات التقريبية لكل وحدة مباعة — تُطرح من المخزون تلقائياً مع كل بيع، وتظهر في التقرير اليومي</span>
        ${(v.recipe ?? []).map((r, j) => `<div class="row"><select data-change="r-field" data-i="${i}" data-j="${j}" data-k="variantId" id="r-v-${i}-${j}" style="flex:2" aria-label="المكون">
          ${ingredients.map((g) => `<option value="${g.id}" ${g.id === r.variantId ? 'selected' : ''}>${esc(g.name)} (${esc(g.unit)})</option>`).join('')}</select>
          <input data-input="r-field" data-i="${i}" data-j="${j}" data-k="qty" id="r-q-${i}-${j}" value="${esc(r.qty)}" inputmode="numeric" style="flex:1" aria-label="الكمية">
          <span class="muted small" style="min-width:36px">${esc(ingredients.find((g) => g.id === r.variantId)?.unit ?? '')}</span>
          <button type="button" class="icon-btn" data-action="r-remove" data-i="${i}" data-j="${j}" aria-label="حذف المكون">${icon('x', 'sm')}</button></div>`).join('')}
        ${ingredients.length ? `<button type="button" class="btn sm" data-action="r-add" data-i="${i}">${icon('plus', 'sm')} مكون</button>` : '<span class="muted small">أضف مكونات من تبويب "المكونات" أولاً</span>'}</div>` : ''}
    </div>`).join('');
    const body = `
      <div class="seg"><button type="button" class="${it.forSale ? 'on' : ''}" data-action="item-kind" data-v="sale">صنف للبيع</button><button type="button" class="${!it.forSale ? 'on' : ''}" data-action="item-kind" data-v="ing">مكوّن (بن، حليب، أكواب)</button></div>
      <div class="grid-2">${field('الاسم', `<input id="it-name" data-input="it-field" data-k="name" value="${esc(it.name)}" required maxlength="50">`)}
        ${it.forSale ? field('التصنيف', `<select id="it-cat" data-change="it-field" data-k="categoryId"><option value="">بلا تصنيف</option>${cats.filter((c) => c.active !== false).map((c) => `<option value="${c.id}" ${c.id === it.categoryId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>`)
          : field('وحدة القياس', `<input id="it-unit" data-input="it-field" data-k="unit" value="${esc(it.unit ?? '')}" placeholder="غ، مل، قطعة" maxlength="10">`)}</div>
      ${it.forSale ? `<div class="stack" style="gap:8px"><span class="label">اللون على شاشة البيع</span><div class="row wrap">${Object.entries(COLORS).map(([k, l]) => `<button type="button" class="chip c-${k} ${it.color === k ? 'on' : ''}" style="${it.color === k ? 'background:var(--c);border-color:var(--c);color:#fff' : ''}" data-action="it-color" data-v="${k}"><span style="width:12px;height:12px;border-radius:3px;background:var(--c)"></span>${l}</button>`).join('')}</div></div>
        <div class="stack" style="gap:8px"><span class="label">مجموعات الإضافات</span><div class="row wrap">${mods.map((g) => `<button type="button" class="chip ${it.modifierIds.includes(g.id) ? 'on' : ''}" data-action="it-mod" data-v="${g.id}">${esc(g.name)}</button>`).join('') || '<span class="muted small">لا إضافات بعد</span>'}</div></div>` : ''}
      <div class="row"><h3 style="margin-inline-end:auto">${it.forSale ? 'الأحجام والأسعار' : 'التكلفة والمخزون'}</h3>${it.forSale && it.variants.length < 8 ? `<button type="button" class="btn sm" data-action="v-add">${icon('plus', 'sm')} حجم</button>` : ''}</div>
      ${variantRows}`;
    return modalFrame({ title: it.id ? it.name : 'صنف جديد', cls: 'wide', body,
      foot: `${it.id ? `<button class="btn danger" data-action="item-archive">${icon('trash', 'sm')} أرشفة</button>` : ''}<button class="btn primary" data-action="item-submit" ${s.busy ? 'disabled' : ''}>حفظ</button>` });
  },

  'category-form'(s) {
    const c = s.modal.doc ?? { name: '', color: 'olive', sort: 0 };
    return modalFrame({ title: c.id ? c.name : 'تصنيف جديد', body: `<form class="stack" data-form="category-save">
      ${field('الاسم', `<input name="name" id="cat-name" required maxlength="40" value="${esc(c.name)}" autofocus>`)}
      ${field('اللون', `<select name="color" id="cat-color">${Object.entries(COLORS).map(([k, l]) => `<option value="${k}" ${c.color === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`)}
      ${field('الترتيب', `<input name="sort" id="cat-sort" inputmode="numeric" value="${c.sort ?? 0}">`)}
      <div class="row">${c.id ? '<button type="button" class="btn danger" data-action="category-archive">أرشفة</button>' : ''}<span class="spacer"></span><button class="btn primary" type="submit">حفظ</button></div></form>` });
  },

  'modifier-form'(s) {
    const m = s.modal.doc;
    return modalFrame({ title: m.id ? m.name : 'مجموعة إضافات', cls: 'wide', body: `
      <div class="grid-2">${field('اسم المجموعة', `<input id="mod-name" data-input="mod-field" data-k="name" value="${esc(m.name)}" maxlength="40" placeholder="نوع الحليب">`)}
        ${field('طريقة الاختيار', `<select id="mod-sel" data-change="mod-field" data-k="selection"><option value="single" ${m.selection === 'single' ? 'selected' : ''}>خيار واحد</option><option value="multi" ${m.selection === 'multi' ? 'selected' : ''}>أكثر من خيار</option></select>`)}</div>
      <label class="check"><input type="checkbox" data-change="mod-required" ${m.required ? 'checked' : ''}> إلزامية (لا يُضاف الصنف دون اختيار)</label>
      <h3>الخيارات</h3>
      ${m.options.map((o, i) => `<div class="row"><input id="mo-n-${i}" data-input="mo-field" data-i="${i}" data-k="name" value="${esc(o.name)}" placeholder="الخيار" style="flex:2" aria-label="الخيار">
        <input id="mo-p-${i}" data-input="mo-field" data-i="${i}" data-k="price" value="${esc(o.price)}" inputmode="numeric" placeholder="السعر الإضافي" style="flex:1" aria-label="السعر الإضافي">
        <button class="icon-btn" data-action="mo-remove" data-i="${i}" aria-label="حذف">${icon('x', 'sm')}</button></div>`).join('')}
      <button class="btn sm" data-action="mo-add">${icon('plus', 'sm')} خيار</button>`,
    foot: `${m.id ? '<button class="btn danger" data-action="modifier-archive">أرشفة</button>' : ''}<button class="btn primary" data-action="modifier-submit">حفظ</button>` });
  },

  'discount-form'(s) {
    const d = s.modal.doc ?? { name: '', type: 'percent', value: 1000, restricted: false };
    return modalFrame({ title: d.id ? d.name : 'خصم جديد', body: `<form class="stack" data-form="discount-save">
      ${field('الاسم', `<input name="name" id="dc-name" required maxlength="40" value="${esc(d.name)}" autofocus>`)}
      <div class="grid-2">${field('النوع', `<select name="type" id="dc-type"><option value="percent" ${d.type === 'percent' ? 'selected' : ''}>نسبة %</option><option value="amount" ${d.type === 'amount' ? 'selected' : ''}>مبلغ ثابت (د.ع)</option></select>`)}
        ${field('القيمة', `<input name="value" id="dc-value" inputmode="decimal" required value="${d.type === 'percent' ? d.value / 100 : d.value}">`)}</div>
      <label class="check"><input type="checkbox" name="restricted" ${d.restricted ? 'checked' : ''}> مقيد: يطبقه المدير أو المالك فقط</label>
      <div class="row">${d.id ? '<button type="button" class="btn danger" data-action="discount-archive">أرشفة</button>' : ''}<span class="spacer"></span><button class="btn primary" type="submit">حفظ</button></div></form>` });
  },

  'employee-form'(s) {
    const e = s.modal.doc ?? { name: '', role: 'cashier', active: true };
    return modalFrame({ title: e.id ? e.name : 'موظف جديد', body: `<form class="stack" data-form="employee-save">
      ${field('الاسم', `<input name="name" id="em-name" required maxlength="40" value="${esc(e.name)}" autofocus>`)}
      <div class="grid-2">${field('الدور', `<select name="role" id="em-role">${Object.entries(ROLES).map(([k, l]) => `<option value="${k}" ${e.role === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`)}
        ${field('الهاتف', `<input name="phone" id="em-phone" dir="ltr" value="${esc(e.phone ?? '')}">`)}</div>
      ${field(e.id ? 'رمز جديد (اتركه فارغاً للإبقاء)' : 'رمز الدخول', `<input name="pin" id="em-pin" inputmode="numeric" pattern="[0-9٠-٩۰-۹]{4,6}" maxlength="6" type="password" ${e.id ? '' : 'required'} autocomplete="new-password">`, '4–6 أرقام، فريد لكل موظف')}
      ${e.id ? `<label class="check"><input type="checkbox" name="active" ${e.active ? 'checked' : ''}> فعال</label>` : ''}
      <p class="muted small">المالك: كل شيء · المدير: كل شيء عدا الموظفين والإعدادات · الكاشير: البيع والوردية والعملاء · الباريستا: شاشة التحضير فقط.</p>
      <button class="btn primary" type="submit">حفظ</button></form>` });
  },

  'inv-adjust'(s) {
    const m = s.modal;
    const r = A().inventory.rows.find((x) => x.variantId === m.variantId);
    const type = m.adjType ?? 'receive';
    return modalFrame({ title: r.name, sub: `الرصيد الحالي ${r.stock.toLocaleString('en-US')} ${esc(r.unit)} · التكلفة ${formatMilli(r.costMilli)} د.ع/${esc(r.unit)}`, body: `
      <div class="seg">${[['receive', 'استلام'], ['loss', 'هدر/تالف'], ['count', 'جرد']].map(([k, l]) => `<button class="${type === k ? 'on' : ''}" data-action="adj-type" data-k="${k}">${l}</button>`).join('')}</div>
      <form class="stack" data-form="inv-adjust-submit">
        ${field(type === 'count' ? `الكمية المعدودة فعلياً (${esc(r.unit)})` : `الكمية (${esc(r.unit)})`, '<input class="amount-input" name="qty" id="adj-qty" inputmode="numeric" required autofocus autocomplete="off">')}
        ${type === 'receive' ? field(`تكلفة الوحدة (د.ع لكل ${esc(r.unit)})`, '<input name="cost" id="adj-cost" inputmode="decimal" placeholder="اتركه فارغاً للإبقاء على التكلفة">', 'تُحدَّث التكلفة بالمتوسط المرجح') : ''}
        ${field('ملاحظة', `<input name="note" id="adj-note" maxlength="120" ${type === 'loss' ? 'required' : ''} placeholder="${type === 'loss' ? 'منتهي الصلاحية، انسكب…' : 'المورد، رقم الفاتورة…'}">`)}
        <button class="btn primary" type="submit" ${s.busy ? 'disabled' : ''}>تسجيل</button></form>` });
  },

  receive(s) {
    const m = s.modal;
    const items = A().stockItems ?? [];
    const byId = new Map(items.map((x) => [x.id, x]));
    if (m.scanning) {
      return modalFrame({ title: 'قراءة الفاتورة', body: `<div class="empty" style="padding:28px">${icon('receipt')}<h3>جارٍ قراءة الفاتورة…</h3>
        <p class="muted">يستخرج البرنامج المواد والكميات والأسعار. قد يستغرق ذلك حتى نصف دقيقة.</p></div>` });
    }
    const qtyOf = (l) => parseAmount(String(l.qty ?? '')) ?? 0;
    const ready = m.lines.filter((l) => l.variantId && qtyOf(l) > 0);
    const invalid = m.lines.length - ready.length;
    const sum = m.lines.reduce((a, l) => a + (parseAmount(String(l.total ?? '')) ?? 0), 0);
    const rows = m.lines.map((l, i) => {
      const it = byId.get(l.variantId);
      const qty = qtyOf(l);
      const total = parseAmount(String(l.total ?? ''));
      const unitCost = it && qty > 0 && total ? formatMilli(Math.round((total * 1000) / qty)) : null;
      return `<div class="rcv-row ${l.variantId && qty > 0 ? '' : 'warn'}">
        ${l.description ? `<div class="small muted rcv-src">في الفاتورة: ${esc([l.invoiceQty, l.invoiceUnit, l.description].filter((x) => x !== null && x !== undefined && x !== '').join(' '))}</div>` : ''}
        <select data-change="rcv-field" data-i="${i}" data-k="variantId" id="rcv-v-${i}" aria-label="المادة">
          <option value="">— اختر المادة —</option>${items.map((x) => `<option value="${x.id}" ${x.id === l.variantId ? 'selected' : ''}>${esc(x.name)} (${esc(x.unit)})</option>`).join('')}</select>
        <label class="rcv-num"><input data-input="rcv-field" data-i="${i}" data-k="qty" id="rcv-q-${i}" value="${esc(l.qty ?? '')}" inputmode="numeric" placeholder="الكمية" aria-label="الكمية"><span class="muted small">${esc(it?.unit ?? '')}</span></label>
        <label class="rcv-num"><input data-input="rcv-field" data-i="${i}" data-k="total" id="rcv-t-${i}" value="${esc(l.total ?? '')}" inputmode="numeric" placeholder="المبلغ" aria-label="مبلغ السطر"><span class="muted small">د.ع</span></label>
        <button type="button" class="icon-btn" data-action="rcv-remove" data-i="${i}" aria-label="حذف السطر">${icon('x', 'sm')}</button>
        ${unitCost ? `<div class="small muted rcv-cost">التكلفة: ${unitCost} د.ع لكل ${esc(it.unit)}</div>` : ''}
      </div>`;
    }).join('');
    const body = `
      ${m.scanned ? `<div class="card pad small" style="background:var(--surface-2)">${icon('check', 'sm')} قُرئت الفاتورة${m.supplier ? ` من <b>${esc(m.supplier)}</b>` : ''}${m.invoiceTotal ? ` · إجمالي الفاتورة ${money(m.invoiceTotal)}` : ''}.
        <b>راجع كل سطر قبل التأكيد</b> — الأسطر المظللة تحتاج اختيار مادة أو كمية.</div>` : ''}
      ${field('المورد (اختياري)', `<input id="rcv-supplier" data-input="rcv-supplier" value="${esc(m.supplier ?? '')}" maxlength="60" placeholder="اسم المورد أو رقم الفاتورة">`)}
      <div class="stack" style="gap:10px">${rows || '<p class="muted">لا أسطر بعد. أضف سطراً لكل مادة مستلمة.</p>'}</div>
      <button type="button" class="btn sm" data-action="rcv-add">${icon('plus', 'sm')} سطر</button>
      ${items.length ? '' : '<p class="muted small">لا توجد مواد مخزون بعد. أضفها من الأصناف بنوع «مكوّن» أولاً.</p>'}`;
    const foot = `<div class="muted small" style="align-self:center;flex:none">${m.lines.length ? `المجموع ${money(sum)}${m.invoiceTotal && sum !== m.invoiceTotal ? ` <span class="pill warn">يختلف عن الفاتورة</span>` : ''}` : ''}</div>
      <button class="btn primary" data-action="rcv-submit" ${ready.length && !invalid && !s.busy ? '' : 'disabled'}>${invalid ? `أكمل ${invalid} ${invalid === 1 ? 'سطر' : 'أسطر'}` : `${icon('check', 'sm')} تأكيد وإضافة للمخزون (${ready.length})`}</button>`;
    return modalFrame({ title: 'استلام مشتريات', cls: 'wide', body, foot });
  },

  'inv-history'(s) {
    const h = s.modal.rows;
    return modalFrame({ title: 'سجل الحركات', cls: 'wide', body: h ? `<div class="table-wrap"><table><thead><tr><th>الوقت</th><th>الحركة</th><th class="num">الكمية</th><th>بواسطة</th><th>ملاحظة</th></tr></thead>
      <tbody>${h.map((x) => `<tr><td class="small">${dateTime(x.at, tz())}</td><td>${esc(x.reasonName)}</td><td class="num" style="color:${x.delta < 0 ? 'var(--bad)' : 'var(--ok)'}">${x.delta > 0 ? '+' : ''}${x.delta.toLocaleString('en-US')}</td><td class="small">${esc(x.byName ?? '')}</td><td class="small">${esc(x.note ?? '')}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">لا حركات</td></tr>'}</tbody></table></div>` : '<p class="muted">جارٍ التحميل…</p>' });
  },
};

// ---------------------------------------------------------------- استلام المشتريات
const blankLine = () => ({ id: uid(), variantId: '', qty: '', total: '' });

async function ensureStockItems() {
  if (!A().stockItems) A().stockItems = await get('/api/admin/inventory/stock-items');
}

/** تصغير صورة الفاتورة قبل الإرسال (أطول ضلع 1600 بكسل، JPEG) — يكفي للقراءة ويبقى تحت حد الطلب */
async function compressImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(Object.assign(new Error('img'), { code: 'INVALID_IMAGE' })); i.src = url; });
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return { data: canvas.toDataURL('image/jpeg', 0.8).split(',')[1], mediaType: 'image/jpeg' };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------------------------------------------------------------- التحميل
function presetRange(k) {
  const today = localDate(Date.now(), tz());
  const d = (n) => localDate(Date.now() - n * 86400000, tz());
  const first = `${today.slice(0, 7)}-01`;
  const lastMonthEnd = localDate(new Date(`${first}T00:00:00Z`).getTime() - 86400000, 0);
  const lastMonthStart = `${lastMonthEnd.slice(0, 7)}-01`;
  return { today: [today, today], yesterday: [d(1), d(1)], week: [d(6), today], month: [first, today], lastmonth: [lastMonthStart, lastMonthEnd] }[k];
}

async function loadSection(sub) {
  const a = A();
  const loaders = {
    dashboard: async () => { a.dashboard = await get('/api/admin/dashboard'); },
    audit: async () => {
      if (!a.auditPreset) a.auditPreset = 'today';
      const [from, to] = presetRange(a.auditPreset);
      a.audit = null; render();
      a.audit = await get('/api/admin/audit', { from, to, group: a.auditGroup || undefined });
    },
    daily: async () => {
      if (!a.dailyDate) a.dailyDate = presetRange('today')[0];
      a.daily = null; render();
      a.daily = await get('/api/admin/reports/daily', { date: a.dailyDate });
    },
    reports: async () => {
      if (!a.from) { a.preset = 'today'; [a.from, a.to] = presetRange('today'); }
      a.report = null; render();
      a.report = await get('/api/admin/reports', { from: a.from, to: a.to });
    },
    shifts: async () => { a.shifts = await get('/api/shifts'); },
    items: async () => { [a.items, a.categories, a.modifiers] = await Promise.all([get('/api/admin/items'), get('/api/admin/categories'), get('/api/admin/modifiers')]); },
    categories: async () => { a.categories = await get('/api/admin/categories'); },
    modifiers: async () => { a.modifiers = await get('/api/admin/modifiers'); },
    discounts: async () => { a.discounts = await get('/api/admin/discounts'); },
    inventory: async () => { a.inventory = await get('/api/admin/inventory'); a.lowCount = a.inventory.lowCount; a.stockItems = null; },
    employees: async () => { a.employees = await get('/api/admin/employees'); },
    settings: async () => { [a.settings, a.account] = await Promise.all([get('/api/admin/settings'), loadAccount()]); },
  };
  await loaders[sub]?.();
  render();
}

export async function enter(params) {
  const sub = params.sub || SECTIONS.find(([, , , p]) => can(p))?.[0];
  await loadSection(sub);
}

const sub = () => state.params.sub || SECTIONS.find(([, , , p]) => can(p))?.[0];
const blankVariant = (forSale) => ({ name: '', price: '', cost: '', sku: '', trackStock: !forSale, lowStock: '', initialStock: '', recipe: [] });
const num = (v, field) => { const n = parseAmount(v); if (n === null) return 0; if (!Number.isSafeInteger(n)) throw new Error(`رقم غير صالح: ${field}`); return n; };
const percentToBp = (v) => { const s = String(v ?? '').trim(); if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error('نسبة غير صالحة'); const [w, f = ''] = s.split('.'); return Number(w) * 100 + Number(f.padEnd(2, '0')); };

on({
  // التقارير
  'audit-preset': (el) => { A().auditPreset = el.dataset.k; loadSection('audit').catch(fail); },
  'audit-group': (el) => { A().auditGroup = el.dataset.k; loadSection('audit').catch(fail); },
  'daily-date': (el) => { if (!el.value) return; A().dailyDate = el.value; loadSection('daily').catch(fail); },
  'daily-print': () => { const d = A().daily; if (d) printHtml(dailyHtml(d), 'معاينة التقرير اليومي'); },
  'daily-share': async () => {
    const d = A().daily;
    if (!d) return;
    const text = dailyText(d);
    if (navigator.share) {
      try { await navigator.share({ title: `التقرير اليومي ${d.date}`, text }); } catch (e) { if (e?.name !== 'AbortError') toast('تعذرت المشاركة', 'bad'); }
      return;
    }
    try { await navigator.clipboard.writeText(text); toast('نُسخ التقرير — الصقه في واتساب أو أي تطبيق'); } catch { toast('تعذر النسخ', 'bad'); }
  },
  'report-preset': (el) => { const a = A(); a.preset = el.dataset.k; [a.from, a.to] = presetRange(el.dataset.k); loadSection('reports').catch(fail); },
  'report-from': (el) => { const a = A(); a.from = el.value; a.preset = null; if (a.to && a.from <= a.to) loadSection('reports').catch(fail); },
  'report-to': (el) => { const a = A(); a.to = el.value; a.preset = null; if (a.from && a.from <= a.to) loadSection('reports').catch(fail); },
  'report-tab': (el) => { A().reportTab = el.dataset.k; render(); },
  'report-csv': () => {
    const a = A();
    const { head, rows } = reportRows(a.reportTab ?? 'items', a.report);
    const csv = [head, ...rows].map((r) => r.map((c) => `"${String(c).replaceAll('"', '""')}"`).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    const link = Object.assign(document.createElement('a'), { href: url, download: `morecash-${a.reportTab ?? 'items'}-${a.from}_${a.to}.csv` });
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  },

  // الأصناف
  'items-filter': (el) => { A().itemFilter = el.dataset.f; render(); },
  'items-search': (el) => { A().itemSearch = el.value; render(); },
  'item-new': () => {
    const forSale = (A().itemFilter ?? 'sale') === 'sale';
    openModal({ type: 'item-form', item: { name: '', categoryId: A().categories?.find((c) => c.active !== false)?.id ?? '', color: 'olive', forSale, unit: forSale ? null : 'غ', modifierIds: [], variants: [blankVariant(forSale)] } });
  },
  'item-edit': (el) => {
    const i = A().items.find((x) => x.id === el.dataset.id);
    openModal({ type: 'item-form', item: { ...structuredClone(i), variants: i.variants.map((v) => ({ ...v, price: String(v.price), cost: formatMilli(v.costMilli), lowStock: String(v.lowStock ?? ''), sku: v.sku ?? '', recipe: v.recipe ?? [] })) } });
  },
  'item-kind': (el) => { const it = state.modal.item; it.forSale = el.dataset.v === 'sale'; it.unit = it.forSale ? null : it.unit || 'غ'; it.variants = it.variants.slice(0, it.forSale ? 8 : 1); render(); },
  'it-field': (el) => { state.modal.item[el.dataset.k] = el.value; if (el.tagName === 'SELECT') render(); },
  'it-color': (el) => { state.modal.item.color = el.dataset.v; render(); },
  'it-mod': (el) => { const it = state.modal.item; it.modifierIds = it.modifierIds.includes(el.dataset.v) ? it.modifierIds.filter((x) => x !== el.dataset.v) : [...it.modifierIds, el.dataset.v]; render(); },
  'v-field': (el) => { state.modal.item.variants[Number(el.dataset.i)][el.dataset.k] = el.value; },
  'v-track': (el) => { state.modal.item.variants[Number(el.dataset.i)].trackStock = el.checked; render(); },
  'v-add': () => { state.modal.item.variants.push(blankVariant(true)); render(); },
  'v-remove': (el) => { state.modal.item.variants.splice(Number(el.dataset.i), 1); render(); },
  'r-add': (el) => {
    const first = (A().items ?? []).find((i) => !i.forSale)?.variants[0];
    if (first) state.modal.item.variants[Number(el.dataset.i)].recipe.push({ variantId: first.id, qty: 1 });
    render();
  },
  'r-field': (el) => { const r = state.modal.item.variants[Number(el.dataset.i)].recipe[Number(el.dataset.j)]; r[el.dataset.k] = el.dataset.k === 'qty' ? el.value : el.value; },
  'r-remove': (el) => { state.modal.item.variants[Number(el.dataset.i)].recipe.splice(Number(el.dataset.j), 1); render(); },
  'item-submit': () => busy(async () => {
    const it = state.modal.item;
    const body = {
      id: it.id, name: it.name, categoryId: it.forSale ? it.categoryId || null : null, color: it.color, forSale: it.forSale, unit: it.forSale ? null : it.unit,
      modifierIds: it.modifierIds,
      variants: it.variants.map((v) => ({
        id: v.id, name: v.name ?? '', price: it.forSale ? num(v.price, 'السعر') : 0, cost: v.recipe?.length ? '0' : String(v.cost || '0'),
        sku: v.sku || null, trackStock: !it.forSale || (v.trackStock && !v.recipe?.length), lowStock: num(v.lowStock, 'حد التنبيه'),
        initialStock: v.id ? undefined : num(v.initialStock, 'الرصيد'),
        recipe: it.forSale && !v.trackStock ? (v.recipe ?? []).map((r) => ({ variantId: r.variantId, qty: num(r.qty, 'كمية المكون') })) : [],
      })),
    };
    await post('/api/admin/items', body);
    state.modal = null;
    toast('حُفظ الصنف', 'ok');
    await loadSection('items');
    state.catalog = null;
  }),
  'item-archive': () => busy(async () => {
    if (!state.modal.confirm) { state.modal.confirm = true; toast('اضغط مرة أخرى لأرشفة الصنف (يختفي من البيع وتبقى تقاريره)'); return; }
    await del(`/api/admin/items/${state.modal.item.id}`);
    state.modal = null;
    await loadSection('items');
    state.catalog = null;
  }),

  // التصنيفات والخصومات والإضافات
  'category-new': () => openModal({ type: 'category-form', doc: null }),
  'category-edit': (el) => openModal({ type: 'category-form', doc: A().categories.find((c) => c.id === el.dataset.id) }),
  'category-save': (_el, _e, d) => busy(async () => {
    await post('/api/admin/categories', { id: state.modal.doc?.id, name: d.name, color: d.color, sort: num(d.sort, 'الترتيب') });
    state.modal = null; state.catalog = null; await loadSection('categories');
  }),
  'category-archive': () => busy(async () => { await del(`/api/admin/categories/${state.modal.doc.id}`); state.modal = null; state.catalog = null; await loadSection('categories'); }),
  'discount-new': () => openModal({ type: 'discount-form', doc: null }),
  'discount-edit': (el) => openModal({ type: 'discount-form', doc: A().discounts.find((x) => x.id === el.dataset.id) }),
  'discount-save': (_el, _e, d) => busy(async () => {
    const value = d.type === 'percent' ? percentToBp(d.value) : num(d.value, 'القيمة');
    await post('/api/admin/discounts', { id: state.modal.doc?.id, name: d.name, type: d.type, value, restricted: d.restricted });
    state.modal = null; state.catalog = null; await loadSection('discounts');
  }),
  'discount-archive': () => busy(async () => { await del(`/api/admin/discounts/${state.modal.doc.id}`); state.modal = null; state.catalog = null; await loadSection('discounts'); }),
  'modifier-new': () => openModal({ type: 'modifier-form', doc: { name: '', selection: 'single', required: false, options: [{ name: '', price: '0' }] } }),
  'modifier-edit': (el) => openModal({ type: 'modifier-form', doc: structuredClone(A().modifiers.find((x) => x.id === el.dataset.id)) }),
  'mod-field': (el) => { state.modal.doc[el.dataset.k] = el.value; },
  'mod-required': (el) => { state.modal.doc.required = el.checked; },
  'mo-field': (el) => { state.modal.doc.options[Number(el.dataset.i)][el.dataset.k] = el.value; },
  'mo-add': () => { state.modal.doc.options.push({ name: '', price: '0' }); render(); },
  'mo-remove': (el) => { state.modal.doc.options.splice(Number(el.dataset.i), 1); render(); },
  'modifier-submit': () => busy(async () => {
    const m = state.modal.doc;
    await post('/api/admin/modifiers', { id: m.id, name: m.name, selection: m.selection, required: m.required,
      options: m.options.filter((o) => String(o.name).trim()).map((o) => ({ id: o.id, name: o.name, price: num(o.price, 'سعر الخيار') })) });
    state.modal = null; state.catalog = null; await loadSection('modifiers');
  }),
  'modifier-archive': () => busy(async () => { await del(`/api/admin/modifiers/${state.modal.doc.id}`); state.modal = null; state.catalog = null; await loadSection('modifiers'); }),

  // المخزون
  'inv-filter': (el) => { A().invFilter = el.dataset.f; render(); },
  'rcv-open': async () => {
    await ensureStockItems();
    openModal({ type: 'receive', clientId: uid(), lines: [blankLine()], supplier: '' });
  },
  'rcv-scan': async (el) => {
    const file = el.files?.[0];
    el.value = '';
    if (!file) return;
    await ensureStockItems();
    const scanId = uid();
    openModal({ type: 'receive', clientId: scanId, lines: [], supplier: '', scanning: true });
    const same = () => state.modal?.type === 'receive' && state.modal.clientId === scanId;
    try {
      const { data, mediaType } = await compressImage(file);
      const r = await post('/api/admin/inventory/scan', { image: data, mediaType });
      if (!same()) return;
      Object.assign(state.modal, {
        scanning: false, scanned: true, supplier: r.supplier ?? '', invoiceTotal: r.total ? Math.round(r.total) : null,
        lines: r.lines.length ? r.lines.map((l) => ({ ...l, id: uid(), qty: l.qty ?? '', total: l.lineTotal ?? '' })) : [blankLine()],
      });
      if (!r.lines.length) toast('لم يُعثر على أسطر في الصورة — أدخلها يدوياً', 'bad');
    } catch (e) {
      if (same()) Object.assign(state.modal, { scanning: false, lines: [blankLine()] });
      fail(e);
    }
    render();
  },
  'rcv-supplier': (el) => { state.modal.supplier = el.value; },
  // سطر عُدّل = عملية جديدة (مفتاح جديد)؛ إعادة إرسال سطر لم يتغير لا تكرره
  'rcv-field': (el) => { const l = state.modal.lines[Number(el.dataset.i)]; l[el.dataset.k] = el.value; l.id = uid(); render(); },
  'rcv-add': () => { state.modal.lines.push(blankLine()); render(); },
  'rcv-remove': (el) => { state.modal.lines.splice(Number(el.dataset.i), 1); render(); },
  'rcv-submit': () => busy(async () => {
    const m = state.modal;
    const lines = m.lines.map((l) => ({ id: l.id, variantId: l.variantId, qty: num(String(l.qty), 'الكمية'), total: l.total === '' || l.total === null ? null : num(String(l.total), 'المبلغ') }));
    const r = await post('/api/admin/inventory/receive', { supplier: m.supplier || null, lines });
    state.modal = null;
    toast(`أُضيفت ${r.received} ${r.received === 1 ? 'مادة' : 'مواد'} إلى المخزون`, 'ok');
    state.catalog = null;
    await loadSection('inventory');
  }),
  'inv-adjust': (el) => openModal({ type: 'inv-adjust', variantId: el.dataset.id, adjType: 'receive', clientId: uid() }),
  'adj-type': (el) => { state.modal.adjType = el.dataset.k; state.modal.clientId = uid(); render(); },
  'inv-adjust-submit': (_el, _e, d) => busy(async () => {
    const m = state.modal;
    const r = await post('/api/admin/inventory/adjust', { clientId: m.clientId, variantId: m.variantId, type: m.adjType, qty: num(d.qty, 'الكمية'), cost: d.cost ?? undefined, note: d.note || null });
    state.modal = null;
    toast(`الرصيد الآن ${r.stock.toLocaleString('en-US')}`, 'ok');
    state.catalog = null;
    await loadSection('inventory');
  }),
  'inv-history': async (el) => { openModal({ type: 'inv-history', rows: null }); state.modal.rows = await get(`/api/admin/inventory/${el.dataset.id}/history`); render(); },
  'inv-reconcile': () => busy(async () => {
    const r = await post('/api/admin/inventory/reconcile', {});
    toast(r.fixed.length ? `صُحّح ${r.fixed.length} رصيد ليطابق الدفتر` : 'كل الأرصدة مطابقة للدفتر', 'ok');
    await loadSection('inventory');
  }),

  // الموظفون
  'employee-new': () => openModal({ type: 'employee-form', doc: null }),
  'employee-edit': (el) => openModal({ type: 'employee-form', doc: A().employees.find((x) => x.id === el.dataset.id) }),
  'employee-save': (_el, _e, d) => busy(async () => {
    const doc = state.modal.doc;
    await post('/api/admin/employees', { id: doc?.id, name: d.name, role: d.role, phone: d.phone || null, pin: d.pin || undefined, active: doc ? d.active : true });
    state.modal = null; toast('حُفظ الموظف', 'ok'); await loadSection('employees');
  }),

  // الإعدادات
  'settings-add-pt': () => { const st = A().settings; st.paymentTypes.push({ id: `pt${Date.now().toString(36)}`, name: 'طريقة جديدة', kind: 'other', active: true }); render(); },
  'settings-save': (_el, _e, d) => busy(async () => {
    const st = A().settings;
    const names = String(d.dining).split(/[،,]/).map((x) => x.trim()).filter(Boolean);
    const body = {
      name: d.name, address: d.address, phone: d.phone,
      receipt: { header: d.header, footer: d.footer, showCustomer: d.showCustomer },
      tax: { mode: d.taxMode, rateBp: d.taxMode === 'none' ? 0 : percentToBp(d.taxRate), name: d.taxName || 'ضريبة' },
      loyalty: { enabled: d.loyaltyEnabled, rateBp: percentToBp(d.loyaltyRate) },
      cashVarianceAlert: num(d.cashVarianceAlert, 'تنبيه الفرق'),
      paymentTypes: st.paymentTypes.map((p, i) => ({ id: p.id, name: d[`pt_name_${i}`], kind: d[`pt_kind_${i}`], active: d[`pt_active_${i}`] })),
      diningOptions: names.map((n, i) => ({ id: st.diningOptions.find((x) => x.name === n)?.id ?? `d${i}${Date.now().toString(36)}`, name: n })),
      features: { kds: d.kds, openTickets: d.openTickets },
    };
    A().settings = await put('/api/admin/settings', body);
    state.settings = A().settings;
    if (state.shop) state.shop.name = A().settings.name;
    toast('حُفظت الإعدادات', 'ok');
  }),
});

export { sub as currentAdminSection };
