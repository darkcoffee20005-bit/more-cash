// يبني النسخة التجريبية كصفحة HTML واحدة: الواجهة + خادم التطبيق نفسه + MemoryDb داخل المتصفح.
// الاستخدام: node scripts/build_demo.mjs [out.html] [--artifact]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ARTIFACT = process.argv.includes('--artifact');
const OUT = resolve(process.argv.slice(2).find((a) => !a.startsWith('--')) ?? join(ROOT, 'dist', 'morecash-demo.html'));

const modules = new Map();
const order = [];
const idOf = (p) => `__m_${relative(ROOT, p).replace(/[^a-zA-Z0-9]/g, '_')}`;
const resolveSpec = (from, spec) => {
  const p = normalize(join(dirname(from), spec));
  // الواجهة تستورد ../../shared/ نسبةً لمسار الخادم /shared/؛ على القرص المجلد في الجذر
  return p.replace(`${join(ROOT, 'public', 'shared')}`, join(ROOT, 'shared')).replace(`${join(ROOT, 'shared', '..', 'shared')}`, join(ROOT, 'shared'));
};

function load(path) {
  if (modules.has(path)) return;
  modules.set(path, null);
  let code = readFileSync(path, 'utf8');
  const header = [];
  const deps = [];
  code = code.replace(/^import\s+\{([^}]*)\}\s+from\s+'([^']+)';?[ \t]*$/gms, (_, names, spec) => {
    const dep = resolveSpec(path, spec);
    deps.push(dep);
    header.push(`const { ${names.split(',').map((n) => n.trim()).filter(Boolean).map((n) => n.replace(/\s+as\s+/, ': ')).join(', ')} } = ${idOf(dep)};`);
    return '';
  });
  code = code.replace(/^import\s+\*\s+as\s+(\w+)\s+from\s+'([^']+)';?[ \t]*$/gm, (_, name, spec) => {
    const dep = resolveSpec(path, spec);
    deps.push(dep);
    header.push(`const ${name} = ${idOf(dep)};`);
    return '';
  });
  if (/^\s*import\s/m.test(code)) throw new Error(`unsupported import in ${path}`);
  const exported = [];
  code = code.replace(/^export\s+(async\s+function|function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm, (_, kind, name) => { exported.push(name); return `${kind} ${name}`; });
  code = code.replace(/^export\s+\{([^}]*)\};?\s*$/gm, (_, list) => {
    for (const part of list.split(',').map((x) => x.trim()).filter(Boolean)) {
      const [local, as] = part.split(/\s+as\s+/);
      exported.push(as ? `${as}: ${local}` : local);
    }
    return '';
  });
  if (/^export\s/m.test(code)) throw new Error(`unsupported export in ${path}`);
  for (const d of deps) {
    try { readFileSync(d); } catch { throw new Error(`missing ${d} (from ${path})`); }
    load(d);
  }
  modules.set(path, { id: idOf(path), code: `${header.join('\n')}\n${code}`, exported });
  order.push(path);
}
load(join(ROOT, 'demo', 'main.js'));

const js = order.map((p) => {
  const m = modules.get(p);
  return `// ---- ${relative(ROOT, p)}\nconst ${m.id} = await (async () => {\n${m.code}\nreturn { ${m.exported.join(', ')} };\n})();`;
}).join('\n\n');

const css = readFileSync(join(ROOT, 'public', 'css', 'app.css'), 'utf8');
const fonts = 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600;700&family=Readex+Pro:wght@400;500;600;700&display=swap';
const icon = `data:image/svg+xml;base64,${Buffer.from(readFileSync(join(ROOT, 'public', 'icon.svg'))).toString('base64')}`;

let html;
if (ARTIFACT) {
  html = `<title>مور كاش</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="${fonts}">
<style>
${css}
html, body { height: 100%; }
body { background: var(--petrol-900); padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }
#app { background: var(--bg); }
</style>
<div id="app" dir="rtl" lang="ar"></div>
<div id="print-area" aria-hidden="true"></div>
<script type="module">
${js}
</script>`;
} else {
  html = `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>مور كاش — نسخة تجريبية</title><link rel="icon" href="${icon}"><link rel="stylesheet" href="${fonts}"><style>
${css}
</style></head><body><div id="app"></div><div id="print-area" aria-hidden="true"></div><script type="module">
${js}
</script></body></html>`;
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, html);
console.log(`built ${relative(process.cwd(), OUT)}: ${order.length} modules, ${(html.length / 1024).toFixed(0)} KB`);
