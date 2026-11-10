import type { Subscription } from './index.ts';

/**
 * `cyborg.sessions` 1, кратность one, черновик пилота PL-02: из реестра сессий (SAD 5) здесь только события, которых ждёт `session-notifications`.
 * Остальные члены каталога (`create`, `send`, `paste`, метки) добавит полный `sessions` минорными версиями; новый вариант `SessionChange` - тоже минорная версия, потребитель пропускает незнакомый.
 */
export interface Sessions {
  /** Изменения всех сессий с момента подписки; прошлое не повторяется. Слушатель, бросивший исключение, соседям не мешает. */
  onChange(listener: (event: SessionEvent) => void): Subscription;
  /**
   * С версии 1.1: открыть вкладку сессии в окне, то есть сделать её документ активным (`ctx.documents.reveal` поставщика). Окно из фона не поднимает.
   * Вкладка вышедшей сессии остаётся и открывается тоже. Сессии нет (не этого запуска или вкладку закрыл человек) - отказ с понятным текстом.
   * Поставщик 1.0 члена не даёт: потребитель проверяет, что он есть.
   */
  reveal?(sessionId: string): Promise<void>;
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
