import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Сборка деклараций пакета: `node scripts/build.ts [каталог]`, по умолчанию `dist`. Её же зовёт `prepack`, поэтому tarball не собирается из устаревшего dist.
const contracts = path.resolve(import.meta.dirname, '..');
const tsc = path.join(contracts, '..', 'node_modules', 'typescript7', 'bin', 'tsc');

/**
 * Заменяет `.ts` на `.js` в относительных путях деклараций. `rewriteRelativeImportExtensions` правит только выпускаемый JS, а в `.d.ts` остаются `./plugin.ts`:
 * потребителю без `allowImportingTsExtensions` такие пути не разрешаются. Пакеты по имени (`@scope/pkg/x.ts`) не трогаются.
 */
export function rewriteSpecifiers(text: string): string {
  return text.replace(/(\bfrom\s+|\bimport\s*\(\s*)(['"])(\.{1,2}\/[^'"]*)\.ts\2/g, '$1$2$3.js$2');
}

/** Собирает `.d.ts` в `outDir` (старое содержимое каталога удаляется). */
export function buildDeclarations(outDir: string): void {
  fs.rmSync(outDir, { recursive: true, force: true });
  execFileSync(process.execPath, [tsc, '-p', path.join(contracts, 'tsconfig.build.json'), '--outDir', outDir], { stdio: 'inherit' });
  for (const file of fs.readdirSync(outDir, { recursive: true, encoding: 'utf8' })) {
    const full = path.join(outDir, file);
    fs.writeFileSync(full, rewriteSpecifiers(fs.readFileSync(full, 'utf8')));
  }
}

if (process.argv[1] === import.meta.filename) buildDeclarations(path.resolve(process.argv[2] ?? path.join(contracts, 'dist')));
