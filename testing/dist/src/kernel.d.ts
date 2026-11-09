import type { PluginModule } from '@cyborg-harness/contracts';
import { type JournalEntry, type Kernel, type LayerStore, type LoadOptions, type OsEnvironment } from '@cyborg-harness/core';
import { type FakePty } from './fake-pty.js';
import { type MemorySecrets } from './memory.js';
import { type Sandbox } from './sandbox.js';
/** Плагин из кода теста: манифест (сырой JSON, ядро разберёт и проверит его само) и модуль главной части. */
export interface InlinePlugin {
    readonly manifest: Record<string, unknown>;
    readonly module: PluginModule;
}
/** Каталог плагина (в нём `manifest.json` и `index.mjs`, `index.js` или `index.ts`, как у плагинов стенда) или плагин из кода теста. */
export type TestPlugin = string | InlinePlugin;
export interface ResolvedPlugin {
    readonly id: string;
    readonly manifest: unknown;
    /** Что хост передаст импортёру: file URL точки входа или метка плагина из кода. */
    readonly entry: string;
    readonly module?: PluginModule;
}
/** Собирает манифест и точку входа; ошибка называет каталог. */
export declare function resolvePlugin(plugin: TestPlugin): ResolvedPlugin;
export type JournalKind = JournalEntry['kind'];
export interface WaitOptions {
    /** Сколько ждать, мс; по умолчанию 5000. */
    readonly timeout?: number;
}
export interface StartKernelOptions {
    readonly plugins: readonly TestPlugin[];
    /**
     * Поверх среды по умолчанию: каталоги данных, `home` и `env` внутри песочницы, `fakePty()` и `memorySecrets()`.
     * Своё значение поля заменяет умолчание целиком.
     */
    readonly os?: Partial<OsEnvironment>;
    /** Какие плагины включены; по умолчанию все из `plugins`. */
    readonly enabled?: readonly string[];
    /** Слои `config` (`user`, `workspace`) в памяти или в другом хранилище, например из `memoryStore()`. */
    readonly config?: LayerStore;
    /** Слой `state` (`workspace`). */
    readonly state?: LayerStore;
    /** Остальные параметры `load()`: `hosts`, `limits`, `activationTimeout` и т.д. Поля, которые собирает тест-кит, здесь не принимаются. */
    readonly load?: Omit<Partial<LoadOptions>, 'apiVersion' | 'enabled' | 'manifests' | 'entry' | 'spawnHost' | 'os' | 'config' | 'state'>;
}
/** Ядро теста: всё, что у `Kernel`, плюс среда, которую тест-кит подставил, и ожидание журнала. */
export interface TestKernel extends Kernel {
    readonly sandbox: Sandbox;
    /** Поддельный pty, который тест-кит дал среде; если тест подставил свой `os.pty`, этот не используется. */
    readonly pty: FakePty;
    /** Хранилище секретов в памяти; если тест подставил свой `os.secrets`, это не используется. */
    readonly secrets: MemorySecrets;
    /** `<dataDir>/<pluginId>`: область `plugin-data` плагина. */
    dataDir(pluginId: string): string;
    /** Первая запись журнала, подходящая под `kind` и `pluginId` (или под предикат); уже записанные тоже считаются. Нет за срок - ошибка с перечнем записей. */
    waitForJournal<K extends JournalKind>(match: {
        readonly kind: K;
        readonly pluginId?: string;
    }, options?: WaitOptions): Promise<Extract<JournalEntry, {
        kind: K;
    }>>;
    waitForJournal(match: (entry: JournalEntry) => boolean, options?: WaitOptions): Promise<JournalEntry>;
    /** Снимает плагины и хосты и удаляет песочницу; повторный вызов ничего не делает. */
    [Symbol.asyncDispose](): Promise<void>;
}
/**
 * Поднимает ядро с плагинами теста на хостах внутри процесса теста (`inlineHosts`): граница данных та же, что в окне, изоляции сбоев нет.
 * Снимать ядро - `await using k = await startKernel(...)`.
 */
export declare function startKernel(options: StartKernelOptions): Promise<TestKernel>;
