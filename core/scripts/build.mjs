// Сборка пакета @cyborg-harness/core в core/dist: JS без бандла (импорты `.ts` переписаны в `.js`) и .d.ts.
// Два проекта: ядро без DOM (core/tsconfig.build.json) и элементы окна с DOM (core/elements/tsconfig.build.json); оба пишут в один dist.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const core = join(import.meta.dirname, '..');
const dist = join(core, 'dist');
const tsc = join(core, '..', 'node_modules', 'typescript7', 'bin', 'tsc');

// Ядро собирается против настоящего пакета контрактов (paths пуст), а не против его исходников: сначала собираем contracts/dist.
execFileSync(process.execPath, [join(core, '..', 'contracts', 'scripts', 'build.ts')], { stdio: 'inherit' });

rmSync(dist, { recursive: true, force: true });
for (const project of ['tsconfig.build.json', 'elements/tsconfig.build.json']) {
  execFileSync(process.execPath, [tsc, '-p', join(core, project)], { stdio: 'inherit' });
}

// Объявления tsc оставляет с расширением `.ts` в относительных импортах: у потребителя без allowImportingTsExtensions они не читаются.
const relativeTs = /(\bfrom\s*|\bimport\s*\(\s*)(['"])(\.\.?\/[^'"]*)\.ts\2/g;
function fixDeclarations(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) fixDeclarations(file);
    else if (entry.name.endsWith('.d.ts')) {
      const text = readFileSync(file, 'utf8');
      const fixed = text.replace(relativeTs, '$1$2$3.js$2');
      if (fixed !== text) writeFileSync(file, fixed);
    }
  }
}
fixDeclarations(dist);
