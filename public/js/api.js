// الاتصال بالخادم. في النسخة التجريبية يُحقن backend داخلي (نفس كود الخادم يعمل في المتصفح).

export class ApiError extends Error {
  constructor(status, code, detail) {
    super(code);
    this.status = status;
    this.code = code;
    this.detail = detail ?? null;
  }
}

export async function api(method, path, body, query) {
  const qs = query ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== ''))}` : '';
  if (globalThis.MORECASH_BACKEND) {
    const r = await globalThis.MORECASH_BACKEND({ method, path, body, query: query ?? {} });
    if (r.status !== 200) throw new ApiError(r.status, r.body?.error ?? 'ERROR', r.body?.detail);
    return structuredClone(r.body);
  }
  let res;
  try {
    res = await fetch(`${path}${qs}`, {
      method,
      credentials: 'same-origin',
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-Requested-With': 'morecash' },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
  } catch {
    throw new ApiError(0, 'NETWORK');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP_${res.status}`, data.detail);
  return data;
}

export const get = (path, query) => api('GET', path, undefined, query);
export const post = (path, body) => api('POST', path, body);
export const put = (path, body) => api('PUT', path, body);
export const del = (path) => api('DELETE', path, {});

/** معرّف فريد لكل عملية (idempotency) */
export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
