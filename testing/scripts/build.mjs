// Сборка пакета @cyborg-harness/testing в testing/dist: JS без бандла (импорты `.ts` переписаны в `.js`) и .d.ts; та же схема, что у core/scripts/build.mjs.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
