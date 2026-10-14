// محاكاة محلية لنشر Vercel: يخدم out/ كملفات ثابتة، ويمرر /api/* إلى api/index.js كما تفعل Vercel.
// node scripts/build_vercel.mjs && MORECASH_ALLOW_MEMORY=1 node scripts/vercel_dev.mjs
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import handler from '../api/index.js';

const OUT = resolve(fileURLToPath(new URL('../out', import.meta.url)));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const PORT = Number(process.env.PORT ?? 3100);

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) return handler(req, res);
  let file = resolve(join(OUT, decodeURIComponent(url.pathname)));
  if (!file.startsWith(OUT + sep) && file !== OUT) { res.writeHead(403); return res.end(); }
  try { if ((await stat(file)).isDirectory()) file = join(file, 'index.html'); } catch { file = join(OUT, 'index.html'); }
  try {
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
}).listen(PORT, '127.0.0.1', () => console.log(`vercel-dev يعمل http://127.0.0.1:${PORT}`));
