import { CoreError, errorMessage } from './errors.ts';
import { DEFAULT_ORDER } from './layout.ts';
import type { KernelContext, Menus } from './kernel-context.ts';
import type { MenuEntry } from './menu-entry.ts';
import { resolveKey } from './keys.ts';
import { MENU_NAMES, type MenuItemDecl, type StateSource } from './manifest-menus.ts';
import type { PluginManifest } from './manifest.ts';
import { pluginMark } from './plugin-mark.ts';
import { MENU_OWNER } from './window-layer.ts';
import { own } from './wire.ts';

/*
 * Меню окна по манифестам (SAD 3.9, FR-CH-2025): что ядро знает о пунктах плагинов. Приложение собирает меню ОС по снимку `Kernel.menus`
 * и не называет плагины по именам; подписи меню, их порядок и пункты самого приложения - его дело, ядро задаёт меню из `MENU_NAMES` и порядок пунктов в них.
 */

/** Имя пункта в таблице сочетаний: оно не пересекается с id плагинов и команд, в них нет `/`. */
export const menuItemKey = (pluginId: string, id: string): string => `${pluginId}/${id}`;

/** Сочетания пунктов для таблицы окна и меню (`LoadOptions.menuKeys`): пункт -> сочетание. Порядок по имени пункта: победитель конфликта не зависит от порядка манифестов. */
export function menuAccelerators(manifests: readonly PluginManifest[]): Record<string, string> {
  const found: [string, string][] = [];
  for (const m of manifests) for (const item of m.contributes?.menus ?? []) if (item.accelerator !== undefined) found.push([menuItemKey(m.id, item.id), item.accelerator]);
  return Object.fromEntries(found.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

// Не localeCompare: порядок не должен зависеть от языка и ICU машины.
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const compare = (a: MenuEntry, b: MenuEntry): number => MENU_NAMES.indexOf(a.menu) - MENU_NAMES.indexOf(b.menu) || a.order - b.order || cmp(a.pluginId, b.pluginId) || cmp(a.id, b.id);

/** Сколько ждать ответа владельца состояния: висящий вызов не должен держать обновление всего меню. */
const SOURCE_TIMEOUT_MS = 2000;

/** События журнала, после которых состояние плагинов могло измениться: меню перечитывает источники. */
const STATE_KINDS: ReadonlySet<string> = new Set(['activated', 'waiting', 'unloaded', 'deactivated', 'failed', 'skipped', 'revived', 'switched-off', 'host-down', 'host-restart', 'host-abandoned']);

interface Evaluated {
  enabled?: boolean;
  checked?: boolean;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CoreError('Timeout', `нет ответа за ${String(ms)} мс`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

export function createMenus(ctx: KernelContext): Menus {
  const platform = ctx.options.platform ?? process.platform;
  /** Прочитанное у владельцев: пункт -> значения; обновляет только `evaluate`. */
  let states = new Map<string, Evaluated>();
  /** Последняя ошибка источника по пункту и полю: повтор той же не пишется. */
  const failures = new Map<string, string>();
  let current: Promise<void> | undefined;
  let again = false;
  /** Просили перечитать, пока шло чтение: через функцию, чтобы анализатор не считал флаг неизменным внутри цикла. */
  const asked = (): boolean => again;
  /** Приложение получило ядро и читает снимок само: с этого момента его перемены сообщаются `onMenus`. */
  let started = false;
  let announced = '';

  const working = (id: string): boolean => {
    const { activation } = ctx.parts;
    return ctx.active.includes(id) || activation.waiting.has(id) || activation.waking.has(id) || activation.activating.has(id);
  };

  function entryOf(m: PluginManifest, item: MenuItemDecl): MenuEntry {
    const mark = pluginMark(ctx, m.id);
    const live = ctx.active.includes(m.id);
    const read = states.get(menuItemKey(m.id, item.id));
    // Ждущий первого обращения плагин доступен: нажатие его разбудит, а источники у него без запуска не прочитать.
    const allowed = item.enabled === undefined || !live || read?.enabled === true;
    const bound = item.accelerator === undefined ? undefined : ctx.keys.get(resolveKey(item.accelerator, platform));
    const holds = bound?.pluginId === MENU_OWNER && bound.command === menuItemKey(m.id, item.id);
    return {
      pluginId: m.id,
      id: item.id,
      menu: item.menu,
      title: item.title,
      command: item.command,
      order: item.order ?? DEFAULT_ORDER,
      ...(holds && item.accelerator !== undefined && { accelerator: item.accelerator }),
      enabled: mark === undefined && working(m.id) && allowed,
      ...(item.checked !== undefined && { checked: live && read?.checked === true }),
      ...(mark && { mark }),
    };
  }

  function snapshot(): MenuEntry[] {
    return ctx.known.flatMap((m) => (m.contributes?.menus ?? []).map((item) => entryOf(m, item))).sort(compare);
  }

  function fail(pluginId: string, item: string, field: 'enabled' | 'checked', error: string | undefined): void {
    const key = `${pluginId}/${item}:${field}`;
    if (error === undefined) {
      failures.delete(key);
      return;
    }
    if (failures.get(key) === error) return;
    failures.set(key, error);
    ctx.record({ pluginId, kind: 'menu-source', item, field, error });
  }

  /** Член контракта, который читает пункт: собственный или полученный по requires/optional. */
  async function call(m: PluginManifest, source: StateSource): Promise<unknown> {
    const { contract, major, member } = source;
    if (own(m.provides, contract) === undefined) return ctx.parts.contracts.callAs(m.id, contract, major, member, []);
    const impl = ctx.registry.provided(m.id, contract, major);
    if (impl === undefined) throw new CoreError('Unavailable', `${contract}: плагин его ещё не отдал`);
    const fn = Object.hasOwn(impl, member) ? impl[member] : undefined;
    if (typeof fn !== 'function') throw new CoreError('Invalid', `${contract}.${member}: не метод контракта`);
    return (fn as (...xs: unknown[]) => unknown).apply(impl, []);
  }

  async function read(m: PluginManifest, item: MenuItemDecl, field: 'enabled' | 'checked', source: StateSource, into: Evaluated): Promise<void> {
    try {
      const value = await withTimeout(Promise.resolve(call(m, source)), SOURCE_TIMEOUT_MS);
      if (typeof value !== 'boolean') throw new CoreError('Invalid', `${source.contract}.${source.member} вернул ${value === undefined ? 'ничего' : JSON.stringify(value)}, ожидается boolean`);
      into[field] = value;
      fail(m.id, item.id, field, undefined);
    } catch (error) {
      into[field] = false;
      // Владельца нет сейчас - это состояние, а не ошибка: пункт недоступен, пока он не вернётся.
      if (error instanceof CoreError && error.code === 'Unavailable') fail(m.id, item.id, field, undefined);
      else fail(m.id, item.id, field, errorMessage(error));
    }
  }

  async function evaluate(): Promise<void> {
    if (ctx.unloading) return;
    const next = new Map<string, Evaluated>();
    const work: Promise<void>[] = [];
    for (const m of ctx.known) {
      if (!ctx.active.includes(m.id)) continue;
      for (const item of m.contributes?.menus ?? []) {
        const got: Evaluated = {};
        next.set(menuItemKey(m.id, item.id), got);
        if (item.enabled) work.push(read(m, item, 'enabled', item.enabled, got));
        if (item.checked) work.push(read(m, item, 'checked', item.checked, got));
      }
    }
    await Promise.all(work);
    states = next;
  }

  function announce(): void {
    if (!started) return;
    const text = JSON.stringify(snapshot());
    if (text === announced) return;
    announced = text;
    ctx.options.onMenus?.();
  }

  function refresh(): Promise<void> {
    if (current) {
      again = true;
      return current;
    }
    current = (async () => {
      try {
        do {
          again = false;
          await evaluate();
          announce();
        } while (asked());
      } finally {
        current = undefined;
      }
    })();
    return current;
  }

  /** Источник пункта отдаёт `pluginId`: сам пункт этого плагина или контракт, который ему привязан графом. */
  const reads = (pluginId: string, m: PluginManifest, source: StateSource | undefined): boolean => {
    if (source === undefined) return false;
    return m.id === pluginId || (own(m.provides, source.contract) === undefined && ctx.graph.bindings.get(m.id)?.get(source.contract) === pluginId);
  };

  return {
    snapshot,
    refresh,
    async start() {
      await refresh();
      announced = JSON.stringify(snapshot());
      started = true;
    },
    touch(pluginId) {
      if (ctx.unloading) return;
      if (ctx.known.some((m) => (m.contributes?.menus ?? []).some((item) => reads(pluginId, m, item.enabled) || reads(pluginId, m, item.checked)))) void refresh();
    },
    onJournal(kind) {
      if (STATE_KINDS.has(kind) && !ctx.unloading) void refresh();
    },
    async run(pluginId, id) {
      const entry = snapshot().find((e) => e.pluginId === pluginId && e.id === id);
      if (!entry) throw new CoreError('NotFound', `пункта ${menuItemKey(pluginId, id)} нет`);
      if (!entry.enabled) throw new CoreError('Unavailable', `пункт ${menuItemKey(pluginId, id)} недоступен${entry.mark ? ` (${entry.mark})` : ''}`);
      return ctx.parts.commands.runOwn(pluginId, entry.command, []);
    },
  };
}
