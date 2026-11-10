// Пределы ресурсов плагина (SAD §3.7): одна таблица значений по умолчанию, приложение переопределяет через `LoadOptions.limits`.

export interface ResourceLimits {
  /** Байт UTF-8 в одном вводе pty - из главной части и из вида. */
  readonly ptyInput: number;
  /** Запас ввода одного pty, байт: столько можно отдать сразу, не глядя на скорость (вставка, набор). Ядро не видит, читает ли программа stdin, и ограничивает сами байты (У-47). */
  readonly ptyInputBurst: number;
  /** Скорость пополнения запаса ввода одного pty, байт в секунду: дольше этого предела программа, не читающая stdin, копит очередь в памяти pty-хоста. */
  readonly ptyInputRate: number;
  /** Потолок невычитанного ввода одного pty, байт: принятое без единого байта вывода программы; сверх него `Invalid`, вывод программы обнуляет счёт. Выше `ptyInputBurst`, иначе запас не использовать целиком. node-pty очередь записи не отдаёт, поэтому признак чтения - вывод (#167). */
  readonly ptyQueue: number;
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
  /** Байт одного сообщения канала «главная часть - вид» в любую сторону (размер по `v8.serialize`); больше - `Invalid`. */
  readonly viewMessage: number;
  /** Байт UTF-8 в строке `ctx.log` и в строке вывода хоста; длиннее обрезается с пометкой (FR-CH-4018). */
  readonly logLineBytes: number;
  /** Строк плагина за интервал `logWindowMs`; сверх этого строки в журнал по одной не идут, а в конце интервала пишется одна сводная запись `log-summary`. */
  readonly logRate: number;
  /** Интервал счёта строк плагина, мс; он же интервал сводной записи. */
  readonly logWindowMs: number;
  /** Сколько мс подряд плагин может превышать `logRate`, прежде чем ядро его выключит (запись `switched-off` с `reason: 'log-flood'`). */
  readonly logFloodMs: number;
  /** Интервал счётчика частого потока в трассе (вывод pty, события `fs.watch`), мс: за него пишется одна запись с числом сообщений и байт (FR-CH-4005). */
  readonly traceStreamMs: number;
}

export const LIMITS: ResourceLimits = {
  ptyInput: 1024 * 1024,
  // Числа выбраны ядром (задача #134): запас в четыре предела ввода, чтобы вставка 1 МиБ не упёрлась в него и повторялась, и 256 КиБ/с вдвое выше пиковой скорости агента, которого читает программа.
  ptyInputBurst: 4 * 1024 * 1024,
  ptyInputRate: 256 * 1024,
  // Два запаса: вставка в молчащий терминал проходит целиком, а память хоста под очередь не больше 8 МиБ на pty (было до 900 МиБ в час).
  ptyQueue: 8 * 1024 * 1024,
  ptys: 32,
  ptyFlushMs: 4,
  ptyFlushChars: 64 * 1024,
  runs: 16,
  processOutput: 16 * 1024 * 1024,
  processOutputMax: 64 * 1024 * 1024,
  readText: 8 * 1024 * 1024,
  subscriptions: 256,
  idleWatchers: 64,
  viewMessage: 64 * 1024,
  // Числа предложены нормой (SRS фичи 04, вопрос 10), владелец их не принял: меняются здесь одной строкой.
  logLineBytes: 8 * 1024,
  logRate: 100,
  logWindowMs: 1000,
  logFloodMs: 10_000,
  // Предложение нормы (SRS фичи 04, вопрос 10), владелец его не принял.
  traceStreamMs: 1000,
};

export function limitsOf(...overrides: (Partial<ResourceLimits> | undefined)[]): ResourceLimits {
  return Object.assign({}, LIMITS, ...overrides) as ResourceLimits;
}
