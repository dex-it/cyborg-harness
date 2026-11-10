import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PluginModule } from '@cyborg-harness/contracts';
import {
  inlineHosts,
  load,
  PLUGIN_API_VERSION,
  SectionStore,
  type Importer,
  type JournalEntry,
  type Kernel,
  type LayerStore,
  type LoadOptions,
  type OsEnvironment,
} from '@cyborg-harness/core';
import { fakePty, type FakePty } from './fake-pty.ts';
import { memorySecrets, type MemorySecrets } from './memory.ts';
import { sandbox, type Sandbox } from './sandbox.ts';

/** Плагин из кода теста: манифест (сырой JSON, ядро разберёт и проверит его само) и модуль главной части. */
export interface InlinePlugin {
  readonly manifest: Record<string, unknown>;
  readonly module: PluginModule;
}

/** Каталог плагина (в нём `manifest.json` и `index.mjs`, `index.js` или `index.ts`, как у плагинов стенда) или плагин из кода теста. */
export type TestPlugin = string | InlinePlugin;

const ENTRY_FILES = ['index.mjs', 'index.js', 'index.ts'];

export interface ResolvedPlugin {
  readonly id: string;
  readonly manifest: unknown;
  /** Что хост передаст импортёру: file URL точки входа или метка плагина из кода. */
  readonly entry: string;
  readonly module?: PluginModule;
  /** Каталог плагина; у плагина из кода теста его нет. */
  readonly dir?: string;
}

function idOf(manifest: unknown, where: string): string {
  const id = typeof manifest === 'object' && manifest !== null && 'id' in manifest ? manifest.id : undefined;
  if (typeof id !== 'string' || id === '') throw new Error(`${where}: в манифесте нет строки id`);
  return id;
}

/** Собирает манифест и точку входа; ошибка называет каталог. */
export function resolvePlugin(plugin: TestPlugin): ResolvedPlugin {
  if (typeof plugin !== 'string') {
    const id = idOf(plugin.manifest, 'плагин из кода теста');
    return { id, manifest: plugin.manifest, entry: `inline:${id}`, module: plugin.module };
  }
  const file = path.join(plugin, 'manifest.json');
  if (!existsSync(file)) throw new Error(`${plugin}: нет manifest.json`);
  const manifest: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const main = ENTRY_FILES.map((f) => path.join(plugin, f)).find((f) => existsSync(f));
  if (main === undefined) throw new Error(`${plugin}: нет точки входа (${ENTRY_FILES.join(', ')})`);
  return { id: idOf(manifest, file), manifest, entry: pathToFileURL(main).href, dir: plugin };
}

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
  /**
   * Остальные параметры `load()`: `hosts`, `limits`, `activationTimeout` и т.д. Поля, которые собирает тест-кит, здесь не принимаются.
   * `schema` по умолчанию читает `config.schema` и `state.schema` из каталога плагина; своё значение заменяет чтение целиком.
   */
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
  waitForJournal<K extends JournalKind>(match: { readonly kind: K; readonly pluginId?: string }, options?: WaitOptions): Promise<Extract<JournalEntry, { kind: K }>>;
  waitForJournal(match: (entry: JournalEntry) => boolean, options?: WaitOptions): Promise<JournalEntry>;
  /** Снимает плагины и хосты и удаляет песочницу; повторный вызов ничего не делает. */
  [Symbol.asyncDispose](): Promise<void>;
}

/** Схема раздела из каталога плагина: ядро просит её у приложения, в тесте приложение - каталог плагина. */
function schemaFromDirs(plugins: readonly ResolvedPlugin[]): NonNullable<LoadOptions['schema']> {
  const dirs = new Map(plugins.flatMap((p) => (p.dir === undefined ? [] : [[p.id, path.resolve(p.dir)] as const])));
  return (manifest, file) => {
    const dir = dirs.get(manifest.id);
    if (dir === undefined) throw new Error('плагин из кода теста: файлов схем у него нет, передайте load.schema');
    // Путь `./<файл>.json` внутри каталога ядро проверило при разборе манифеста.
    return JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as unknown;
  };
}

const describeEntry = (e: JournalEntry): string => `${e.pluginId ?? '-'}:${e.kind}`;

/**
 * Поднимает ядро с плагинами теста на хостах внутри процесса теста (`inlineHosts`): граница данных та же, что в окне, изоляции сбоев нет.
 * Снимать ядро - `await using k = await startKernel(...)`.
 */
export async function startKernel(options: StartKernelOptions): Promise<TestKernel> {
  const plugins = options.plugins.map(resolvePlugin);
  const ids = plugins.map((p) => p.id);
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate !== undefined) throw new Error(`плагин ${duplicate} назван дважды`);

  const box = await sandbox('cyborg-kit-');
  const backend = fakePty();
  const secrets = memorySecrets();
  const os: OsEnvironment = {
    dataDir: box.path('data'),
    tempDir: box.path('temp'),
    home: box.root,
    env: { PATH: '/usr/bin:/bin', HOME: box.root },
    pty: backend,
    secrets,
    ...options.os,
  };
  const inline = new Map(plugins.flatMap((p) => (p.module ? [[p.entry, p.module] as const] : [])));
  const importer: Importer = async (entry) => inline.get(entry) ?? ((await import(entry)) as { default: PluginModule }).default;
  const entries = new Map(plugins.map((p) => [p.id, p.entry]));

  let kernel: Kernel;
  try {
    kernel = await load({
      schema: schemaFromDirs(plugins),
      ...options.load,
      apiVersion: PLUGIN_API_VERSION,
      enabled: options.enabled ?? ids,
      manifests: plugins.map((p) => p.manifest),
      entry: (m) => entries.get(m.id) ?? m.id,
      spawnHost: inlineHosts(importer),
      os,
      ...(options.config && { config: await SectionStore.open(options.config, ['user', 'workspace']) }),
      ...(options.state && { state: await SectionStore.open(options.state, ['workspace']) }),
    });
  } catch (error) {
    await box[Symbol.asyncDispose]();
    throw error;
  }

  const waitForJournal = async (match: { readonly kind: JournalKind; readonly pluginId?: string } | ((e: JournalEntry) => boolean), wait: WaitOptions = {}): Promise<JournalEntry> => {
    const test = typeof match === 'function' ? match : (e: JournalEntry) => e.kind === match.kind && (match.pluginId === undefined || e.pluginId === match.pluginId);
    const deadline = Date.now() + (wait.timeout ?? 5000);
    for (;;) {
      const found = kernel.journal.find(test);
      if (found) return found;
      if (Date.now() >= deadline) throw new Error(`в журнале нет нужной записи за ${String(wait.timeout ?? 5000)} мс; есть: ${kernel.journal.map(describeEntry).join(', ') || 'пусто'}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  let closed: Promise<void> | undefined;
  return Object.assign(Object.create(kernel), {
    sandbox: box,
    pty: backend,
    secrets,
    dataDir: (pluginId: string) => path.join(os.dataDir, pluginId),
    waitForJournal,
    [Symbol.asyncDispose]: () =>
      (closed ??= kernel.unload().finally(() => box[Symbol.asyncDispose]())),
  }) as TestKernel;
}
