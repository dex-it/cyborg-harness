import type { NotifyClick } from '@cyborg-harness/contracts';
import { CoreError, errorMessage } from './errors.ts';
import type { BridgeEnd, KernelContext, OsRequests } from './kernel-context.ts';
import { checkArgs, type PluginManifest } from './manifest.ts';
import { parseNotice } from './notices.ts';
import { isRecord } from './wire.ts';

/** Право манифеста, по которому шлюз допускает вызов `ctx.os` (для записи трассы); у вызовов без права - undefined. */
const OS_RIGHTS: Readonly<Record<string, string>> = {
  'fs.readText': 'fs.read', 'fs.readSlice': 'fs.read', 'fs.list': 'fs.read', 'fs.stat': 'fs.read', 'fs.watch': 'fs.read', 'fs.unwatch': 'fs.read', 'fs.realpath': 'fs.read',
  'fs.writeText': 'fs.write', 'fs.mkdir': 'fs.write', 'fs.remove': 'fs.write',
  'process.run': 'process', 'net.fetch': 'net', 'serve.http': 'serve', 'serve.close': 'serve', 'env.get': 'env',
  'clipboard.readText': 'clipboard', 'clipboard.writeText': 'clipboard', 'secrets.resolve': 'secrets.ref',
  'shell.openPath': 'shell', 'shell.openExternal': 'shell', 'notify.show': 'notify', 'notify.close': 'notify',
  'ui.lock': 'ui.lock', 'ui.unlock': 'ui.lock', 'security.setRoots': 'security.roots',
};
const rightOf = (method: string): string | undefined => (method.startsWith('pty.') ? 'pty' : OS_RIGHTS[method]);

/** Запросы плагина к ядру из хоста: документы, `ctx.os` (в том числе уведомления и замок окна). */
export function createOsRequests(ctx: KernelContext): OsRequests {
  const { documents, gateway, layer, notices, osEnv } = ctx;

  async function notifyCall(m: PluginManifest, method: string, args: readonly unknown[]): Promise<string | undefined> {
    if (m.permissions.notify !== true) {
      ctx.record({ pluginId: m.id, kind: 'denied', method, detail: 'нет права notify' });
      throw new CoreError('PermissionDenied', `${m.id}: ${method} - нет права notify`);
    }
    if (method === 'notify.close') {
      notices.close(m.id, args[0]);
      return undefined;
    }
    const request = parseNotice(args, notices.limits);
    const click = request.onClick;
    if (click) {
      const spec = Object.hasOwn(m.commands, click.command) ? m.commands[click.command] : undefined;
      if (!spec) throw new CoreError('CommandNotFound', `${m.id}: notify.show - команда ${click.command} не объявлена в манифесте`);
      checkArgs(click.command, spec, click.args ?? []);
    }
    return notices.show(m.id, request);
  }

  function lockCall(m: PluginManifest, method: string, args: readonly unknown[]): undefined {
    if (m.permissions['ui.lock'] !== true) {
      ctx.record({ pluginId: m.id, kind: 'denied', method, detail: 'нет права ui.lock' });
      throw new CoreError('PermissionDenied', `${m.id}: ${method} - нет права ui.lock`);
    }
    if (method === 'ui.unlock') layer.release(m.id);
    else layer.lock(m.id, isRecord(args[0]) && args[0].hideNotifications === true);
    return undefined;
  }

  function attach({ live, onRequest }: BridgeEnd): void {
    onRequest('documents', { pluginId: 'string', method: ['list', 'open', 'save', 'close'], args: 'array' }, (p) => {
      const id = live(p.pluginId).id;
      if (p.method === 'list') return documents.list(id);
      if (p.method === 'open') return documents.open(id, p.args[0], p.args[1]);
      if (p.method === 'save') return documents.save(id, p.args[0], p.args[1]);
      return documents.close(id, p.args[0]);
    });
    onRequest('os', { pluginId: 'string', method: 'string', args: 'array' }, (p, signal, op) => {
      const m = live(p.pluginId);
      // Сеть - Г5, остальное шлюз - Г4; отказ права тоже конец операции на этой границе.
      op.enter(p.method === 'net.fetch' ? 'net' : 'os');
      op.target(`os:${p.method}`, undefined, rightOf(p.method));
      if (p.method === 'ui.lock' || p.method === 'ui.unlock') {
        lockCall(m, p.method, p.args);
        return undefined;
      }
      if (p.method === 'notify.show' || p.method === 'notify.close') return notifyCall(m, p.method, p.args);
      if (p.method === 'window.title') {
        layer.setTitle(m.id, p.args[0]);
        return undefined;
      }
      // Системный диалог встал бы поверх экрана замка.
      if (p.method === 'dialog.open' && !layer.allows(m.id)) throw new CoreError('Unavailable', `${m.id}: окно закрыто замком`);
      return gateway.call(m, p.method, p.args, signal);
    });
  }

  function clickNotice(pluginId: string, click: NotifyClick): void {
    const { commands, lifecycle, logs } = ctx.parts;
    osEnv.raiseWindow?.();
    // Под чужим замком окно поднимается, а команда не идёт: как и сочетание этого плагина.
    if (!layer.allows(pluginId)) return;
    const go = () => commands.runOwn(pluginId, click.command, [...(click.args ?? [])], 'user');
    // Хост перезапускается: команда появится, когда плагин снова поднимется.
    (commands.owners.has(click.command) ? go() : lifecycle.idle().then(go)).catch((error: unknown) => logs.pluginLine(pluginId, `клик по уведомлению: ${errorMessage(error)}`, 'warn'));
  }

  return { attach, clickNotice };
}
