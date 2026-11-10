import type { Subscription } from './index.ts';

/**
 * Буква `git status --porcelain=v1`: `M` изменён, `T` сменился тип, `A` добавлен, `D` удалён, `R` переименован, `C` скопирован, `U` не слит, `?` не отслеживается, пробел - без изменений.
 * Поставщик отдаёт буквы как есть, а смысл (что показать в дереве) придаёт потребитель.
 */
export type GitCode = ' ' | 'M' | 'T' | 'A' | 'D' | 'R' | 'C' | 'U' | '?';

export interface GitChange {
  /** Относительно корня рабочего дерева, разделитель `/`. */
  readonly path: string;
  /** Состояние в индексе (X). */
  readonly index: GitCode;
  /** Состояние в рабочем дереве (Y). */
  readonly worktree: GitCode;
  /** Откуда переименован или скопирован. */
  readonly from?: string;
}

export interface GitStatus {
  /** Ветка; `null` - голова отсоединена. */
  readonly branch: string | null;
  /** Отслеживаемая ветка (`origin/main`); нет - поля нет. */
  readonly upstream?: string;
  readonly ahead: number;
  readonly behind: number;
  readonly changes: readonly GitChange[];
}

/**
 * `cyborg.git` 1, кратность one (SAD, раздел 4, правило 11): плагин `git` держит право `process` на программу `git`, остальные плагины его не просят.
 * Черновик PL-04: только то, что нужно дереву; `headContent`, `branches`, `switch`, `remotes`, `files` из SAD добавляются необязательными членами (минор).
 * Поставщик объявляет `guard: { "fs.read": 0 }` на каждый член с путём: вызывающий без права читать репозиторий сведений о нём не получает.
 */
export interface Git {
  /** Состояние рабочего дерева; `repo` - абсолютный корень дерева. Не репозиторий - `null`. */
  status(repo: string): Promise<GitStatus | null>;
  /** Изменился индекс, голова или ветка репозитория (коммит, `checkout`, `add` снаружи). Правка файлов рабочего дерева сюда не входит: о ней знает тот, кто за ним следит. */
  onChange(repo: string, listener: () => void): Subscription;
}
