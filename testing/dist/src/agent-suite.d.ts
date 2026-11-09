import type { OsEnvironment } from '@cyborg-harness/core';
import { type TestPlugin } from './kernel.js';
import { type Sandbox } from './sandbox.js';
/** `pty?: never`, а не один `Omit`: объект с `pty` рядом с другим полем среды `Omit` пропускает, отказ ловит только объект из одного `pty`. */
type SuiteOs = Omit<Partial<OsEnvironment>, 'pty'> & {
    readonly pty?: never;
};
export interface AgentSuiteOptions {
    /**
     * Среда, в которой программа агента находится: например PATH с подставным исполняемым файлом и `SHELL`, если поставщик запускает `$SHELL`.
     * Получает песочницу набора; её корень - `cwd` всех запросов набора. Без неё работает среда `startKernel` по умолчанию.
     * `pty` здесь нет: запуск через потребителя набор наблюдает в своём `fakePty()`, а свой бэкенд оставил бы проверку слепой.
     */
    readonly os?: (box: Sandbox) => SuiteOs | Promise<SuiteOs>;
    /** Плагины, без которых поставщик не активируется (его `requires`). */
    readonly plugins?: readonly TestPlugin[];
}
/** Имена проверок набора по порядку. */
export declare const AGENT_CHECK_NAMES: readonly string[];
/**
 * Прогоняет все проверки на поставщике и бросает на первой неудачной (в сообщении её имя). Нужна для проверки самого набора на плохом поставщике и для запуска вне `node:test`.
 */
export declare function checkAgentContract(provider: TestPlugin, options?: AgentSuiteOptions): Promise<void>;
/**
 * Общий набор тестов `cyborg.agent`: один и тот же для встроенных и сторонних поставщиков. Вызывается на верхнем уровне тестового файла:
 *
 *     agentContractSuite('/path/to/my-agent', { os: (box) => ({ env: { PATH: '/usr/bin:/bin' } }) });
 *
 * Поставщик - каталог плагина или плагин из кода. Потребителя (с правом `pty`, равным `launch` поставщика) и ядро набор поднимает сам.
 */
export declare function agentContractSuite(provider: TestPlugin, options?: AgentSuiteOptions): void;
export {};
