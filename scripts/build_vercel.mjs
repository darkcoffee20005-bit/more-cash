// بناء Vercel: يجمع الواجهة (public/) والوحدات المشتركة (shared/) في out/، ويضيف النسخة التجريبية demo.html.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'out');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(join(ROOT, 'public'), OUT, { recursive: true });
cpSync(join(ROOT, 'shared'), join(OUT, 'shared'), { recursive: true });
execFileSync(process.execPath, [join(ROOT, 'scripts', 'build_demo.mjs'), join(OUT, 'demo.html')], { stdio: 'inherit' });
console.log('vercel output ready: out/');
