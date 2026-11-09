// صور الأصناف: تُجلب مرة وتُحفظ على الجهاز، ولا يُعاد جلبها إلا إن تغيّر إصدار صورة (imageV) في القائمة.
import { get } from './api.js';
import { render, state } from './ui.js';

const key = () => `morecash.img.${state.shop?.id ?? 'demo'}`;

function load() {
  if (state.images) return;
  try { state.images = JSON.parse(localStorage.getItem(key()) ?? '{}') ?? {}; } catch { state.images = {}; }
}
function save() {
  try { localStorage.setItem(key(), JSON.stringify(state.images)); } catch { /* المساحة ممتلئة: تبقى في الذاكرة */ }
}

/** مصدر صورة الصنف إن كانت محمّلة بالإصدار الحالي */
export function imageSrc(item) {
  load();
  const img = item?.imageV ? state.images[item.id] : null;
  return img && img.v === item.imageV ? img.src : null;
}

export async function syncImages(items = []) {
  load();
  const need = items.some((i) => i.imageV && state.images[i.id]?.v !== i.imageV);
  if (!need || state.online === false) return;
  try {
    state.images = await get('/api/pos/images');
    save();
    render();
  } catch { /* الصور ليست حرجة */ }
}

export function putImage(id, v, src) { load(); if (v) state.images[id] = { v, src }; else delete state.images[id]; save(); }

/** تصغير صورة الكاميرا/المعرض إلى مربع 240 بكسل JPEG قبل الرفع (≈ 15–30 كيلوبايت) */
export async function resizeImage(file, size = 240) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = url; });
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const s = Math.min(img.naturalWidth, img.naturalHeight);
    const g = canvas.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, size, size);
    g.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, size, size);
    let src = canvas.toDataURL('image/jpeg', 0.8);
    if (src.length > 110_000) src = canvas.toDataURL('image/jpeg', 0.6);
    return { src, data: src.split(',')[1], mediaType: 'image/jpeg' };
  } finally { URL.revokeObjectURL(url); }
}
