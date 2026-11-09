// Пределы ресурсов плагина (SAD §3.7): одна таблица значений по умолчанию, приложение переопределяет через `LoadOptions.limits`.

export interface ResourceLimits {
  /** Байт UTF-8 в одном вводе pty - из главной части и из вида. */
  readonly ptyInput: number;
  /** Живых pty у плагина, включая ждущие attach после падения хоста или выключения. */
  readonly ptys: number;
  /** Мс склейки вывода pty: первый кусок после затишья уходит сразу, следующие - пачкой через столько мс. 0 - каждый кусок сразу. */
  readonly ptyFlushMs: number;
  /** Символов накопленного вывода pty, после которых пачка уходит, не дожидаясь интервала. */
  readonly ptyFlushChars: number;
  /** Одновременных `process.run` у плагина. */
  readonly runs: number;
  /** Байт stdout и stderr `process.run` (каждого) по умолчанию; дальше программа остановлена, ответ - `truncated`. */
  readonly processOutput: number;
  /** Потолок опции `maxOutputBytes` у `process.run`; больше - `Invalid`. */
  readonly processOutputMax: number;
  /** Байт файла для `fs.readText`; крупнее читается частями через `fs.readSlice`. */
  readonly readText: number;
  /** Живых подписок плагина-потребителя через контракты. */
  readonly subscriptions: number;
  /** Слушателей `onIdle` у плагина. */
  readonly idleWatchers: number;
}

export const LIMITS: ResourceLimits = {
  ptyInput: 1024 * 1024,
  ptys: 32,
  ptyFlushMs: 4,
  ptyFlushChars: 64 * 1024,
  runs: 16,
  processOutput: 16 * 1024 * 1024,
  processOutputMax: 64 * 1024 * 1024,
  readText: 8 * 1024 * 1024,
  subscriptions: 256,
  idleWatchers: 64,
};

export function limitsOf(...overrides: (Partial<ResourceLimits> | undefined)[]): ResourceLimits {
  return Object.assign({}, LIMITS, ...overrides) as ResourceLimits;
}
