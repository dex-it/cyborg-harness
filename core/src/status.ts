import type { SectionResult } from './config.ts';
import type { Rejection } from './graph.ts';
import { DENIED_WINDOW_MS } from './journal.ts';
import type { JournalEntry } from './loader.ts';

/** Что показать на месте плагина: работает, ждёт перезапуска хоста, выключен (сбоем или человеком) или не включён в настройках. */
export type PluginState = 'active' | 'waiting' | 'restarting' | 'stopped' | 'disabled';

export interface PluginStatus {
  readonly id: string;
  readonly state: PluginState;
  /** Запись журнала, которая привела к состоянию. */
  readonly cause?: JournalEntry;
  /** «Включить снова» имеет смысл: причина в работе плагина, а не в манифесте или настройках. */
  readonly revivable: boolean;
}

const REVIVABLE = new Set<JournalEntry['kind']>(['switched-off', 'failed', 'skipped', 'host-abandoned']);

/** Плагины, которых касается запись: свой id или перечень у записей хоста. */
export function entryPlugins(entry: JournalEntry): readonly string[] {
  if (entry.pluginId !== undefined) return [entry.pluginId];
  if (entry.kind === 'key-ignored') return [];
  return entry.kind === 'host-down' ? [...new Set([...entry.plugins, ...entry.culprits])] : entry.plugins;
}

/** Состояние каждого плагина по журналу, в порядке первого упоминания. */
export function pluginStatuses(journal: readonly JournalEntry[]): PluginStatus[] {
  const states = new Map<string, PluginStatus>();
  const revivable = (id: string, cause: JournalEntry) => REVIVABLE.has(cause.kind) || (cause.kind === 'unloaded' && cause.by === id);
  const set = (id: string, state: PluginState, cause: JournalEntry) => states.set(id, { id, state, cause, revivable: state === 'stopped' && revivable(id, cause) });
  for (const entry of journal) {
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
        case 'key-conflict':
        case 'key-ignored':
        case 'denied':
          // Ни конфликт сочетаний, ни отказ шлюза о работе плагина ничего не говорят: плагин работает как обычно.
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
  return [...states.values()];
}

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
      const what = `${e.reason === 'window' ? 'отказ окна' : 'отказ ctx.os'}: ${e.detail}`;
      return e.repeats ? `${what} - ещё ${String(e.repeats)} раз за ${String(DENIED_WINDOW_MS / 1000)} с` : what;
    }
    case 'unloaded': {
      const base = e.by === e.pluginId ? 'выгружен' : `выгружен вместе с ${e.by}: требует его контракт`;
      const what = e.keptPty ? `${base}; процессов в терминале оставлено: ${String(e.keptPty)}` : base;
      return e.error ? `${what}; deactivate с ошибкой: ${e.error}` : what;
    }
    case 'key-conflict':
      return `сочетание ${e.key} (${e.command}) уже у ${e.winner}: нажатие получает ${e.winner}`;
    case 'key-ignored':
      return `plugins.keybindings: ${e.key} -> ${String(e.command)} не применено: ${e.reason}`;
    case 'host-isolated':
      return `сторонний плагин не делит хост: группа ${e.group} из plugins.hosts не действует, работает в своём хосте ${e.hostId}`;
    case 'switched-off':
      return `выключен, сбоев подряд: ${e.strikes}` + (e.affects.length ? `; его контракты брали: ${list(e.affects)}` : '');
    case 'host-down': {
      const what = e.reason === 'hang' ? 'завис' : 'упал';
      const blame = e.culprits.length ? `виновник: ${list(e.culprits)}` : 'виновник не установлен';
      return `хост ${e.hostId} ${what}, ${blame}; сняты: ${list(e.plugins) || 'никто'}` + (e.affects.length ? `; задеты: ${list(e.affects)}` : '');
    }
    case 'host-restart':
      return `хост ${e.hostId} перезапускается: ${list(e.plugins)}`;
    case 'host-abandoned':
      return `хост ${e.hostId} больше не перезапускается, сбоев без виновника подряд: ${e.failures}; выключены: ${list(e.plugins) || 'никто'}`;
  }
}

/** Ошибка или предупреждение - то, что человеку стоит заметить в журнале. */
export function entryLevel(e: JournalEntry): 'info' | 'warn' | 'error' {
  switch (e.kind) {
    case 'activated':
    case 'waiting':
    case 'disabled':
    case 'revived':
    case 'host-restart':
      return 'info';
    case 'unloaded':
      return e.error ? 'warn' : 'info';
    case 'key-conflict':
    case 'key-ignored':
    case 'denied':
      return 'warn';
    case 'deactivated':
      return e.error ? 'warn' : 'info';
    case 'config':
    case 'state':
      return e.result.status === 'ok' ? 'info' : 'error';
    case 'safe-mode':
    case 'skipped':
    case 'host-down':
    case 'host-isolated':
      return 'warn';
    default:
      return 'error';
  }
}
