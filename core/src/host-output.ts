import type { LogLevel } from '@cyborg-harness/contracts';

type Done = (error?: Error | null) => void;

/** Поток вывода процесса: перехвату нужен только `write`. */
export interface OutStream {
  write(chunk: string | Uint8Array, encoding?: BufferEncoding | Done, callback?: Done): boolean;
}

/** Строка вывода хоста для ядра: `pluginId` - плагин, чей код выполнялся; пусто - плагин определить нельзя, строка хоста. */
export interface OutputNote {
  readonly pluginId: string;
  readonly level: LogLevel;
  readonly text: string;
}

/**
 * Вывод процесса хоста (`console.*`, `process.stdout.write`, `process.stderr.write`) уходит ядру строками вместо терминала (FR-CH-4010).
 * Плагин называет `current`: хост ведёт цепочку вызовов плагина (`AsyncLocalStorage`), поэтому вывод из таймера и из продолжения промиса
 * относится к тому, кто их завёл. В общем хосте это диагностика, а не доказательство: плагин вправе выдать свой вывод за чужой, заведя код в чужой цепочке.
 * Уровень: `stdout` - `info`, `stderr` - `error`, а `console.warn`, который Node тоже пишет в `stderr`, - `warn`.
 * Запись без перевода строки считается строкой; пустые строки не передаются. Канал с ядром не принял строку (хост выгружается) - она идёт в настоящий поток.
 */
export function captureOutput(
  streams: { readonly stdout: OutStream; readonly stderr: OutStream },
  console: { warn: (...args: unknown[]) => void },
  current: () => string | undefined,
  send: (note: OutputNote) => void,
): void {
  let forced: LogLevel | undefined;
  const warn = console.warn;
  console.warn = (...args) => {
    forced = 'warn';
    try {
      warn.apply(console, args);
    } finally {
      forced = undefined;
    }
  };
  const capture = (stream: OutStream, own: LogLevel): void => {
    const original = stream.write.bind(stream);
    stream.write = (chunk, encoding, callback) => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      try {
        const pluginId = current() ?? '';
        const level = forced ?? own;
        for (const raw of text.split('\n')) {
          const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
          if (line !== '') send({ pluginId, level, text: line });
        }
      } catch {
        return original(chunk, encoding, callback);
      }
      const done = typeof encoding === 'function' ? encoding : callback;
      if (done) queueMicrotask(() => done());
      return true;
    };
  };
  capture(streams.stdout, 'info');
  capture(streams.stderr, 'error');
}
