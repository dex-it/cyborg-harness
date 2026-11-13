// TR-21, TR-24 (ADR-CH-0019): уровни изоляции процесса хоста и проверка, что запреты действуют. Запуск хоста (адаптер) заявляет уровень и причину словами,
// хост при старте доказывает заявленное (canary), ядро не активирует плагин, если запрет не действует.

/**
 * Лестница изоляции процесса плагина (исследование доверия, 5.3).
 * 0 - хост без явного окружения и без запретов (окружение ядра унаследовано); 1 - хост с явным окружением и минимумом данных, но без запретов ОС (`utilityProcess`);
 * 2 - процесс Node под `--permission`: файлы, процессы, потоки и аддоны закрыты запретами Node, сеть открыта; 3 - то же плюс ограничитель ОС (Seatbelt, Landlock и seccomp): сеть закрыта.
 */
export type IsolationLevel = 0 | 1 | 2 | 3;

export const ISOLATION_LEVELS: readonly IsolationLevel[] = [0, 1, 2, 3];

/** Заявление запуска хоста об изоляции: адаптер знает, как он хост запустил. */
export interface HostIsolation {
  readonly level: IsolationLevel;
  /** Почему уровень именно такой, словами для человека; при сети без ограничителя называет её открытой (FR-CH-3021). */
  readonly reason: string;
  /** Закрыта ли сеть ограничителем ОС. Для уровня 3 - `closed`, для остальных - `open`. */
  readonly network: 'open' | 'closed';
  /** Что хост обязан доказать при старте. Без поля проверять нечего (`utilityProcess`: запретов Node там нет). */
  readonly canary?: CanaryExpectation;
}

export interface CanaryExpectation {
  /** Запреты Node действуют: `process.permission` определён, чтение вне разрешённых каталогов, процесс, поток и аддон отказаны. */
  readonly nodePermission: true;
  /** Ограничитель ОС заявлен: сокет открыть нельзя. */
  readonly networkClosed: boolean;
}

/** Что хост увидел сам, пробуя запрещённое. `denied` - действие отказано, `allowed` - выполнилось, прочее - код другой ошибки. */
export interface CanaryReport {
  readonly permission: boolean;
  readonly fsRead: string;
  readonly process: string;
  readonly worker: string;
  readonly addon: string;
  /** TCP и UDP: `closed` - оба отказаны; `open` - хотя бы один открылся. */
  readonly network: 'closed' | 'open';
  readonly detail?: string;
}

/** Код отказа Node под `--permission`. */
export const PERMISSION_DENIED = 'ERR_ACCESS_DENIED';
/** Загрузка аддона при выключенных аддонах (`process.dlopen` без `--allow-addons`) отказывает этим кодом, а не `ERR_ACCESS_DENIED`. */
export const ADDON_DISABLED = 'ERR_DLOPEN_DISABLED';

/** Чего не хватает до заявленного: пустой список - заявление подтверждено. */
export function canaryProblems(expect: CanaryExpectation, report: CanaryReport): string[] {
  const problems: string[] = [];
  if (!report.permission) problems.push('process.permission не определён: запреты Node не действуют');
  for (const [what, result, codes] of [
    ['чтение вне разрешённых каталогов', report.fsRead, [PERMISSION_DENIED]],
    ['запуск процесса', report.process, [PERMISSION_DENIED]],
    ['создание потока (worker)', report.worker, [PERMISSION_DENIED]],
    ['загрузка аддона', report.addon, [PERMISSION_DENIED, ADDON_DISABLED]],
  ] as const) {
    if (!(codes as readonly string[]).includes(result)) problems.push(`${what}: ожидался отказ ${codes.join(' или ')}, получено ${result}`);
  }
  if (expect.networkClosed && report.network !== 'closed') problems.push('ограничитель ОС заявлен, но сокет открылся: сеть не закрыта');
  return problems;
}

/** Слова для окна по уровню, если запуск не дал своих. */
export const LEVEL_TITLES: Readonly<Record<IsolationLevel, string>> = {
  0: 'без изоляции',
  1: 'явное окружение, запретов ОС нет',
  2: 'запреты Node, сеть открыта',
  3: 'запреты Node и ограничитель ОС',
};
