import fs from 'node:fs';
import type { HostCommand } from '@cyborg-harness/core';

// TR-22 (ADR-CH-0019, п. 4): ограничитель ОС за интерфейсом запуска. Хост стороннего плагина запускается обёрнутой командой (`sandbox-exec … node …` на macOS,
// `cyborg-confine … -- node …` на Linux); что именно обёртка закроет, знает она, а доказывает хост сам (canary: сокет не открывается). Адаптер Electron знает только этот
// интерфейс: заменить `sandbox-exec` помощником (если Apple уберёт утилиту) значит заменить реализацию, а не запуск.

/** Что хосту разрешено читать и исполнять; остальное ограничитель закрывает. Пути настоящие (после `realpath`): Seatbelt и Landlock сверяют их, а не ссылки. */
export interface ConfinePolicy {
  /** Каталоги и файлы, чьё содержимое читать можно: каталог плагина, код хоста. */
  readonly read: readonly string[];
  /** Исполняемые файлы: бинарник Node. Запустить после него ничего нельзя. */
  readonly exec: readonly string[];
}

export type ConfinerStatus =
  | {
      readonly ok: true;
      /** Что ограничитель закрывает, словами для окна. */
      readonly summary: string;
      /** Чтение файлов ограничено самой ОС. `false` - файлы держат только запреты Node (ядро Linux без Landlock), уровень изоляции тогда не 3. */
      readonly files: boolean;
    }
  | { readonly ok: false; readonly reason: string };

export interface ConfinerLauncher {
  /** Короткое имя для журнала: `seatbelt`, `landlock+seccomp`. */
  readonly name: string;
  /** Можно ли им пользоваться на этой машине; вычисляется один раз при создании. */
  readonly status: ConfinerStatus;
  /** Команда запуска хоста, обёрнутая ограничителем. */
  wrap(command: HostCommand, policy: ConfinePolicy): HostCommand;
}

/** Настоящий путь; несуществующий остаётся как есть (ограничитель сам скажет, что его нет). */
export function realPath(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}
