import type { LogLevel } from '@cyborg-harness/contracts';

/** Уровни строки `ctx.log` и вывода хоста; порядок - от обычного к тяжёлому. */
export const LOG_LEVELS: readonly LogLevel[] = ['info', 'warn', 'error'];
