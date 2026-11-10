import { CoreError } from './errors.ts';
import { buildLayout } from './layout.ts';
import { pluginMark } from './plugin-mark.ts';
import type { KernelContext } from './kernel-context.ts';
import type { Kernel } from './kernel-types.ts';
import type { OpHandle } from './trace.ts';

// Адрес задаёт вид: data:-адрес на мегабайты раздул бы журнал и снимок окна.
const MAX_DENIED_URL = 200;

/** Публичный `Kernel`: тонкий слой над частями, без своего состояния. */
export function buildKernel(ctx: KernelContext): Kernel {
  const { parts, keys, active, layer, documents, gateway, known } = ctx;
  const { pool, lifecycle, activation, contracts, commands, keyRegistry, sections, views, viewChannels, menus } = parts;
  /** Вызов моста вида (Г2): операция трассы от имени вида плагина `pluginId`; `target` - что вид просит (`bridge:view.state`, `contract:...`). */
  const bridge = <T>(pluginId: string, target: string, args: unknown, fn: (op: OpHandle) => T): T =>
    ctx.trace.run({ caller: `view:${pluginId}`, target, boundaries: ['bridge'] }, (op) => {
      op.args(args);
      return fn(op);
    });

  return {
    journal: ctx.journal,
    active,
    get working() {
      return lifecycle.working();
    },
    contracts: ctx.registry,
    callAs: (caller, contract, major, member, args) => bridge(caller, `contract:${contract}@${String(major)}#${member}`, args, (op) => contracts.callAs(caller, contract, major, member, args, op)),
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
    groupOf: ctx.groupOf,
    get keybindings() {
      return keyRegistry.rows();
    },
    keybinding: (key, press) => keyRegistry.lookup(key, press),
    setViewVisible: (pluginId, visible, view) => keyRegistry.setVisible(pluginId, visible, view),
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
    showDialog: (pluginId, view, spec) =>
      bridge(pluginId, 'bridge:view.dialog', spec, () => {
        views.viewKey(pluginId, view);
        if (ctx.unloading) throw new CoreError('Unavailable', 'ядро выгружается');
        return layer.show(pluginId, view, spec);
      }),
    answerDialog: (id, choice) => layer.answer(id, choice),
    modalFor: (pluginId, view) => bridge(pluginId, 'bridge:view.modal', view, () => layer.modalData(pluginId, view)),
    closeModal: (pluginId, view, result) => bridge(pluginId, 'bridge:view.modal.close', result, () => viewChannels.closeModal(pluginId, view, result)),
    cancelModal: (id) => layer.cancelModal(id),
    dismissModal: () => layer.dismissModal(),
    viewDenied(pluginId, url) {
      if (!known.some((m) => m.id === pluginId)) return;
      const shown = url.length > MAX_DENIED_URL ? `${url.slice(0, MAX_DENIED_URL)}…` : url;
      ctx.record({ pluginId, kind: 'denied', method: 'navigate', detail: `переход на ${shown}`, reason: 'window' });
    },
    viewCspDenied(pluginId, detail) {
      if (!known.some((m) => m.id === pluginId)) return;
      const shown = detail.length > MAX_DENIED_URL ? `${detail.slice(0, MAX_DENIED_URL)}…` : detail;
      ctx.record({ pluginId, kind: 'denied', method: 'csp', detail: shown, reason: 'csp' });
    },
    keysOf: (pluginId) => Object.fromEntries([...keys.values()].filter((k) => k.pluginId === pluginId).map((k) => [k.command, k.key])),
    wake: (pluginId) => activation.wake(pluginId),
    openTerminal: (pluginId, ticket, channel) => bridge(pluginId, 'bridge:view.terminal', ticket, () => gateway.openTerminal(pluginId, ticket, channel)),
    keptPty: () => gateway.keptPty(),
    endKeptPty: (id) => gateway.endKeptPty(id),
    viewState: (pluginId, view) => bridge(pluginId, 'bridge:view.state', view, () => views.viewState(pluginId, view)),
    setViewState: (pluginId, view, value) => bridge(pluginId, 'bridge:view.state.set', value, () => views.setViewState(pluginId, view, value)),
    viewPost: (pluginId, view, message) => bridge(pluginId, 'bridge:view.post', message, () => viewChannels.fromView(pluginId, view, message)),
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
