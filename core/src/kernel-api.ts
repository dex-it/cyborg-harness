import { CoreError } from './errors.ts';
import { buildLayout, pluginMark } from './layout.ts';
import type { KernelContext } from './kernel-context.ts';
import type { Kernel } from './kernel-types.ts';

// Адрес задаёт вид: data:-адрес на мегабайты раздул бы журнал и снимок окна.
const MAX_DENIED_URL = 200;

/** Публичный `Kernel`: тонкий слой над частями, без своего состояния. */
export function buildKernel(ctx: KernelContext): Kernel {
  const { parts, keys, active, layer, documents, gateway, known } = ctx;
  const { pool, lifecycle, activation, contracts, commands, keyRegistry, sections, views, menus } = parts;

  return {
    journal: ctx.journal,
    active,
    contracts: ctx.registry,
    callAs: (caller, contract, major, member, args) => contracts.callAs(caller, contract, major, member, args),
    manifests: known,
    get layout() {
      return buildLayout(known, (id) => pluginMark(ctx, id));
    },
    get menus() {
      return menus.snapshot();
    },
    refreshMenus: () => menus.refresh(),
    runMenuItem: (pluginId, id) => menus.run(pluginId, id),
    hostOf: ctx.hostOf,
    get keybindings() {
      return keyRegistry.rows();
    },
    keybinding: (key, press) => keyRegistry.lookup(key, press),
    setViewVisible: (pluginId, visible) => keyRegistry.setVisible(pluginId, visible),
    get window() {
      return layer.snapshot;
    },
    get documents() {
      return documents.rows((id) => active.includes(id) || activation.waiting.has(id));
    },
    async closeDocument(id) {
      const doc = await documents.closeAny(id);
      const host = active.includes(doc.pluginId) ? pool.hosts.get(ctx.hostOf(doc.pluginId) ?? doc.pluginId) : undefined;
      if (host && !host.down) host.endpoint.notify('document.closed', { pluginId: doc.pluginId, id });
    },
    showDialog(pluginId, view, spec) {
      views.viewKey(pluginId, view);
      if (ctx.unloading) throw new CoreError('Unavailable', 'ядро выгружается');
      return layer.show(pluginId, view, spec);
    },
    answerDialog: (id, choice) => layer.answer(id, choice),
    viewDenied(pluginId, url) {
      if (!known.some((m) => m.id === pluginId)) return;
      const shown = url.length > MAX_DENIED_URL ? `${url.slice(0, MAX_DENIED_URL)}…` : url;
      ctx.record({ pluginId, kind: 'denied', method: 'navigate', detail: `переход на ${shown}`, reason: 'window' });
    },
    keysOf: (pluginId) => Object.fromEntries([...keys.values()].filter((k) => k.pluginId === pluginId).map((k) => [k.command, k.key])),
    wake: (pluginId) => activation.wake(pluginId),
    openTerminal: (pluginId, ticket, channel) => gateway.openTerminal(pluginId, ticket, channel),
    keptPty: () => gateway.keptPty(),
    endKeptPty: (id) => gateway.endKeptPty(id),
    viewState: (pluginId, view) => views.viewState(pluginId, view),
    setViewState: (pluginId, view, value) => views.setViewState(pluginId, view, value),
    emit: (event) => pool.emit(event),
    beforeQuit: (budget = 3000) => pool.beforeQuit(budget),
    disable: (pluginId, options) => lifecycle.disable(pluginId, options),
    setEnabled: (next) => lifecycle.setEnabled(next),
    disablePreview: (pluginId) => lifecycle.disablePreview(pluginId),
    uninstall: (pluginId) => lifecycle.uninstall(pluginId),
    enable: (pluginId) => lifecycle.enable(pluginId),
    run: (command, ...args) => commands.run(command, ...args),
    runOwn: (pluginId, command, ...args) => commands.runOwn(pluginId, command, args),
    idle: () => lifecycle.idle(),
    reloadSections: (kind, ids) => sections.reload(kind, ids),
    unload: () => lifecycle.shutdown(),
  };
}
