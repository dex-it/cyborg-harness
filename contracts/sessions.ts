import type { Subscription } from './index.ts';

/**
 * `cyborg.sessions` 1, кратность one, черновик пилота PL-02: из реестра сессий (SAD 5) здесь только события, которых ждёт `session-notifications`.
 * Остальные члены каталога (`create`, `send`, `paste`, `reveal`, метки) добавит полный `sessions` минорными версиями; новый вариант `SessionChange` - тоже минорная версия, потребитель пропускает незнакомый.
 */
export interface Sessions {
  /** Изменения всех сессий с момента подписки; прошлое не повторяется. Слушатель, бросивший исключение, соседям не мешает. */
  onChange(listener: (event: SessionEvent) => void): Subscription;
}

export interface SessionEvent {
  /** Устойчивый id сессии у `sessions`: тот же, что `LaunchRequest.sessionId`. */
  readonly sessionId: string;
  /** Подпись сессии для человека (уведомление, список). */
  readonly title: string;
  readonly change: SessionChange;
}

export type SessionChange =
  /** Рабочий каталог сессии изменился. */
  | { readonly type: 'cwd'; readonly cwd: string }
  /** Агент работает или человек отправил запрос: сессия снова занята, прежнее ожидание снято. */
  | { readonly type: 'activity'; readonly tool?: string }
  /** Агент стоит на вопросе, разрешении или лимите либо закончил ход и молчит; `reason` зависит только от рода ожидания. */
  | { readonly type: 'waiting'; readonly reason: string }
  /** Процесс сессии завершился. */
  | { readonly type: 'exit'; readonly code: number };
