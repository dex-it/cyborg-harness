import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// Снимок публичного API пакета: собранные декларации без комментариев. Правило: снимок изменился - версия пакета выше, чем в снимке ветки назначения.
const contracts = path.resolve(import.meta.dirname, '..');
export const SNAPSHOT_FILE = path.join(contracts, 'api-snapshot.txt');
const HEADER = /^\/\/ @cyborg-harness\/contracts (\S+)\n/;
const NOTE = '// Снимок публичных деклараций без комментариев; правила - README.md, раздел «Установка и версии». Обновление: npm run snapshot:contracts после повышения версии в package.json.\n';

export interface Snapshot {
  readonly version: string;
  readonly body: string;
}

/** Все `.d.ts` каталога в порядке имён, без комментариев и с единым форматированием: правка JSDoc или отступов API не меняет. */
export function normalizeDeclarations(dir: string): string {
  const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
  const files = fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.d.ts')).sort();
  return files
    .map((file) => `// ---- ${file}\n${printer.printFile(ts.createSourceFile(file, fs.readFileSync(path.join(dir, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS))}`)
    .join('');
}

export function renderSnapshot(version: string, body: string): string {
  return `// @cyborg-harness/contracts ${version}\n${NOTE}${body}`;
}

export function parseSnapshot(text: string): Snapshot {
  const match = HEADER.exec(text);
  if (!match?.[1]) throw new Error('в снимке нет строки-заголовка «// @cyborg-harness/contracts <версия>»');
  const rest = text.slice(match[0].length);
  return { version: match[1], body: rest.startsWith(NOTE) ? rest.slice(NOTE.length) : rest };
}

export function readSnapshot(): Snapshot {
  return parseSnapshot(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
}

/** Версия с суффиксом (`1.0.0-dev`) - линия разработки ещё не выпущенного пакета: её API меняется свободно, правило повышения действует после первого выпуска. */
const isPrerelease = (version: string): boolean => version.includes('-');

/** Порядок по числам версии; у равных чисел выпуск старше предрелиза, а два предрелиза не сравниваются. */
function lower(a: string, b: string): boolean {
  const [x, y] = [a, b].map((v) => (v.split(/[-+]/)[0] ?? '').split('.').map(Number));
  for (let i = 0; i < 3; i++) {
    if ((x?.[i] ?? 0) !== (y?.[i] ?? 0)) return (x?.[i] ?? 0) < (y?.[i] ?? 0);
  }
  return isPrerelease(a) && !isPrerelease(b);
}

/** Снимок в репозитории против собранных деклараций `dir` и версии пакета. */
export function checkSnapshot(dir: string, packageVersion: string): string[] {
  const snapshot = readSnapshot();
  const problems: string[] = [];
  if (snapshot.version !== packageVersion) problems.push(`снимок снят для версии ${snapshot.version}, а в package.json ${packageVersion}: обновите снимок (npm run snapshot:contracts)`);
  if (snapshot.body !== normalizeDeclarations(dir)) problems.push(`декларации пакета изменены, а снимок ${snapshot.version} - нет: повысьте версию пакета, запишите изменение в CHANGELOG.md и обновите снимок (npm run snapshot:contracts)`);
  return problems;
}

/** Снимок ветки против снимка в ветке назначения (`base`; `undefined` - снимка там ещё нет). */
export function compareWithBase(base: Snapshot | undefined, current: Snapshot): string[] {
  if (!base) return [];
  if (lower(current.version, base.version)) return [`версия пакета понижена: ${base.version} -> ${current.version}`];
  if (current.body !== base.body && current.version === base.version && !isPrerelease(base.version)) return [`публичные декларации изменены без повышения версии пакета (${base.version}): повысьте версию по правилам README.md и обновите снимок`];
  return [];
}
