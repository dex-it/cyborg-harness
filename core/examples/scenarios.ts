import type { Kernel } from '../src/index.ts';

export type Documents = Record<string, Record<string, unknown>>;

export interface Scenario {
  readonly name: string;
  readonly title: string;
  /** Что сценарий показывает - печатается до первого шага. */
  readonly point: string;
  readonly enabled: readonly string[];
  readonly config?: Documents;
  readonly state?: Documents;
  readonly safeMode?: boolean;
  /** `plugins.hosts`: не названные плагины идут в хост builtin. */
  readonly hosts?: Readonly<Record<string, readonly string[]>>;
  /** Плагины из поставки; по умолчанию все примеры. */
  readonly bundled?: readonly string[];
  readonly act?: (kernel: Kernel, run: (command: string, ...args: unknown[]) => Promise<void>) => Promise<void>;
}

const base = ['files', 'projects', 'sessions', 'pin-lock', 'editor', 'viewer', 'tabs'];

const oldConfig: Documents = {
  user: {
    projects: { projects: [{ name: 'Cyborg', path: '/work/cyborg' }, { name: 'Заметки', path: '/work/notes' }], lastProjectId: 0 },
    'pin-lock': { idle: 5, code: '1234' },
  },
  workspace: {
    'pin-lock': { $version: 2, minutes: 1 },
  },
};

const sessionsState: Documents = { workspace: { sessions: { $version: 1, open: ['claude #1', 'shell #2'] } } };

export const scenarios: readonly Scenario[] = [
  {
    name: 'basic',
    title: 'Базовая сборка',
    point:
      'Граф упорядочивает плагины, config старого формата мигрирует по слоям, поставщик отдаёт две мажорные версии контракта, вкладки собираются из всех поставщиков',
    enabled: base,
    hosts: { storage: ['files', 'projects'], ui: ['editor', 'viewer', 'tabs'] },
    config: oldConfig,
    state: sessionsState,
    async act(_kernel, run) {
      await run('projects.current');
      await run('tabs.open', '/work/cyborg/README.md');
      await run('pin-lock.lock');
      await run('sessions.restore');
      await run('pin-lock.unlock', '0000');
      await run('pin-lock.unlock', '1234');
      await run('sessions.restore');
      await run('sessions.restore');
    },
  },
  {
    name: 'third-party',
    title: 'Сторонний плагин не делит хост',
    point: 'viewer поставлен пользователем, а не с Cyborg: группа ui его не берёт, ядро даёт ему свой хост и пишет об этом в журнал',
    enabled: base,
    bundled: base.filter((id) => id !== 'viewer'),
    hosts: { storage: ['files', 'projects'], ui: ['editor', 'viewer', 'tabs'] },
    config: oldConfig,
    state: sessionsState,
    async act(_kernel, run) {
      await run('tabs.open', '/work/cyborg/README.md');
    },
  },
  {
    name: 'broken',
    title: 'Плагин падает при активации',
    point: 'files бросает ошибку в activate: зависящие от него по requires пропускаются, остальные работают',
    enabled: base,
    config: { ...oldConfig, workspace: { ...oldConfig.workspace, files: { $version: 1, failOnStart: true } } },
    state: sessionsState,
    async act(_kernel, run) {
      await run('tabs.open', '/work/cyborg/README.md');
      await run('sessions.restore');
    },
  },
  {
    name: 'conflict',
    title: 'Два поставщика кратности one',
    point: 'lock-alt тоже отдаёт cyborg.lock: sessions не может выбрать и не активируется, оба поставщика живы',
    enabled: [...base, 'lock-alt'],
    config: oldConfig,
    state: sessionsState,
    async act(_kernel, run) {
      await run('sessions.restore');
    },
  },
  {
    name: 'rejected',
    title: 'Отказы до запуска кода',
    point: 'Битый манифест, чужая версия ядра, цикл и отсутствующий плагин отсеиваются по манифестам; их код не загружается',
    enabled: ['files', 'broken-manifest', 'future', 'cycle-a', 'cycle-b', 'ghost'],
  },
  {
    name: 'rollback',
    title: 'Откат версии плагина',
    point:
      'В config pin-lock лежит версия 3, а установлен pin-lock с версией 2: плагин не активируется и данные не трогает; sessions живёт без блокировки, она у него optional',
    enabled: base,
    config: { ...oldConfig, user: { ...oldConfig.user, 'pin-lock': { $version: 3, minutes: 5, biometrics: true } } },
    state: sessionsState,
    async act(_kernel, run) {
      await run('sessions.restore');
    },
  },
  {
    name: 'safe',
    title: 'Безопасный режим',
    point: 'Манифесты разобраны и граф решён, но код плагинов не запускается',
    enabled: base,
    config: oldConfig,
    safeMode: true,
  },
  {
    name: 'boundary',
    title: 'Граница хоста',
    point:
      'clock и clock-user в разных процессах: синхронный метод через границу становится асинхронным, колбэк в аргументе проходит подпиской через ядро, а функция в ответе команды не проходит structuredClone',
    enabled: ['clock', 'clock-user'],
    hosts: { clock: ['clock'], user: ['clock-user'] },
    async act(_kernel, run) {
      await run('clock-user.probe');
      await run('clock.now');
    },
  },
  {
    name: 'hang',
    title: 'Зависание и сторож',
    point:
      'flaky уходит в бесконечный цикл: сторож не дожидается ответа на пинг, убивает его хост и поднимает заново; monitor в другом процессе видит пропажу и возврат, после второго зависания flaky выключен',
    enabled: ['flaky', 'monitor'],
    hosts: { flaky: ['flaky'], ui: ['monitor'] },
    async act(kernel, run) {
      await run('flaky.ping');
      await run('flaky.hang');
      await kernel.idle();
      await run('flaky.ping');
      await run('monitor.status');
      await run('flaky.hang');
      await kernel.idle();
      await run('monitor.status');
    },
  },
  {
    name: 'crash',
    title: 'Падение процесса хоста',
    point: 'flaky вызывает process.exit: падение идёт тем же путём, что зависание, без ожидания сторожа',
    enabled: ['flaky', 'monitor'],
    hosts: { flaky: ['flaky'], ui: ['monitor'] },
    async act(kernel, run) {
      await run('flaky.crash');
      await kernel.idle();
      await run('flaky.ping');
    },
  },
];
