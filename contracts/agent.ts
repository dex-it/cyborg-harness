import type { PtyExit } from './os.ts';
import type { Subscription } from './index.ts';

/** `cyborg.agent` 1, кратность many (ADR-CH-0004): поставщик описывает запуск и переводит следы агента в события, pty держит потребитель. */
export interface Agent {
  /** Факты, а не обещания: потребитель не зовёт того, чего нет в `capabilities`. */
  facts(): Promise<AgentFacts>;
  launch(request: LaunchRequest): Promise<LaunchSpec>;
  /** События сессии с момента подписки; у агента без следов подписка молчит. */
  watch(sessionId: string, listener: (event: AgentEvent) => void): Subscription;
  /** Процесс сессии завершился: поставщик убирает свои файлы и называет причину по коду выхода, без разбора текста. */
  ended(sessionId: string, exit: PtyExit): Promise<RecoveryHint | null>;
  /** Прошлые сессии в каталоге; без `capabilities.history` - пусто. */
  history(cwd: string): Promise<HistoryEntry[]>;
}

export interface AgentFacts {
  readonly id: string;
  readonly title: string;
  /** Программа агента найдена там, где её запустит `launch`. */
  readonly found: boolean;
  readonly version?: string;
  readonly capabilities: {
    readonly resume: boolean;
    readonly history: boolean;
    /** Агент сообщает о себе через `watch`, а не только выводом в терминал. */
    readonly events: boolean;
  };
}

export interface LaunchRequest {
  /** Устойчивый id сессии у потребителя: им поставщик называет свои файлы, он же приходит в `watch` и `ended`. */
  readonly sessionId: string;
  readonly cwd: string;
  readonly extraDirs?: readonly string[];
  /** Первый запрос человека. */
  readonly prompt?: string;
  /** id прошлой сессии из `history`. */
  readonly resumeId?: string;
  /** Дополнения потребителя к системному промпту: изоляция, кнопки. */
  readonly promptFragments?: readonly string[];
}

/** Готовый вход `ctx.os.pty.spawn`; `program` бывает `$SHELL` - оболочка входа, путь подставит ядро. */
export interface LaunchSpec {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export type AgentEvent =
  | { readonly type: 'cwd'; readonly cwd: string }
  /** Агент работает; `tool` - инструмент, если известен. */
  | { readonly type: 'activity'; readonly tool?: string }
  /** Человек отправил запрос: прошлые предложения агента больше не к месту. */
  | { readonly type: 'prompt' }
  /** Ход закончен; `background` - агент проснётся сам (фоновая задача, расписание). */
  | { readonly type: 'turnEnd'; readonly text?: string; readonly background: boolean }
  /** Агент стоит на вопросе, разрешении или лимите; текст зависит только от рода ожидания. */
  | { readonly type: 'waiting'; readonly reason: string };

export interface RecoveryHint {
  readonly kind: 'notFound' | 'authRequired' | 'rateLimited' | 'resumeFailed';
  readonly message: string;
}

export interface HistoryEntry {
  readonly id: string;
  readonly cwd: string;
  readonly title: string;
  /** Последняя запись журнала, мс. */
  readonly updated: number;
}
