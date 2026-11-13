import path from 'node:path';
import { checkPlugin, formatProblem, type CheckOptions } from '@cyborg-harness/core/plugin-check';
import { buildPlugin } from './build.ts';
import { buildDelivery } from './delivery.ts';
import { packPlugin } from './pack.ts';
import { DEFAULT_DAYS, keygen, signPlugin, verifyPlugin } from './sign.ts';

/** Куда команда пишет: итог и права - в `out`, нарушения - в `err`. */
export interface CliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

const USAGE = [
  'Использование:',
  '  cyborg-plugin check [каталог] [--source] [--out <каталог>] [--api-version <x.y.z>] [--declarations <файл>]... [--declarations-package <имя>]...',
  '  cyborg-plugin build [каталог] [--out <каталог>] [--api-version <x.y.z>] [--declarations <файл>]... [--declarations-package <имя>]...',
  '  cyborg-plugin delivery <каталог плагина>... --out <каталог> [--api-version <x.y.z>] [--declarations <файл>]... [--declarations-package <имя>]...',
  '  cyborg-plugin pack [каталог] [--out <файл>] [--api-version <x.y.z>] [--dry-run]',
  '  cyborg-plugin keygen --out <префикс>',
  '  cyborg-plugin sign [каталог] --key <файл закрытого ключа> [--days <N> | --expires <дата>]',
  '  cyborg-plugin verify <каталог или архив .tgz> --key <файл открытого ключа или ed25519:...>...',
  '  каталог                      check и build: каталог плагина с manifest.json (по умолчанию текущий); pack: собранный каталог (по умолчанию ./dist)',
  '  delivery                     поставка приложения: каждый плагин собирается как build и ложится в <out>/<id>, рядом delivery.json с хешами файлов (P-07); --out обязателен',
  '  --source                     check: главная часть грузится как есть, без сборки, - npm-пакеты в ней нарушение (по умолчанию её соберёт build, и пакеты допустимы)',
  '  --out <каталог>              check и build: каталог результата сборки (по умолчанию <каталог>/dist); check не читает его как исходники',
  '  --out <файл>                 pack: файл архива (по умолчанию <id>-<версия>.tgz в текущем каталоге)',
  '  --api-version <x.y.z>        версия API, под которую проверяется engines.cyborg (по умолчанию версия установленного ядра)',
  '  --declarations <файл>        файл пакета объявлений рядом с плагином: из него разрешён только import type, и в нём нет кода',
  '  --declarations-package <имя> пакет объявлений по имени (@acme/contracts): разрешён только import type',
  '  keygen                       пара ключей Ed25519: <префикс>.key (закрытый, 0600; хранить как секрет, в репозиторий не класть) и <префикс>.pub (открытый); существующие файлы не затираются',
  '  sign                         подписать собранный каталог (по умолчанию ./dist): integrity.json с хешами файлов, сроком и ключом; потом pack (TR-10, ADR-CH-0017)',
  `  --days <N>                   sign: срок подписи в днях от сегодня (по умолчанию ${String(DEFAULT_DAYS)}); --expires <дата> - срок датой (2027-01-31 или ISO 8601)`,
  '  verify                       проверить подпись так, как её проверит ядро: каталог или архив читается целиком, лишний или изменённый файл, чужой ключ и истёкший срок - отказ; без --key нельзя',
  '  --key <…>                    sign: файл закрытого ключа; verify: доверенный открытый ключ (файл .pub или запись ed25519:…), можно несколько раз',
  '  --dry-run                    pack: проверить состав и перечислить файлы, архив не писать',
  'Код возврата: 0 - нарушений нет, 1 - есть, 2 - неверный вызов.',
];

type Command = 'check' | 'build' | 'delivery' | 'pack' | 'keygen' | 'sign' | 'verify';
const VALUES: Readonly<Record<Command, readonly string[]>> = {
  check: ['--out', '--api-version', '--declarations', '--declarations-package'],
  build: ['--out', '--api-version', '--declarations', '--declarations-package'],
  delivery: ['--out', '--api-version', '--declarations', '--declarations-package'],
  pack: ['--out', '--api-version'],
  keygen: ['--out'],
  sign: ['--key', '--days', '--expires'],
  verify: ['--key'],
};
const SWITCHES: Readonly<Record<Command, readonly string[]>> = { check: ['--source'], build: [], delivery: [], pack: ['--dry-run'], keygen: [], sign: [], verify: [] };

interface Parsed {
  readonly dir: string | undefined;
  /** Все позиционные аргументы: у `delivery` их несколько. */
  readonly dirs: readonly string[];
  readonly values: ReadonlyMap<string, readonly string[]>;
  readonly switches: ReadonlySet<string>;
}

/** Разбор флагов команды: `--имя значение` и `--имя=значение`; текст ошибки, если вызов неверен. */
function parse(command: Command, args: readonly string[]): Parsed | string {
  const dirs: string[] = [];
  const values = new Map<string, string[]>();
  const switches = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (!arg.startsWith('--')) {
      dirs.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq < 0 ? arg : arg.slice(0, eq);
    if (SWITCHES[command].includes(name) && eq < 0) {
      switches.add(name);
      continue;
    }
    if (!VALUES[command].includes(name)) return `неизвестный флаг ${name}`;
    const value = eq < 0 ? args[++i] : arg.slice(eq + 1);
    if (value === undefined || value === '') return `${name}: нужно значение`;
    values.set(name, [...(values.get(name) ?? []), value]);
  }
  if (dirs.length > 1 && command !== 'delivery') return 'каталог один';
  for (const name of ['--out', '--api-version', '--days', '--expires']) {
    if ((values.get(name)?.length ?? 0) > 1) return `${name}: значение одно`;
  }
  return { dir: dirs[0], dirs, values, switches };
}

function checkOptions(parsed: Parsed): CheckOptions & { out?: string } {
  const one = (name: string) => parsed.values.get(name)?.[0];
  const out = one('--out');
  const apiVersion = one('--api-version');
  return {
    declarations: parsed.values.get('--declarations') ?? [],
    declarationPackages: parsed.values.get('--declarations-package') ?? [],
    ...(apiVersion === undefined ? {} : { apiVersion }),
    ...(out === undefined ? {} : { out }),
  };
}

async function runCheck(parsed: Parsed, io: CliIo): Promise<number> {
  const { out, ...options } = checkOptions(parsed);
  const dir = parsed.dir ?? '.';
  const outDir = path.resolve(out ?? path.join(dir, 'dist'));
  // Результат прежней сборки не исходники: его проверяет pack.
  const relOut = path.relative(path.resolve(dir), outDir);
  const ignore = relOut !== '' && !relOut.startsWith('..') && !path.isAbsolute(relOut) ? [relOut] : [];
  const report = await checkPlugin(dir, { ...options, bundled: !parsed.switches.has('--source'), ignore });
  io.out(`Плагин ${report.id ?? '(id не прочитан)'}: ${report.dir}`);
  if (report.manifest) io.out(report.permissions.length > 0 ? `Права:\n${report.permissions.map((p) => `  - ${p}`).join('\n')}` : 'Права: не запрашивает');
  for (const problem of report.problems) io.err(formatProblem(problem));
  if (report.ok) {
    io.out(`Нарушений нет (исходников проверено: ${String(report.files)})`);
    return 0;
  }
  io.err(`Нарушений: ${String(report.problems.length)}`);
  return 1;
}

async function runBuild(parsed: Parsed, io: CliIo): Promise<number> {
  const { out, ...options } = checkOptions(parsed);
  const report = await buildPlugin(parsed.dir ?? '.', { ...options, ...(out === undefined ? {} : { out }) });
  for (const warning of report.warnings) io.err(`предупреждение: ${warning}`);
  for (const problem of report.problems) io.err(formatProblem(problem));
  if (!report.ok) {
    io.err(`Нарушений: ${String(report.problems.length)}; сборка не выполнена или результат не прошёл проверку`);
    return 1;
  }
  io.out(`Плагин ${report.id ?? ''}: ${report.dir}`);
  io.out(`Собрано в ${report.out} (файлов: ${String(report.files.length)})`);
  for (const file of report.files) io.out(`  ${file}`);
  return 0;
}

async function runDelivery(parsed: Parsed, io: CliIo): Promise<number> {
  const out = parsed.values.get('--out')?.[0];
  if (out === undefined || parsed.dirs.length === 0) {
    io.err('cyborg-plugin: delivery: нужны каталоги плагинов и --out');
    for (const line of USAGE) io.err(line);
    return 2;
  }
  const report = await buildDelivery(parsed.dirs, { ...checkOptions(parsed), out });
  for (const warning of report.warnings) io.err(`предупреждение: ${warning}`);
  for (const problem of report.problems) io.err(formatProblem(problem));
  if (!report.ok) {
    io.err(`Нарушений: ${String(report.problems.length)}; поставка не собрана`);
    return 1;
  }
  io.out(`Поставка: ${report.out} (плагинов: ${String(report.plugins.length)}) - ${report.plugins.join(', ')}`);
  return 0;
}

async function runPack(parsed: Parsed, io: CliIo): Promise<number> {
  const out = parsed.values.get('--out')?.[0];
  const apiVersion = parsed.values.get('--api-version')?.[0];
  const report = await packPlugin(parsed.dir ?? 'dist', { dryRun: parsed.switches.has('--dry-run'), ...(out === undefined ? {} : { out }), ...(apiVersion === undefined ? {} : { apiVersion }) });
  for (const problem of report.problems) io.err(formatProblem(problem));
  if (!report.ok) {
    io.err(`Нарушений: ${String(report.problems.length)}; архив не создан`);
    return 1;
  }
  io.out(`Плагин ${report.id ?? ''} ${report.version ?? ''}: ${report.dir}`);
  for (const file of report.files) io.out(`  ${file.path} (${String(file.size)} Б)`);
  io.out(report.archive === undefined ? `Проверено, архив не записан (файлов: ${String(report.files.length)}, в архиве ${String(report.bytes)} Б)` : `Архив: ${report.archive} (файлов: ${String(report.files.length)}, ${String(report.bytes)} Б)`);
  return 0;
}

async function runKeygen(parsed: Parsed, io: CliIo): Promise<number> {
  const out = parsed.values.get('--out')?.[0];
  if (out === undefined) {
    io.err('cyborg-plugin: keygen: нужен --out <префикс>');
    return 2;
  }
  const report = await keygen(out);
  for (const problem of report.problems) io.err(formatProblem(problem));
  if (!report.ok) return 1;
  io.out(`Ключ ${report.keyId ?? ''}`);
  io.out(`  закрытый: ${report.secretFile ?? ''} (хранить как секрет; в репозиторий и в сборку не класть)`);
  io.out(`  открытый: ${report.publicFile ?? ''}`);
  return 0;
}

/** Дата срока: `2027-01-31` или ISO 8601; без времени - конец суток по UTC. */
function parseExpires(text: string): Date {
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T23:59:59.999Z`) : new Date(text);
}

async function runSign(parsed: Parsed, io: CliIo): Promise<number> {
  const key = parsed.values.get('--key')?.[0];
  const days = parsed.values.get('--days')?.[0];
  const expires = parsed.values.get('--expires')?.[0];
  if (key === undefined) {
    io.err('cyborg-plugin: sign: нужен --key <файл закрытого ключа>');
    return 2;
  }
  if (days !== undefined && expires !== undefined) {
    io.err('cyborg-plugin: sign: --days и --expires вместе не задают');
    return 2;
  }
  if (days !== undefined && !/^[1-9]\d{0,4}$/.test(days)) {
    io.err('cyborg-plugin: sign: --days - целое число дней');
    return 2;
  }
  const report = await signPlugin(parsed.dir ?? 'dist', { keyFile: key, ...(days !== undefined && { days: Number(days) }), ...(expires !== undefined && { expires: parseExpires(expires) }) });
  for (const problem of report.problems) io.err(formatProblem(problem));
  if (!report.ok) {
    io.err(`Нарушений: ${String(report.problems.length)}; пакет не подписан`);
    return 1;
  }
  io.out(`Плагин ${report.id ?? ''} ${report.version ?? ''}: ${report.dir}`);
  io.out(`Подписано ключом ${report.keyId ?? ''}, файлов: ${String(report.files)}, действует до ${report.notAfter ?? ''}`);
  return 0;
}

async function runVerify(parsed: Parsed, io: CliIo): Promise<number> {
  if (parsed.dir === undefined) {
    io.err('cyborg-plugin: verify: нужен каталог или архив');
    return 2;
  }
  const report = await verifyPlugin(parsed.dir, { keys: parsed.values.get('--key') ?? [] });
  for (const problem of report.problems) io.err(formatProblem(problem));
  if (!report.ok) {
    io.err(`Пакет не принят${report.verdict?.ok === false ? ` (${report.verdict.code})` : ''}`);
    return 1;
  }
  const manifest = report.verdict?.ok === true ? report.verdict.manifest : undefined;
  io.out(`Подпись верна: ${report.id ?? ''} ${report.version ?? ''}, ключ ${manifest?.keyId ?? ''}, файлов: ${String(report.files)}, действует до ${manifest?.notAfter ?? ''}`);
  return 0;
}

/** Командная строка `cyborg-plugin`: `check`, `build`, `delivery`, `pack`, `keygen`, `sign`, `verify`. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  const known = command === 'check' || command === 'build' || command === 'delivery' || command === 'pack' || command === 'keygen' || command === 'sign' || command === 'verify' ? command : undefined;
  const parsed = known === undefined ? (command === undefined ? 'нет команды' : `неизвестная команда ${command}`) : parse(known, rest);
  if (typeof parsed === 'string' || known === undefined) {
    io.err(`cyborg-plugin: ${typeof parsed === 'string' ? parsed : 'неверный вызов'}`);
    for (const line of USAGE) io.err(line);
    return 2;
  }
  if (known === 'check') return runCheck(parsed, io);
  if (known === 'build') return runBuild(parsed, io);
  if (known === 'delivery') return runDelivery(parsed, io);
  if (known === 'keygen') return runKeygen(parsed, io);
  if (known === 'sign') return runSign(parsed, io);
  if (known === 'verify') return runVerify(parsed, io);
  return runPack(parsed, io);
}
