// محوّل HTTP: يحوّل طلبات Node إلى app.handle، ويخدم الواجهة (public/) والوحدات المشتركة (shared/).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.woff2': 'font/woff2',
};
const MAX_BODY = 256 * 1024;
const MAX_SCAN_BODY = 4 * 1024 * 1024; // صورة فاتورة مضغوطة (Vercel يقبل حتى 4.5 م.ب)
const COOKIE = 'mc_session';
const DEVICE_COOKIE = 'mc_device';
const PLATFORM_COOKIE = 'mc_platform';
const DEVICE_DAYS = 90;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
};

function readCookie(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

async function readBody(req, limit = MAX_BODY) {
  // Vercel يوفّر req.body محللاً مسبقاً؛ خادم Node العادي يقرأ التدفق
  if ('body' in req && req.body !== undefined) {
    let parsed;
    try { parsed = req.body; } catch { throw Object.assign(new Error('bad json'), { status: 400 }); }
    if (typeof parsed === 'string') { try { parsed = parsed ? JSON.parse(parsed) : {}; } catch { throw Object.assign(new Error('bad json'), { status: 400 }); } }
    if (JSON.stringify(parsed ?? {}).length > limit) throw Object.assign(new Error('too large'), { status: 413 });
    return parsed ?? {};
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('too large'), { status: 413 });
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw Object.assign(new Error('bad json'), { status: 400 }); }
}


/** معالجة طلب /api/* — مشتركة بين خادم Node ودالة Vercel */
export async function handleApiRequest(app, req, res, { secureCookie = false, trustProxy = false, log = console } = {}) {
  const url = new URL(req.url, 'http://local');
  const send = (status, type, body, headers = {}) => { res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, ...headers }); res.end(body); };
  try {
      // حماية CSRF: الطلبات المغيِّرة تتطلب ترويسة مخصصة (لا ترسلها النماذج العابرة للمواقع) و JSON
      if (req.method !== 'GET') {
        if (req.headers['x-requested-with'] !== 'morecash') return send(403, 'application/json', JSON.stringify({ error: 'CSRF' }));
        if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return send(415, 'application/json', JSON.stringify({ error: 'JSON_REQUIRED' }));
      }
      const body = req.method === 'GET' ? {} : await readBody(req, url.pathname === '/api/admin/inventory/scan' ? MAX_SCAN_BODY : MAX_BODY);
      const ip = trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress : req.socket.remoteAddress;
      const result = await app.handle({
        method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body,
        token: readCookie(req.headers.cookie, COOKIE), deviceToken: readCookie(req.headers.cookie, DEVICE_COOKIE), platformToken: readCookie(req.headers.cookie, PLATFORM_COOKIE), ip,
      });
      const headers = { 'Cache-Control': 'no-store' };
      // Lax لا Strict: Safari لا يرسل كوكي Strict إن فُتح الموقع من رابط في تطبيق آخر (حتى بعد التحديث)،
      // فيظهر الجهاز كأنه غير مربوط. الحماية من CSRF قائمة بترويسة X-Requested-With و JSON أعلاه.
      const attrs = `Path=/; HttpOnly; SameSite=Lax${secureCookie ? '; Secure' : ''}`;
      const cookies = [];
      if (result.setToken !== undefined) {
        cookies.push(result.setToken ? `${COOKIE}=${result.setToken}; ${attrs}; Max-Age=${12 * 3600}` : `${COOKIE}=; ${attrs}; Max-Age=0`);
      }
      if (result.setDevice !== undefined) {
        cookies.push(result.setDevice ? `${DEVICE_COOKIE}=${result.setDevice}; ${attrs}; Max-Age=${DEVICE_DAYS * 86400}` : `${DEVICE_COOKIE}=; ${attrs}; Max-Age=0`);
      }
      if (result.setPlatform !== undefined) {
        // جلسة لوحة المزوّد: قصيرة ومحصورة بمسار /api/platform
        const pattrs = `Path=/api/platform; HttpOnly; SameSite=Strict${secureCookie ? '; Secure' : ''}`;
        cookies.push(result.setPlatform ? `${PLATFORM_COOKIE}=${result.setPlatform}; ${pattrs}; Max-Age=${4 * 3600}` : `${PLATFORM_COOKIE}=; ${pattrs}; Max-Age=0`);
      }
      if (cookies.length) headers['Set-Cookie'] = cookies;
      return send(result.status, 'application/json; charset=utf-8', JSON.stringify(result.body), headers);
  } catch (e) {
    if (!e.status) log.error?.(e);
    return send(e.status ?? 500, 'application/json; charset=utf-8', JSON.stringify({ error: e.status === 413 ? 'TOO_LARGE' : e.status === 400 ? 'BAD_JSON' : 'INTERNAL' }));
  }
}

export function createHttpServer(app, { publicDir, sharedDir, secureCookie = false, trustProxy = false, log = console }) {
  const roots = { '/shared/': resolve(sharedDir), '/': resolve(publicDir) };

  async function serveStatic(res, urlPath) {
    const prefix = urlPath.startsWith('/shared/') ? '/shared/' : '/';
    const root = roots[prefix];
    const rel = normalize(decodeURIComponent(urlPath.slice(prefix.length) || 'index.html'));
    const file = resolve(join(root, rel));
    if (file !== root && !file.startsWith(root + sep)) return send(res, 403, 'text/plain; charset=utf-8', 'ممنوع');
    try {
      const s = await stat(file);
      const target = s.isDirectory() ? join(file, 'index.html') : file;
      const body = await readFile(target);
      const type = TYPES[extname(target)] ?? 'application/octet-stream';
      return send(res, 200, type, body, { 'Cache-Control': type.startsWith('text/html') ? 'no-cache' : 'no-cache' });
    } catch {
      // تطبيق صفحة واحدة: أي مسار غير موجود يعيد index.html
      if (!extname(rel)) return serveStatic(res, '/index.html');
      return send(res, 404, 'text/plain; charset=utf-8', 'غير موجود');
    }
  }

  function send(res, status, type, body, headers = {}) {
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, ...headers });
    res.end(body);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    try {
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain; charset=utf-8', '');
        return await serveStatic(res, url.pathname);
      }
      return await handleApiRequest(app, req, res, { secureCookie, trustProxy, log });
    } catch (e) {
      if (!e.status) log.error?.(e);
      return send(res, e.status ?? 500, 'application/json; charset=utf-8', JSON.stringify({ error: e.status === 413 ? 'TOO_LARGE' : e.status === 400 ? 'BAD_JSON' : 'INTERNAL' }));
    }
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  return server;
}
