// تشفير عبر Web Crypto (متاح في Node 20+ وفي المتصفح).

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export function randomToken(bytes = 32) {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(text) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

/**
 * بصمة الرمز السري (PIN) = HMAC-SHA256(سر الخادم، PIN).
 * تسمح بالبحث المباشر وفرض عدم تكرار الرمز بين الموظفين. الحماية الفعلية لرمز من 4–6 أرقام
 * هي تحديد المحاولات (auth.js) وإبقاء السر خارج قاعدة البيانات (PIN_PEPPER).
 */
export async function pinLookup(secret, pin) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(`pin:${pin}`)));
}

export function validPin(pin) {
  return typeof pin === 'string' && /^\d{4,6}$/.test(pin) && !/^(\d)\1+$/.test(pin);
}
