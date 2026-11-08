import { checkPlugin, formatProblem, type CheckOptions } from './plugin-check.ts';

/** Куда команда пишет: итог и права - в `out`, нарушения - в `err`. */
export interface CliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

const USAGE = [
  'Использование: cyborg-plugin check [каталог] [--declarations <файл>]... [--declarations-package <имя>]...',
  '  каталог                      каталог плагина с manifest.json; по умолчанию текущий',
  '  --declarations <файл>        файл пакета объявлений рядом с плагином: из него разрешён только import type, и в нём нет кода',
  '  --declarations-package <имя> пакет объявлений по имени (@acme/contracts): разрешён только import type',
  'Код возврата: 0 - нарушений нет, 1 - есть, 2 - неверный вызов.',
];

interface Parsed {
  readonly dir: string;
  readonly options: CheckOptions;
}

/** Разбор `check`: `--имя значение` и `--имя=значение`; текст ошибки, если вызов неверен. */
function parse(args: readonly string[]): Parsed | string {
  const dirs: string[] = [];
  const declarations: string[] = [];
  const packages: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (!arg.startsWith('--')) {
      dirs.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq < 0 ? arg : arg.slice(0, eq);
    if (name !== '--declarations' && name !== '--declarations-package') return `неизвестный флаг ${name}`;
    const value = eq < 0 ? args[++i] : arg.slice(eq + 1);
    if (value === undefined || value === '') return `${name}: нужно значение`;
    (name === '--declarations' ? declarations : packages).push(value);
  }
  if (dirs.length > 1) return 'каталог один';
  return { dir: dirs[0] ?? '.', options: { declarations, declarationPackages: packages } };
}

/** Командная строка `cyborg-plugin`: пока одна команда, `check`; остальные добавит сборка плагинов (P-06). */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  const parsed = command === 'check' ? parse(rest) : command === undefined ? 'нет команды' : `неизвестная команда ${command}`;
  if (typeof parsed === 'string') {
    io.err(`cyborg-plugin: ${parsed}`);
    for (const line of USAGE) io.err(line);
    return 2;
  }
  const report = await checkPlugin(parsed.dir, parsed.options);
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
