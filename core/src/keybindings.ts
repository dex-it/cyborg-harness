import { CoreError } from './errors.ts';
import type { BridgeEnd, KernelContext, KeyRegistry } from './kernel-context.ts';
import type { JournalEntry, Keybinding, KeyPress, UserKeybinding } from './kernel-types.ts';
import { normalizeKey, resolveKey } from './keys.ts';
import { checkArgs, type PluginManifest } from './manifest.ts';
import { KERNEL_COMMANDS, KERNEL_OWNER, MENU_OWNER, WINDOW_COMMANDS, WINDOW_OWNER } from './window-layer.ts';
import { own } from './wire.ts';

// Окно и меню приложения идут в таблицу первыми. Затем встроенный побеждает сторонний, между равными - первый по id: исход не зависит от порядка каталогов на диске.
export function bindKeys(
  manifests: readonly PluginManifest[],
  bundled: ReadonlySet<string>,
  platform: string,
  record: (entry: JournalEntry) => void,
  menu: Readonly<Record<string, string>> = {},
): Map<string, Keybinding> {
  const rank = (m: PluginManifest) => [bundled.has(m.id) ? 0 : 1, m.id] as const;
  const sorted = [...manifests].sort((a, b) => rank(a)[0] - rank(b)[0] || rank(a)[1].localeCompare(rank(b)[1]));
  const table = new Map<string, Keybinding>();
  for (const [command, key] of Object.entries(WINDOW_COMMANDS)) table.set(key, { key, command, pluginId: WINDOW_OWNER, shadowed: [] });
  for (const [item, raw] of Object.entries(menu)) {
    const normalized = normalizeKey(raw);
    if (normalized === undefined) {
      record({ kind: 'key-ignored', key: raw, command: item, reason: 'сочетание меню не разобрано' });
      continue;
    }
    const key = resolveKey(normalized, platform);
    // Окно и меню делят одну таблицу: пункт меню на сочетание команды окна ничего не меняет.
    if (!table.has(key)) table.set(key, { key, command: item, pluginId: MENU_OWNER, shadowed: [] });
  }
  for (const m of sorted) {
    for (const k of m.keybindings) {
      const key = resolveKey(k.key, platform);
      const owner = table.get(key);
      if (!owner) {
        table.set(key, { key, command: k.command, pluginId: m.id, shadowed: [] });
        continue;
      }
      table.set(key, { ...owner, shadowed: [...owner.shadowed, { pluginId: m.id, command: k.command }] });
      record({ pluginId: m.id, kind: 'key-conflict', key, command: k.command, winner: owner.pluginId });
    }
  }
  return table;
}

/** Выбор пользователя сильнее манифестов: конфликт он уже разрешил, поэтому вытесненные - в shadowed без записи о конфликте. */
export function applyUserKeys(table: Map<string, Keybinding>, user: readonly UserKeybinding[], manifests: readonly PluginManifest[], platform: string, record: (entry: JournalEntry) => void): void {
  const ownerOf = new Map([...Object.keys(WINDOW_COMMANDS).map((c) => [c, WINDOW_OWNER] as const), ...Object.values(KERNEL_COMMANDS).map((c) => [c, KERNEL_OWNER] as const), ...manifests.flatMap((m) => Object.keys(m.commands).map((c) => [c, m.id] as const))]);
  for (const u of user) {
    const normalized = normalizeKey(u.key);
    if (normalized === undefined) {
      record({ kind: 'key-ignored', key: u.key, command: u.command, reason: 'сочетание не разобрано' });
      continue;
    }
    const key = resolveKey(normalized, platform);
    const was = table.get(key);
    const shadowed = was ? [...(was.user ? [] : [{ pluginId: was.pluginId, command: was.command }]), ...was.shadowed] : [];
    if (u.command === null) {
      table.delete(key);
      continue;
    }
    const pluginId = ownerOf.get(u.command);
    if (pluginId === undefined) {
      record({ kind: 'key-ignored', key: u.key, command: u.command, reason: 'команды нет ни у одного плагина' });
      continue;
    }
    table.set(key, { key, command: u.command, pluginId, user: true, shadowed: shadowed.filter((s) => s.command !== u.command) });
  }
}

const MAX_PER_PLUGIN = 128;
const MAX_ARGS_BYTES = 4096;
const WHEN_FLAGS = ['repeat', 'dialog', 'visible'] as const;

interface Resolved {
  readonly repeat: boolean;
  readonly dialog: boolean;
  readonly visible: boolean;
  readonly input: 'any' | 'not-text';
}

interface Dynamic {
  readonly id: number;
  readonly key: string;
  readonly command: string;
  readonly pluginId: string;
  readonly args: readonly unknown[];
  readonly when: Resolved;
  /** Проиграл: нажатие получает другой, а запись нужна, чтобы назвать проигравшего в `shadowed`. */
  readonly lost: boolean;
}

/** Условия от плагина - недоверенные данные: незнакомое поле или не тот вид значения - отказ, а не молчаливое умолчание. */
function readWhen(raw: unknown, m: PluginManifest): Resolved {
  const fail = (what: string): never => {
    throw new CoreError('Invalid', `${m.id}: when - ${what}`);
  };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail('ожидается объект');
  const fields = raw as Record<string, unknown>;
  for (const name of Object.keys(fields)) if (![...WHEN_FLAGS, 'input'].includes(name)) fail(`поле ${name} ядро не знает (repeat, dialog, input, visible)`);
  for (const name of WHEN_FLAGS) if (fields[name] !== undefined && typeof fields[name] !== 'boolean') fail(`${name} - boolean`);
  if (fields.input !== undefined && fields.input !== 'any' && fields.input !== 'not-text') fail('input - "any" или "not-text"');
  const visible = fields.visible === true;
  if (visible && (m.ui === undefined || Object.keys(m.ui.views).length === 0)) fail('visible у плагина без вида');
  return { repeat: fields.repeat === true, dialog: fields.dialog === true, visible, input: fields.input === 'any' ? 'any' : 'not-text' };
}

/**
 * Динамические сочетания `ctx.keys.register` рядом со статической таблицей (`ctx.keys`: окно, меню, манифесты, выбор человека).
 * Статическая старше: динамическое на занятое сочетание проигрывает, окно и меню занять нельзя вовсе.
 */
export function createKeyRegistry(ctx: KernelContext): KeyRegistry {
  const platform = ctx.options.platform ?? process.platform;
  const entries = new Map<number, Dynamic>();
  const winners = new Map<string, Dynamic>();
  const visible = new Set<string>();
  let seq = 0;

  const losersOf = (key: string): { pluginId: string; command: string }[] =>
    [...entries.values()].filter((e) => e.lost && e.key === key).map((e) => ({ pluginId: e.pluginId, command: e.command }));

  const withLosers = (fixed: Keybinding): Keybinding => {
    const extra = losersOf(fixed.key);
    return extra.length === 0 ? fixed : { ...fixed, shadowed: [...fixed.shadowed, ...extra] };
  };

  const dynamicRow = (d: Dynamic): Keybinding => ({ key: d.key, command: d.command, pluginId: d.pluginId, args: d.args, dynamic: true, shadowed: losersOf(d.key) });

  function remove(entry: Dynamic): void {
    entries.delete(entry.id);
    if (entry.lost) return;
    winners.delete(entry.key);
    for (const e of [...entries.values()]) if (e.lost && e.key === entry.key) entries.delete(e.id);
  }

  function register(m: PluginManifest, p: { key: string; command: string; args: unknown[]; when: Record<string, unknown> }): { id: number; active: boolean; winner?: string } {
    const normalized = normalizeKey(p.key);
    if (normalized === undefined) throw new CoreError('Invalid', `${m.id}: сочетание ${JSON.stringify(p.key)} не разобрано, ожидается вида "CmdOrCtrl+Shift+K" или "F5"`);
    const key = resolveKey(normalized, platform);
    const spec = own(m.commands, p.command);
    if (!spec) throw new CoreError('NotDeclared', `${m.id}: команда ${p.command} не объявлена в commands`);
    checkArgs(p.command, spec, p.args);
    if (Buffer.byteLength(JSON.stringify(p.args)) > MAX_ARGS_BYTES) throw new CoreError('Invalid', `${m.id}: аргументы команды больше ${String(MAX_ARGS_BYTES)} байт`);
    const when = readWhen(p.when, m);
    if ([...entries.values()].filter((e) => e.pluginId === m.id).length >= MAX_PER_PLUGIN) throw new CoreError('Invalid', `${m.id}: не больше ${String(MAX_PER_PLUGIN)} динамических сочетаний`);

    const fixed = ctx.keys.get(key);
    if (fixed?.pluginId === WINDOW_OWNER || fixed?.pluginId === MENU_OWNER) {
      throw new CoreError('CommandConflict', `${m.id}: сочетание ${key} занято ${fixed.pluginId === WINDOW_OWNER ? 'окном' : 'меню приложения'} (${fixed.command})`);
    }
    const winner = fixed?.pluginId ?? winners.get(key)?.pluginId;
    const entry: Dynamic = { id: ++seq, key, command: p.command, pluginId: m.id, args: structuredClone(p.args), when, lost: winner !== undefined };
    entries.set(entry.id, entry);
    if (winner === undefined) {
      winners.set(key, entry);
      return { id: entry.id, active: true };
    }
    ctx.record({ pluginId: m.id, kind: 'key-conflict', key, command: p.command, winner });
    return { id: entry.id, active: false, winner };
  }

  function attach({ mine, onRequest, onNote }: BridgeEnd): void {
    onRequest('keys.register', { pluginId: 'string', key: 'string', command: 'string', args: 'array', when: 'record' }, (p) => register(mine(p.pluginId), p));
    onNote('keys.unregister', { pluginId: 'string', id: 'number' }, (p) => {
      mine(p.pluginId);
      const entry = entries.get(p.id);
      if (entry?.pluginId === p.pluginId) remove(entry);
    });
  }

  function dropFor(pluginId: string): void {
    for (const e of [...entries.values()]) if (e.pluginId === pluginId && entries.has(e.id)) remove(e);
  }

  function lookup(key: string, press?: KeyPress): Keybinding | undefined {
    const { active, layer } = ctx;
    const { activation } = ctx.parts;
    const fixed = ctx.keys.get(key);
    if (fixed) {
      if (!layer.allows(fixed.pluginId)) return undefined;
      const kernelSide = fixed.pluginId === WINDOW_OWNER || fixed.pluginId === KERNEL_OWNER || fixed.pluginId === MENU_OWNER;
      const alive = kernelSide || active.includes(fixed.pluginId) || activation.waiting.has(fixed.pluginId) || activation.waking.has(fixed.pluginId);
      if (!alive || (press?.repeat === true && fixed.pluginId !== MENU_OWNER)) return undefined;
      return withLosers(fixed);
    }
    const d = winners.get(key);
    if (!d || !layer.allows(d.pluginId) || !active.includes(d.pluginId)) return undefined;
    if (press) {
      const { when } = d;
      if (press.repeat === true && !when.repeat) return undefined;
      if (layer.snapshot.dialog !== undefined && !when.dialog) return undefined;
      if (press.focus === 'text' && when.input === 'not-text') return undefined;
      if (when.visible && !visible.has(d.pluginId)) return undefined;
    }
    return dynamicRow(d);
  }

  return {
    attach,
    dropFor,
    lookup,
    rows: () => [...[...ctx.keys.values()].map(withLosers), ...[...winners.values()].map(dynamicRow)],
    setVisible(pluginId, value) {
      if (!ctx.byId.has(pluginId)) throw new CoreError('Unavailable', `плагина ${pluginId} нет`);
      if (value) visible.add(pluginId);
      else visible.delete(pluginId);
    },
  };
}
