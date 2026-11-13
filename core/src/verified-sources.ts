import { registerHooks } from 'node:module';
import type { VerifiedPackage } from './provenance.ts';

// TR-11 (ADR-CH-0017): исполнять то, что проверили. Хук загрузки модулей (`module.registerHooks`, Node 24, в том же потоке) отдаёт `import()` байты, которые ядро
// прочитало и проверило, а не файл с диска. Адрес модуля остаётся `file:`, поэтому `import.meta.url` и относительные импорты плагина работают как раньше;
// файл под каталогом плагина, которого нет в проверенном наборе, не загружается вовсе. Подмена файла на диске после проверки до исполнения не доходит.
// Способ выбран по замеру на macOS, Linux и в utilityProcess Electron (docs/05-verification/provenance-loading.md); `data:`-адрес ломает `import.meta.url`
// и относительные импорты, копия во временный каталог остаётся открытой для процесса того же пользователя.

interface Installed {
  readonly base: string;
  readonly files: ReadonlyMap<string, Uint8Array>;
}

const installed = new Map<string, Installed>();
let hooked = false;

type Format = 'module' | 'commonjs' | 'json';

function formatOf(rel: string, files: ReadonlyMap<string, Uint8Array>): Format {
  if (rel.endsWith('.mjs')) return 'module';
  if (rel.endsWith('.cjs')) return 'commonjs';
  if (rel.endsWith('.json')) return 'json';
  // `.js`: как решил бы Node по ближайшему package.json, но только по проверенным байтам.
  const dirs = rel.split('/').slice(0, -1);
  for (let depth = dirs.length; depth >= 0; depth--) {
    const manifest = files.get([...dirs.slice(0, depth), 'package.json'].join('/'));
    if (manifest === undefined) continue;
    try {
      const raw: unknown = JSON.parse(Buffer.from(manifest).toString('utf8'));
      return typeof raw === 'object' && raw !== null && 'type' in raw && raw.type === 'module' ? 'module' : 'commonjs';
    } catch {
      return 'commonjs';
    }
  }
  return 'commonjs';
}

function hook(): void {
  if (hooked) return;
  hooked = true;
  registerHooks({
    load(url, context, nextLoad) {
      for (const { base, files } of installed.values()) {
        if (!url.startsWith(base)) continue;
        const rel = decodeURIComponent(new URL(url).pathname.slice(new URL(base).pathname.length));
        const bytes = files.get(rel);
        if (bytes === undefined) throw new Error(`${rel}: файла нет среди проверенных, загрузка отклонена`);
        return { format: formatOf(rel, files), source: bytes, shortCircuit: true };
      }
      return nextLoad(url, context);
    },
  });
}

/** Проверенные байты плагина становятся источником его модулей в этом процессе. Повтор для того же плагина заменяет прежние. */
export function installVerified(pluginId: string, pack: VerifiedPackage): void {
  hook();
  installed.set(pluginId, { base: pack.base, files: new Map(Object.entries(pack.files).map(([file, data]) => [file, Buffer.from(data, 'base64')])) });
}

/** Плагин снят: его байты хост больше не держит. */
export function releaseVerified(pluginId: string): void {
  installed.delete(pluginId);
}

/** Поставлен ли проверенный набор для плагина (тесты). */
export const hasVerified = (pluginId: string): boolean => installed.has(pluginId);
