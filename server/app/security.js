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

/** أرقام عربية (٠-٩) وفارسية (۰-۹) → أرقام لاتينية. لوحة الآيباد العربية تكتب "٤٨٢٦" في حقل الرمز */
export function normalizePin(pin) {
  if (typeof pin !== 'string') return pin;
  return pin.trim().replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

export function validPin(pin) {
  return typeof pin === 'string' && /^\d{4,6}$/.test(pin) && !/^(\d)\1+$/.test(pin);
}

// ---------------------------------------------------------------- كلمات مرور حسابات المقاهي
const PBKDF2_ITER = 210_000;

async function pbkdf2(password, saltHex, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const salt = Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

/** يعيد "pbkdf2$<iter>$<salt>$<hash>" */
export async function hashPassword(password, { iterations = PBKDF2_ITER } = {}) {
  const salt = randomToken(16);
  return `pbkdf2$${iterations}$${salt}$${await pbkdf2(password, salt, iterations)}`;
}

export async function verifyPassword(password, stored) {
  const [kind, iter, salt, expected] = String(stored ?? '').split('$');
  if (kind !== 'pbkdf2' || !salt || !expected) return false;
  const actual = await pbkdf2(password, salt, Number(iter));
  let diff = actual.length ^ expected.length;
  for (let i = 0; i < Math.min(actual.length, expected.length); i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
