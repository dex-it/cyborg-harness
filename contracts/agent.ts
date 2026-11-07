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
  /** Инструменты плагинов для этой сессии; агент без MCP их пропускает. */
  readonly tools?: AgentToolsEndpoint;
}

/** Сервер MCP (Streamable HTTP) потребителя: токен называет сессию, поэтому он у каждой свой и в argv не идёт. */
export interface AgentToolsEndpoint {
  readonly url: string;
  readonly token: string;
}

/** `cyborg.agent-tool` 1, кратность many: инструменты, которые агент зовёт по MCP; сервер держит потребитель `cyborg.agent`. */
export interface AgentTool {
  tools(): readonly AgentToolSpec[] | Promise<readonly AgentToolSpec[]>;
  call(name: string, input: unknown, session: AgentToolSession): Promise<AgentToolResult>;
}

export interface AgentToolSpec {
  /** `[A-Za-z0-9_-]`, до 64 знаков; повтор у другого поставщика отброшен - первым идёт меньший id плагина. */
  readonly name: string;
  readonly description: string;
  /** JSON Schema аргумента, `type: "object"`; проверяет его поставщик. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface AgentToolSession {
  /** `LaunchRequest.sessionId` сессии, чей агент позвал. */
  readonly sessionId: string;
}

export interface AgentToolResult {
  /** Ответ агенту. */
  readonly text: string;
  readonly isError?: boolean;
  /** Действия, которые инструмент предлагает человеку в этой сессии; следующий запрос человека их снимает. */
  readonly actions?: readonly SessionAction[];
}

/** Кнопка: `text` уходит в сессию; `submit` - сразу с Enter, если агент ждёт новой реплики, иначе в строку ввода. */
export interface SessionAction {
  readonly label: string;
  readonly text: string;
  readonly submit?: boolean;
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
  /** Сессия агента началась или сменилась; `launch({ resumeId })` её продолжит. */
  | { readonly type: 'session'; readonly resumeId: string }
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
