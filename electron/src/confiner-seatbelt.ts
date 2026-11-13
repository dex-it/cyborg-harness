import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import type { ConfinePolicy, ConfinerLauncher, ConfinerStatus } from './confiner.ts';

// TR-22a (ADR-CH-0019, п. 4): Seatbelt macOS через `/usr/bin/sandbox-exec -p <профиль>`. Решение «sandbox-exec против помощника»: берём `sandbox-exec` - он есть в каждой macOS,
// ничего не добавляет в поставку (нет своего бинарника, который надо подписывать и нотаризовать), профиль читается человеком. Цена: утилита помечена устаревшей
// (man sandbox-exec), `sandbox_init` непубличен. Смягчение: ограничитель за интерфейсом `ConfinerLauncher`, а работает он или нет, доказывает canary хоста при каждом запуске
// (сокет не открывается); если Apple уберёт утилиту, статус «недоступен» опустит хост на уровень 2 с причиной, а замена - помощник с `sandbox_init` - реализация того же интерфейса.

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** Что хост читает всегда: динамический загрузчик, системные библиотеки, источники случайности. Содержимое данных пользователя сюда не входит. */
const SYSTEM_READ: readonly { readonly kind: 'subpath' | 'literal'; readonly path: string }[] = [
  { kind: 'subpath', path: '/usr/lib' },
  { kind: 'subpath', path: '/System' },
  { kind: 'subpath', path: '/Library/Apple' },
  { kind: 'subpath', path: '/private/var/db/dyld' },
  { kind: 'literal', path: '/dev/null' },
  { kind: 'literal', path: '/dev/urandom' },
  { kind: 'literal', path: '/dev/random' },
  { kind: 'literal', path: '/dev/zero' },
  { kind: 'literal', path: '/' },
];

/** Строка SBPL: кавычка и обратная косая экранируются; управляющий символ в пути - ошибка (профиль, собранный из такого пути, значил бы другое). */
export function sbString(value: string): string {
  // eslint-disable-next-line no-control-regex -- причина: управляющие символы в пути профиля недопустимы
  if (/[\u0000-\u001f]/.test(value)) throw new Error(`путь с управляющим символом не годится для профиля Seatbelt: ${JSON.stringify(value)}`);
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/**
 * Профиль: всё разрешено по умолчанию, кроме сети, `fork`, исполнения чего-либо, кроме бинарника Node, записи в файлы и чтения содержимого файлов вне названных путей.
 * Метаданные (`stat`, существование пути) не закрыты: без них не открыть и разрешённый путь через его родителей; содержимое и список каталога вне разрешённого - закрыты.
 */
export function seatbeltProfile(policy: ConfinePolicy): string {
  const nodes = policy.exec.map((p) => `(literal ${sbString(p)})`);
  const allowed = [...SYSTEM_READ.map((r) => `(${r.kind} ${sbString(r.path)})`), ...policy.read.map((p) => `(subpath ${sbString(p)})`), ...nodes];
  return [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    '(deny process-fork)',
    `(deny process-exec* (require-not (require-any ${nodes.join(' ')})))`,
    '(deny file-write*)',
    '(allow file-write* (literal "/dev/null"))',
    `(deny file-read-data (require-not (require-any ${allowed.join(' ')})))`,
  ].join('\n');
}

function probe(binary: string): ConfinerStatus {
  if (!fs.existsSync(binary)) return { ok: false, reason: `нет ${binary}` };
  // Сам запуск под самым простым профилем: утилита могла быть запрещена политикой или песочницей приложения.
  const run = spawnSync(binary, ['-p', '(version 1)(allow default)', '/usr/bin/true'], { encoding: 'utf8', timeout: 5000 });
  if (run.status !== 0) return { ok: false, reason: `${binary} не запускается: ${run.error?.message ?? (run.stderr.trim() || `код ${String(run.status)}`)}` };
  return { ok: true, files: true, summary: 'Seatbelt (sandbox-exec): сетевые сокеты, fork и запуск программ закрыты ОС, чтение содержимого файлов вне каталога плагина и запись закрыты' };
}

export function seatbeltConfiner(binary: string = SANDBOX_EXEC): ConfinerLauncher {
  return {
    name: 'seatbelt',
    status: probe(binary),
    wrap: ({ command, args }, policy) => ({ command: binary, args: ['-p', seatbeltProfile(policy), command, ...args] }),
  };
}
