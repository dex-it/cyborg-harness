import { LOG_LEVELS, clipLine, redactSecrets } from './log-text.ts';
import type { BridgeEnd, KernelContext, PluginLog } from './kernel-context.ts';
import type { LogLevel } from '@cyborg-harness/contracts';

/** Счёт строк одного источника (плагина либо хоста, чей плагин определить нельзя) в текущем интервале. */
interface Window {
  /** Начало интервала, мс; undefined - интервал не идёт. */
  start: number | undefined;
  lines: number;
  skipped: number;
  errors: number;
  lastError: string | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** С какого момента строк подряд больше предела в каждом интервале; undefined - поток спал. */
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
    if (isPlugin(origin)) ctx.record({ pluginId: origin, kind: 'log-summary', skipped, errors, ...(lastError !== undefined && { lastError }) });
    else options.onLog?.(origin, `строк сверх предела за интервал: ${String(skipped)}, из них error: ${String(errors)}` + (lastError === undefined ? '' : `; последняя error: ${lastError}`), 'warn');
    // Интервал сверх предела, начатый не позже окна после конца прошлого, продолжает поток; тишина дольше окна его обрывает.
    if (w.floodSince === undefined || w.floodEnd === undefined || start - w.floodEnd > limits.logWindowMs) w.floodSince = start;
    w.floodEnd = start + limits.logWindowMs;
    if (judge && isPlugin(origin) && w.floodEnd - w.floodSince >= limits.logFloodMs) ctx.parts.lifecycle.switchOffFlood(origin);
  }

  function window(origin: string): Window {
    let w = windows.get(origin);
    if (!w) {
      w = { start: undefined, lines: 0, skipped: 0, errors: 0, lastError: undefined, timer: undefined, floodSince: undefined, floodEnd: undefined };
      windows.set(origin, w);
    }
    return w;
  }

  /** Строка источника: в пределах интервала уходит в `onLog`, сверх предела только считается. */
  function line(origin: string, raw: string, level: LogLevel): void {
    if (ctx.parts.lifecycle.switchedOff.has(origin)) return;
    const now = Date.now();
    const w = window(origin);
    if (w.start !== undefined && now - w.start >= limits.logWindowMs) close(origin, w);
    w.start ??= now;
    const secrets = gateway.secretValues(isPlugin(origin) ? origin : undefined);
    // Вычёркивание идёт до обрезки, иначе значение, разрезанное границей, осталось бы началом в строке; хвост дальше предела отбрасывается заранее.
    const reach = limits.logLineBytes + secrets.reduce((n, s) => Math.max(n, s.length), 0);
    const long = raw.length > reach;
    const redacted = redactSecrets(long ? raw.slice(0, reach) : raw, secrets);
    const text = clipLine(redacted, limits.logLineBytes, long ? Buffer.byteLength(raw) : Buffer.byteLength(redacted));
    if (w.lines < limits.logRate) {
      w.lines++;
      options.onLog?.(origin, text, level);
      return;
    }
    w.skipped++;
    if (level === 'error') {
      w.errors++;
      w.lastError = text;
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
        line(p.pluginId === '' ? `хост ${host.id}` : mine(p.pluginId).id, p.text, p.level);
      });
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
