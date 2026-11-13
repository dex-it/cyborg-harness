import fs from 'node:fs';
import path from 'node:path';
import { forkHosts, type HostIsolation, type HostRequest, type SpawnHost } from '@cyborg-harness/core';
import { landlockConfiner } from './confiner-landlock.ts';
import { seatbeltConfiner } from './confiner-seatbelt.ts';
import { realPath, type ConfinerLauncher } from './confiner.ts';
import type { UtilityHosts } from './plugin-hosts.ts';

// TR-21, TR-22, TR-24 (ADR-CH-0019): способ запуска хоста по происхождению плагина. Встроенные плагины остаются в общем `utilityProcess`; сторонний - свой процесс Node
// (`--permission` с чтением только каталога плагина и кода хоста, пустой `env`, без `--allow-child-process`, `--allow-worker`, `--allow-addons`), под ограничителем ОС, если он есть.
// Каждый запуск заявляет уровень изоляции 0-3 и причину словами (FR-CH-3021): ядро доказывает заявленное canary и записывает уровень в журнал.

/** Отдельный Node: бинарник из поставки приложения (свой, подписанный; `RunAsNode` в сборке выключен, ADR-CH-0018) и вход хоста ядра. */
export interface NodeHostSettings {
  /** Путь к бинарнику Node (не Electron). */
  readonly binary: string;
  /** Файл `host-entry` ядра (точка входа пакета ядра `host-entry`, собранный JS); хосту разрешено читать его каталог. */
  readonly entry: string;
  /** Ещё каталоги кода хоста, которые ему читать (если ядро и его зависимости лежат раздельно). */
  readonly readDirs?: readonly string[];
}

export interface IsolationSettings {
  /**
   * Где работает сторонний плагин. `node` - процесс Node под запретами (нужен `node`); `utility` - прежний `utilityProcess`: возврат одной настройкой (запреты Node там не действуют,
   * уровень 1). По умолчанию `node`, если задан `node`, иначе `utility` с причиной в уровне.
   */
  readonly thirdPartyHost?: 'node' | 'utility';
  readonly node?: NodeHostSettings;
  /** Ограничитель ОС: `auto` - Seatbelt на macOS, запускатель Landlock и seccomp на Linux; `off` - не применять; или готовый (тесты, другая реализация). По умолчанию `auto`. */
  readonly confiner?: 'auto' | 'off' | ConfinerLauncher;
  /** Путь к запускателю Linux (`cyborg-confine`); в `auto` на Linux обязателен, иначе ограничителя нет. */
  readonly confinerBinary?: string;
}

/** Ограничитель по настройке: готовый как есть; `auto` - по платформе. */
export function pickConfiner(settings: IsolationSettings, platform: NodeJS.Platform = process.platform): ConfinerLauncher | { readonly none: string } {
  const choice = settings.confiner ?? 'auto';
  if (choice === 'off') return { none: 'ограничитель ОС отключён настройкой' };
  if (choice !== 'auto') return choice;
  if (platform === 'darwin') return seatbeltConfiner();
  if (platform === 'linux') return settings.confinerBinary === undefined ? { none: 'запускатель Linux (cyborg-confine) не задан приложением' } : landlockConfiner(settings.confinerBinary);
  return { none: `ограничителя ОС для ${platform} нет` };
}

const NODE_RESTRICTIONS = 'запреты Node (--permission): читать можно только каталог плагина и код хоста, нельзя запускать процессы, создавать потоки и грузить аддоны, окружение пусто';

/** Уровень встроенного плагина или стороннего в `utilityProcess`: окружение явное, запретов ОС и Node нет. */
export function utilityIsolation(request: HostRequest | undefined, why?: string): HostIsolation {
  if (request?.thirdParty !== true) {
    return {
      level: 1,
      network: 'open',
      reason: 'встроенный плагин в хосте utilityProcess с явным окружением: код поставки проверен нами, запретов ОС нет (файлы, процессы и сеть мимо ctx.os закрыты только доверием к поставке)',
    };
  }
  return {
    level: 1,
    network: 'open',
    reason: `сторонний плагин в хосте utilityProcess с явным окружением (${why ?? 'отдельный Node не настроен'}): запреты Node в нём не действуют, файлы, процессы и сеть мимо ctx.os НЕ закрыты - плагин может прочитать любой файл пользователя, запустить программу и открыть соединение`,
  };
}

/** Заявление хоста Node: уровень 3 при ограничителе, который закрывает и файлы, и сеть; иначе 2, и сеть названа словами. */
export function nodeIsolation(confiner: ConfinerLauncher | { readonly none: string }): HostIsolation {
  if ('none' in confiner) {
    return {
      level: 2,
      network: 'open',
      reason: `${NODE_RESTRICTIONS}. Сеть и сокеты НЕ закрыты: ограничителя ОС нет (${confiner.none}), плагин может открыть соединение мимо ctx.os.net`,
      canary: { nodePermission: true, networkClosed: false },
    };
  }
  const { status } = confiner;
  if (!status.ok) {
    return {
      level: 2,
      network: 'open',
      reason: `${NODE_RESTRICTIONS}. Сеть и сокеты НЕ закрыты: ограничитель ОС ${confiner.name} недоступен (${status.reason}), плагин может открыть соединение мимо ctx.os.net`,
      canary: { nodePermission: true, networkClosed: false },
    };
  }
  return {
    // Без ограничения файлов самой ОС (ядро Linux без Landlock) уровень 3 не ставится, хотя сеть закрыта: файлы держат только запреты Node.
    level: status.files ? 3 : 2,
    network: 'closed',
    reason: `${NODE_RESTRICTIONS}; ограничитель ОС ${confiner.name}: ${status.summary}`,
    canary: { nodePermission: true, networkClosed: true },
  };
}

/**
 * Файлы `package.json` над каталогом: Node ищет по ним тип модуля точки входа и, найдя нечитаемый, падает (`ERR_INVALID_PACKAGE_CONFIG`). Запреты Node свои чтения разрешают сами,
 * а ограничитель ОС о них не знает, поэтому ему они названы. Хост видит только эти файлы (имя пакета, версию, зависимости), содержимое остального над каталогом закрыто.
 */
export function packageFilesAbove(dir: string): string[] {
  const found: string[] = [];
  for (let current = dir; ; current = path.dirname(current)) {
    const file = path.join(current, 'package.json');
    if (fs.existsSync(file)) found.push(file);
    if (path.dirname(current) === current) return found;
  }
}

/** Путь для `--allow-fs-read`: Node читает `*` как маску, поэтому каталог со звёздочкой запуск не принимает. */
function fsReadFlag(dir: string): string {
  if (dir.includes('*')) throw new Error(`каталог ${dir} содержит «*»: Node прочёл бы его как маску, хост стороннего плагина не запущен`);
  return `--allow-fs-read=${dir}`;
}

/**
 * Способ запуска по происхождению: сторонний плагин - процесс Node под запретами (если настроен `node` и не выбран возврат на `utilityProcess`),
 * остальное - `utility`. `pidOf` отвечает за хосты обоих видов.
 */
export function pluginHosts(utility: (isolation: (request: HostRequest | undefined) => HostIsolation) => UtilityHosts, settings: IsolationSettings = {}): UtilityHosts {
  const mode = settings.thirdPartyHost ?? (settings.node === undefined ? 'utility' : 'node');
  const node = mode === 'node' ? settings.node : undefined;
  const why = mode === 'utility' ? (settings.thirdPartyHost === 'utility' ? 'режим стороннего хоста переключён на utilityProcess настройкой' : 'отдельный Node не настроен') : node === undefined ? 'режим «node» выбран, но бинарник Node не задан' : undefined;
  const confiner = node === undefined ? undefined : pickConfiner(settings);
  const inUtility = utility((request) => utilityIsolation(request, why));
  const pids = new Map<string, number>();
  const spawn: SpawnHost = (hostId, request) => {
    if (node === undefined || confiner === undefined || request?.thirdParty !== true) return inUtility.spawn(hostId, request);
    const entryDir = realPath(path.dirname(node.entry));
    const home = request.plugins.flatMap((plugin) => (plugin.home === undefined ? [] : [realPath(plugin.home)]))[0];
    const read = [entryDir, ...(node.readDirs ?? []).map(realPath), ...(home === undefined ? [] : [home])];
    const binary = realPath(node.binary);
    const handle = forkHosts({
      entry: node.entry,
      execPath: node.binary,
      execArgv: ['--permission', ...read.map(fsReadFlag)],
      env: {},
      serialization: 'json',
      cwd: home ?? entryDir,
      isolation: nodeIsolation(confiner),
      ...(!('none' in confiner) && confiner.status.ok && { wrap: (command) => confiner.wrap(command, { read: [...read, ...read.flatMap(packageFilesAbove)], exec: [binary] }) }),
    })(hostId, request);
    if (handle.pid !== undefined) {
      pids.set(hostId, handle.pid);
      handle.onExit(() => {
        if (pids.get(hostId) === handle.pid) pids.delete(hostId);
      });
    }
    return handle;
  };
  return { spawn, pidOf: (hostId) => pids.get(hostId) ?? inUtility.pidOf(hostId) };
}
