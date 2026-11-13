import type { SectionResult } from './config.ts';
import type { Rejection } from './graph.ts';
import { DENIED_WINDOW_MS, DEPRECATED_WINDOW_MS, PTY_HOST_ID } from './journal.ts';
import { LEVEL_TITLES, type IsolationLevel } from './isolation.ts';
import type { JournalEntry } from './kernel-types.ts';

/** Что показать на месте плагина: работает, ждёт перезапуска хоста, выключен (сбоем или человеком) или не включён в настройках. */
export type PluginState = 'active' | 'waiting' | 'restarting' | 'stopped' | 'disabled';

/** Уровень изоляции процесса плагина для окна «Плагины Cyborg» (TR-24): число 0-3, причина словами, закрыта ли сеть. */
export interface PluginIsolation {
  readonly level: IsolationLevel;
  readonly reason: string;
  /** `open` - соединение мимо `ctx.os.net` плагин открыть может. */
  readonly network: 'open' | 'closed';
}

export interface PluginStatus {
  readonly id: string;
  readonly state: PluginState;
  /** Как изолирован процесс плагина; нет, если запуск об изоляции ничего не заявил или плагин не прошёл проверку запретов (`sandbox-ineffective`). */
  readonly isolation?: PluginIsolation;
  /** Запись журнала, которая привела к состоянию. */
  readonly cause?: JournalEntry;
  /** «Включить снова» имеет смысл: причина в работе плагина, а не в манифесте или настройках. */
  readonly revivable: boolean;
}

/**
 * Какие виды записей журнала - события жизненного цикла плагина (загружен, пропущен, снят, упал), а какие о его работе ничего не говорят: конфликт сочетаний, отказ шлюза,
 * вызов устаревшего члена, удержанное хостом отклонение, завершённый по сроку pty, выбор хоста и группы. Вторые приходят в любой момент, в том числе после снятия плагина, и не должны
 * перекрывать запись жизненного цикла: по последней из них `pluginStatuses` показывает состояние, а `enable` поставщика решает, поднимать ли зависимого.
 * Таблица полная по типу: новый вид записи без пометки компилятор не пропустит.
 */
const LIFECYCLE: Record<JournalEntry['kind'], boolean> = {
  invalid: true,
  disabled: true,
  'not-found': true,
  rejected: true,
  'safe-mode': true,
  skipped: true,
  config: true,
  state: true,
  failed: true,
  activated: true,
  deactivated: true,
  revived: true,
  waiting: true,
  unloaded: true,
  uninstalled: true,
  'switched-off': true,
  'host-down': true,
  'host-restart': true,
  'host-abandoned': true,
  'key-conflict': false,
  'key-ignored': false,
  'trace-args': false,
  'menu-source': false,
  denied: false,
  'deprecated-call': false,
  'unhandled-rejection': false,
  'pty-expired': false,
  'host-isolated': false,
  'group-isolated': false,
  'host-own-grouped': false,
  'third-party': false,
  isolation: false,
  'sandbox-ineffective': true,
  'integrity-failed': true,
  'delivery-failed': false,
  'log-summary': false,
};

/** Запись о жизненном цикле плагина (таблица `LIFECYCLE`). */
export const isLifecycleEntry = (entry: JournalEntry): boolean => LIFECYCLE[entry.kind];

const REVIVABLE = new Set<JournalEntry['kind']>(['switched-off', 'failed', 'skipped', 'host-abandoned', 'integrity-failed', 'sandbox-ineffective']);

/** Плагины, которых касается запись: свой id или перечень у записей хоста; у вызова устаревшего члена ещё и поставщик, чтобы он видел своих вызывающих. */
export function entryPlugins(entry: JournalEntry): readonly string[] {
  if (entry.kind === 'deprecated-call') return [entry.pluginId, entry.provider];
  if (entry.pluginId !== undefined) return [entry.pluginId];
  if (entry.kind === 'key-ignored' || entry.kind === 'trace-args' || entry.kind === 'delivery-failed') return [];
  return entry.kind === 'host-down' ? [...new Set([...entry.plugins, ...entry.culprits])] : entry.plugins;
}

/** Состояние каждого плагина по журналу, в порядке первого упоминания. */
export function pluginStatuses(journal: readonly JournalEntry[]): PluginStatus[] {
  const states = new Map<string, PluginStatus>();
  const isolations = new Map<string, PluginIsolation>();
  const revivable = (id: string, cause: JournalEntry) => REVIVABLE.has(cause.kind) || (cause.kind === 'unloaded' && cause.by === id);
  const set = (id: string, state: PluginState, cause: JournalEntry) => states.set(id, { id, state, cause, revivable: state === 'stopped' && revivable(id, cause) });
  for (const entry of journal) {
    if (entry.kind === 'isolation') isolations.set(entry.pluginId, { level: entry.level, reason: entry.reason, network: entry.network });
    // Заявленная изоляция не подтвердилась: прежняя запись о ней больше не верна.
    if (entry.kind === 'sandbox-ineffective') isolations.delete(entry.pluginId);
    if (!isLifecycleEntry(entry)) continue;
    for (const id of entryPlugins(entry)) {
      switch (entry.kind) {
        case 'activated':
          set(id, 'active', entry);
          break;
        case 'waiting':
          set(id, 'waiting', entry);
          break;
        case 'disabled':
          set(id, 'disabled', entry);
          break;
        case 'host-down':
        case 'revived':
          set(id, 'restarting', entry);
          break;
        case 'host-restart':
          // Причиной остаётся падение: «перезапуск» без «почему» человеку ничего не говорит.
          if (states.get(id)?.state !== 'restarting') set(id, 'restarting', entry);
          break;
        default:
          set(id, 'stopped', entry);
      }
    }
  }
  return [...states.values()].map((status) => {
    const isolation = isolations.get(status.id);
    return isolation === undefined ? status : { ...status, isolation };
  });
}

/** Уровень изоляции словами для окна и журнала: «уровень 2 из 3 (запреты Node, сеть открыта): причина». */
export const describeIsolation = (isolation: PluginIsolation): string => `уровень изоляции ${String(isolation.level)} из 3 (${LEVEL_TITLES[isolation.level]}): ${isolation.reason}`;

function rejection(r: Rejection): string {
  switch (r.kind) {
    case 'duplicate':
      return 'второй плагин с тем же id';
    case 'engines':
      return `нужен API Cyborg ${r.range}, есть ${r.api}`;
    case 'missing':
      return `нет поставщика ${r.contract} ${r.range}`;
    case 'ambiguous':
      return `несколько поставщиков ${r.contract}: ${r.providers.join(', ')}`;
    case 'cycle':
      return `цикл зависимостей: ${r.members.join(' → ')}`;
    case 'command':
      return `команду ${r.command} объявил и ${list(r.with)}: владельца нет, пока команда в двух манифестах`;
    case 'reserved':
      return r.what === 'id'
        ? `id ${r.name} из пространства ${r.prefix}* - только у встроенных плагинов`
        : `отдаёт ${r.name}, а контракты пространства ${r.prefix}* отдают только встроенные плагины`;
  }
}

function section(kind: 'config' | 'state', r: SectionResult): string {
  const name = kind === 'config' ? 'настроек' : 'состояния';
  switch (r.status) {
    case 'newer':
      return `раздел ${name} в слое ${r.layer} версии ${r.found}, плагин знает только до ${r.expected}: похоже, плагин откатили; данные не тронуты`;
    case 'migrate-error':
      return `перенос раздела ${name} слоя ${r.layer} с версии ${r.from} не удался: ${r.error}`;
    case 'invalid':
      return `раздел ${name} не прошёл проверку: ${r.errors.join('; ')}`;
    case 'ok':
      return `раздел ${name} прочитан`;
  }
}

const list = (ids: readonly string[]) => ids.join(', ');

/** Запись журнала словами для человека. */
export function describeEntry(e: JournalEntry): string {
  switch (e.kind) {
    case 'invalid':
      return `манифест с ошибками: ${e.errors.join('; ')}`;
    case 'disabled':
      return 'не включён в настройках (plugins.enabled)';
    case 'not-found':
      return 'включён в настройках, но не найден в каталогах плагинов';
    case 'rejected':
      return e.reasons.map(rejection).join('; ');
    case 'safe-mode':
      return 'безопасный режим: код плагинов не запускается';
    case 'skipped':
      return `не запущен: ${e.reason}`;
    case 'config':
    case 'state':
      return section(e.kind, e.result);
    case 'failed':
      return `не поднялся в хосте ${e.hostId}: ${e.error}`;
    case 'activated':
      return `работает в хосте ${e.hostId}, запуск ${Math.round(e.ms)} мс`;
    case 'deactivated':
      return e.error ? `снят с ошибкой: ${e.error}` : 'снят';
    case 'waiting':
      return 'ждёт первой команды, показа вида или потребителя';
    case 'revived':
      return 'включён снова';
    case 'denied': {
      const source = e.reason === 'window' ? 'отказ окна' : e.reason === 'command-callers' ? 'отказ команды' : e.reason === 'csp' ? 'отказ CSP' : 'отказ ctx.os';
      const what = `${source}: ${e.detail}`;
      return e.repeats ? `${what} - ещё ${String(e.repeats)} раз за ${String(DENIED_WINDOW_MS / 1000)} с` : what;
    }
    case 'deprecated-call': {
      const what = `${e.pluginId} вызывает устаревший ${e.contract}.${e.member} поставщика ${e.provider}`;
      return e.repeats ? `${what} - ещё ${String(e.repeats)} раз за ${String(DEPRECATED_WINDOW_MS / 1000)} с` : what;
    }
    case 'pty-expired':
      return `терминал ${e.id} (${e.program}) завершён: плагин не подхватил его за ${String(e.graceMs / 1000)} с`;
    case 'unloaded': {
      const base = e.by === e.pluginId ? 'выгружен' : `выгружен вместе с ${e.by}: требует его контракт`;
      const what = e.keptPty ? `${base}; процессов в терминале оставлено: ${String(e.keptPty)}` : base;
      return e.error ? `${what}; deactivate с ошибкой: ${e.error}` : what;
    }
    case 'uninstalled':
      return `удалён; стёрто: ${list(e.erased) || 'ничего'}; осталось: ${list(e.left)}` + (e.error ? `; не удалось: ${e.error}` : '');
    case 'key-conflict':
      return `сочетание ${e.key} (${e.command}) уже у ${e.winner}: нажатие получает ${e.winner}`;
    case 'key-ignored':
      return `plugins.keybindings: ${e.key} -> ${String(e.command)} не применено: ${e.reason}`;
    case 'trace-args':
      return `запуск с --trace-args: записи трассы несут аргументы операций (до ${String(e.limit)} Б на запись, значения секретов вычеркнуты); в файле диагностики и в выгрузке будут пути и данные человека`;
    case 'menu-source':
      return `пункт меню ${e.item}: ${e.field} не прочитан, пункт недоступен: ${e.error}`;
    case 'host-isolated':
      return `сторонний плагин не делит хост: группа ${e.group} из plugins.hosts не действует, работает в своём хосте ${e.hostId}`;
    case 'group-isolated':
      return `сторонний плагин не делит группу рендера: группа ${e.group} не действует, работает в своей ${e.renderGroup}`;
    case 'third-party':
      return 'сторонний плагин: код не из поставки, не проверен; на этапе 1 хост - обычный процесс Node, и плагин может обойти шлюз ctx.os';
    case 'isolation':
      return describeIsolation(e);
    case 'sandbox-ineffective':
      return `плагин не запущен: хост не доказал заявленную изоляцию (уровень ${String(e.level)}) - ${e.reasons.join('; ')}`;
    case 'integrity-failed':
      return e.mode === 'enforce' ? `плагин не запущен: происхождение пакета не подтверждено - ${e.reason}` : `происхождение пакета не подтверждено, плагин запущен (режим «предупреждать») - ${e.reason}`;
    case 'delivery-failed':
      return `поставка приложения не прошла проверку (${e.mode === 'enforce' ? 'режим «отказывать»: плагины с несошедшимися файлами не запущены' : 'режим «предупреждать»: плагины запущены'}): ${e.reasons.join('; ')}`;
    case 'unhandled-rejection':
      return `необработанное отклонение промиса: ${e.error}`;
    case 'host-own-grouped':
      return `манифест просит свой хост, но группа ${e.group} из plugins.hosts сажает его к ${list(e.neighbours)}: его зависание перезапустит и их`;
    case 'log-summary':
      return `строк сверх предела за интервал: ${String(e.skipped)}, из них error: ${String(e.errors)}` + (e.lastError === undefined ? '' : `; последняя error: ${e.lastError}`);
    case 'switched-off':
      if (e.reason === 'log-flood') return 'выключен: поток строк ctx.log и вывода хоста выше предела не стихает' + (e.affects.length ? `; его контракты брали: ${list(e.affects)}` : '');
      return `выключен, сбоев подряд: ${e.strikes}` + (e.affects.length ? `; его контракты брали: ${list(e.affects)}` : '');
    case 'host-down': {
      const what = e.reason === 'hang' ? 'завис' : 'упал';
      if (e.hostId === PTY_HOST_ID) return `pty-хост ${what}: процессы pty потеряны${e.lostPtys?.length ? `, их владельцы получили выход: ${list(e.lostPtys)}` : ''}`;
      const blame = e.culprits.length ? `виновник: ${list(e.culprits)}` : 'виновник не установлен';
      return `хост ${e.hostId} ${what}, ${blame}; сняты: ${list(e.plugins) || 'никто'}` + (e.affects.length ? `; задеты: ${list(e.affects)}` : '');
    }
    case 'host-restart':
      return e.hostId === PTY_HOST_ID ? 'pty-хост перезапущен: новые pty запускаются' : `хост ${e.hostId} перезапускается: ${list(e.plugins)}`;
    case 'host-abandoned':
      if (e.hostId === PTY_HOST_ID) return `pty-хост больше не перезапускается сам, падений подряд: ${e.failures}; следующий запуск pty попробует снова`;
      return `хост ${e.hostId} больше не перезапускается, сбоев без виновника подряд: ${e.failures}; выключены: ${list(e.plugins) || 'никто'}`;
  }
}

/** Ошибка или предупреждение - то, что человеку стоит заметить в журнале. */
export function entryLevel(e: JournalEntry): 'info' | 'warn' | 'error' {
  switch (e.kind) {
    // Уровень изоляции (`isolation`) - сведение, а не сбой: что он низкий у стороннего плагина, говорит его текст и запись third-party.
    case 'activated':
    case 'waiting':
    case 'disabled':
    case 'revived':
    case 'host-restart':
    case 'isolation':
      return 'info';
    case 'unloaded':
      return e.error ? 'warn' : 'info';
    case 'uninstalled':
      return e.error ? 'error' : 'info';
    case 'key-conflict':
    case 'key-ignored':
    case 'trace-args':
    case 'menu-source':
    case 'denied':
    case 'deprecated-call':
    case 'pty-expired':
    case 'log-summary':
      return 'warn';
    case 'deactivated':
      return e.error ? 'warn' : 'info';
    case 'integrity-failed':
    case 'delivery-failed':
      return e.mode === 'enforce' ? 'error' : 'warn';

    case 'config':
    case 'state':
      return e.result.status === 'ok' ? 'info' : 'error';
    case 'safe-mode':
    case 'skipped':
    case 'unhandled-rejection':
    case 'host-down':
    case 'host-isolated':
    case 'group-isolated':
    case 'host-own-grouped':
    case 'third-party':
      return 'warn';
    default:
      return 'error';
  }
}
