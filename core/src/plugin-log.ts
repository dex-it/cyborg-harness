import { LOG_LEVELS, clipLine, redactSecrets } from './log-text.ts';
import type { BridgeEnd, KernelContext, PluginLog } from './kernel-context.ts';
import type { LogLevel } from '@cyborg-harness/contracts';

/** Счёт строк одного источника (плагина либо хоста, чей плагин определить нельзя) в текущем интервале. */
interface Window {
  /** Хост источника без плагина (метка `хост <id>`): секреты строки - плагины этого хоста; у источника-плагина не задан. */
  readonly hostId: string | undefined;
  /** Начало интервала, мс; undefined - интервал не идёт. */
  start: number | undefined;
  lines: number;
  skipped: number;
  errors: number;
  /** Последняя пропущенная `error` как пришла: рендерится один раз, при закрытии интервала. */
  lastError: string | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** С какого момента интервалы сверх предела идут без пауз; undefined - поток спал. */
  floodSince: number | undefined;
  /** Конец последнего интервала сверх предела. */
  floodEnd: number | undefined;
}

/**
 * Строки плагинов и вывод хостов (FR-CH-4009, 4010, 4018): уровень, вычёркивание секретов, предел длины, предел частоты со сводной записью
 * и выключение плагина, чей поток не стихает. Дальше строка идёт в `LoadOptions.onLog`; хранит её приложение или K-30.
 */
export function createPluginLog(ctx: KernelContext): PluginLog {
  const { options, limits, gateway } = ctx;
  const windows = new Map<string, Window>();

  const isPlugin = (origin: string) => ctx.byId.has(origin);

  /** `judge` - решать ли о потоке: при снятии плагина и выгрузке ядра интервал только дописывается. */
  function close(origin: string, w: Window, judge = true): void {
    if (w.timer !== undefined) clearTimeout(w.timer);
    w.timer = undefined;
    const { start, skipped, errors, lastError } = w;
    w.start = undefined;
    w.lines = 0;
    w.skipped = 0;
    w.errors = 0;
    w.lastError = undefined;
    if (start === undefined || skipped === 0) {
      w.floodSince = undefined;
      return;
    }
    const last = lastError === undefined ? undefined : render(origin, lastError, w.hostId);
    if (isPlugin(origin)) ctx.record({ pluginId: origin, kind: 'log-summary', skipped, errors, ...(last !== undefined && { lastError: last }) });
    else options.onLog?.(origin, `строк сверх предела за интервал: ${String(skipped)}, из них error: ${String(errors)}` + (last === undefined ? '' : `; последняя error: ${last}`), 'warn');
    // Интервал сверх предела продолжает поток, если начался не позже чем через время одной строки на пределе (окно / предел) после конца прошлого: дальше между
    // интервалами проходит пауза, в которой частота была ниже предела (всплески по `предел + 1` строк раз в полтора окна дают в среднем меньше предела). Меньше - дрожание таймера.
    if (w.floodSince === undefined || w.floodEnd === undefined || start - w.floodEnd > limits.logWindowMs / Math.max(1, limits.logRate)) w.floodSince = start;
    w.floodEnd = start + limits.logWindowMs;
    if (judge && isPlugin(origin) && w.floodEnd - w.floodSince >= limits.logFloodMs) ctx.parts.lifecycle.switchOffFlood(origin);
  }

  function windowOf(origin: string, hostId: string | undefined): Window {
    let w = windows.get(origin);
    if (!w) {
      w = { hostId, start: undefined, lines: 0, skipped: 0, errors: 0, lastError: undefined, timer: undefined, floodSince: undefined, floodEnd: undefined };
      windows.set(origin, w);
    }
    return w;
  }

  /** Строка, какой она уходит дальше: без значений секретов, не длиннее предела. */
  function render(origin: string, raw: string, hostId: string | undefined): string {
    // Секреты плагина - его собственные; в строке хоста - секреты плагинов этого хоста: чужой плагин чужую диагностику не портит.
    const secrets = gateway.secretValues(hostId === undefined ? [origin] : [...ctx.byId.keys()].filter((id) => ctx.hostOf(id) === hostId));
    // Вычёркивание идёт до обрезки, иначе значение, разрезанное границей, осталось бы началом в строке; хвост дальше предела отбрасывается заранее.
    const reach = limits.logLineBytes + secrets.reduce((n, s) => Math.max(n, s.length), 0);
    const long = raw.length > reach;
    const redacted = redactSecrets(long ? raw.slice(0, reach) : raw, secrets);
    return clipLine(redacted, limits.logLineBytes, long ? Buffer.byteLength(raw) : Buffer.byteLength(redacted));
  }

  /** Строка источника: в пределах интервала уходит в `onLog`, сверх предела только считается (помнится лишь последняя `error`, её несёт сводная запись). */
  function line(origin: string, raw: string, level: LogLevel, hostId?: string): void {
    const { switchedOff } = ctx.parts.lifecycle;
    if (switchedOff.has(origin)) return;
    const now = Date.now();
    const w = windowOf(origin, hostId);
    if (w.start !== undefined && now - w.start >= limits.logWindowMs) close(origin, w);
    // Закрытый интервал мог оказаться последним терпимым: плагин выключен, эта строка уже не принимается.
    if (switchedOff.has(origin)) return;
    w.start ??= now;
    if (w.lines < limits.logRate) {
      w.lines++;
      options.onLog?.(origin, render(origin, raw, w.hostId), level);
      return;
    }
    w.skipped++;
    if (level === 'error') {
      w.errors++;
      w.lastError = raw;
    }
    w.timer ??= setTimeout(() => close(origin, w), Math.max(0, w.start + limits.logWindowMs - now));
    w.timer.unref();
  }

  return {
    attach({ host, mine, onNote }: BridgeEnd): void {
      onNote('log', { pluginId: 'string', message: 'string', level: LOG_LEVELS }, (p) => {
        line(mine(p.pluginId).id, p.message, p.level);
      });
      // Пустой `pluginId` - хост плагин не определил: строка хоста, как прочие его сообщения в `onLog`.
      onNote('output', { pluginId: 'string', level: LOG_LEVELS, text: 'string' }, (p) => {
        if (p.pluginId === '') line(`хост ${host.id}`, p.text, p.level, host.id);
        else line(mine(p.pluginId).id, p.text, p.level);
      });
    },
    hostLine(hostId, text, level) {
      line(`хост ${hostId}`, text, level, hostId);
    },
    drop(pluginId) {
      const w = windows.get(pluginId);
      if (w) close(pluginId, w, false);
      windows.delete(pluginId);
    },
    flush() {
      for (const [origin, w] of windows) close(origin, w, false);
      windows.clear();
    },
  };
}
