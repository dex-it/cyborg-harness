// Сборка пакета @cyborg-harness/electron в electron/dist: JS без бандла (импорты `.ts` переписаны в `.js`), .d.ts
// и оболочка вида одним файлом для окна (`dist/shell/shell.js` и `shell.css`: приложение отдаёт их под origin плагина).
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';

const pkg = join(import.meta.dirname, '..');
const dist = join(pkg, 'dist');
const tsc = join(pkg, '..', 'node_modules', 'typescript7', 'bin', 'tsc');

rmSync(dist, { recursive: true, force: true });
execFileSync(process.execPath, [tsc, '-p', join(pkg, 'tsconfig.build.json')], { stdio: 'inherit' });

// Объявления tsc оставляет с расширением `.ts` в относительных импортах: у потребителя без allowImportingTsExtensions они не читаются.
const relativeTs = /(\bfrom\s*|\bimport\s*\(\s*)'(\.\.?\/[^']*)\.ts'/g;
function fixDeclarations(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) fixDeclarations(file);
    else if (entry.name.endsWith('.d.ts')) {
      const text = readFileSync(file, 'utf8');
      const fixed = text.replace(relativeTs, "$1'$2.js'");
      if (fixed !== text) writeFileSync(file, fixed);
    }
  }
}
fixDeclarations(dist);

// Оболочке вида нужен один скрипт без модулей: он идёт в <script src> под CSP `script-src 'self'`.
const shell = join(pkg, 'src', 'shell');
if (existsSync(join(shell, 'shell.ts'))) {
  mkdirSync(join(dist, 'shell'), { recursive: true });
  await build({
    bundle: true,
    sourcemap: true,
    logLevel: 'warning',
    platform: 'browser',
    format: 'iife',
    target: 'chrome130',
    entryPoints: [join(shell, 'shell.ts')],
    outfile: join(dist, 'shell', 'shell.js'),
  });
  cpSync(join(shell, 'shell.css'), join(dist, 'shell', 'shell.css'));
}
