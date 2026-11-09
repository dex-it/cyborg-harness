import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TRUSTED_LAYER } from './config.ts';
import { CoreError } from './errors.ts';
import { resolveGraph } from './graph.ts';
import { DocumentTable } from './documents.ts';
import { assignHosts } from './host-pool.ts';
import { assignUiGroups } from './ui-groups.ts';
import { appendBounded, DeniedCollapse, DeprecatedCollapse, PTY_HOST_ID } from './journal.ts';
import type { KernelContext, Parts } from './kernel-context.ts';
import type { JournalEntry, LoadOptions } from './kernel-types.ts';
import { applyUserKeys, bindKeys } from './keybindings.ts';
import { limitsOf } from './limits.ts';
import { parseManifest, type PluginManifest } from './manifest.ts';
import { Notices } from './notices.ts';
import { OsGateway, type OsEnvironment } from './os-gateway.ts';
import { ContractRegistry } from './registry.ts';
import { isRecord } from './wire.ts';
import { WindowLayer } from './window-layer.ts';

// Id разделов ядра: плагин не может так называться, `$` манифест не пропустит.
const DOCUMENTS_STATE = '$documents';
const GRANTED_STATE = '$granted';

/** Свой каталог на запуск: общий /tmp/cyborg-plugins другой пользователь мог бы подменить ссылкой. */
function defaultOs(): OsEnvironment {
  const root = mkdtempSync(path.join(tmpdir(), 'cyborg-plugins-'));
  return { dataDir: path.join(root, 'data'), tempDir: path.join(root, 'temp') };
}

/**
 * Общее состояние ядра: журнал, разобранные манифесты, граф, раскладка по хостам, сочетания, шлюз ОС и слой окна.
 * Порядок записей в журнал (разбор манифестов, отказы графа, раскладка по хостам, сочетания) здесь и есть порядок запуска;
 * `build` создаёт части, когда всё это готово, но ни одна часть при создании ничего не вызывает.
 */
export async function createContext(options: LoadOptions, build: (ctx: KernelContext) => Parts): Promise<KernelContext> {
  const journal: JournalEntry[] = [];
  const write = (entry: JournalEntry) => {
    appendBounded(journal, entry, (e) => e);
    options.onJournal?.(entry);
  };
  // Плагин в цикле отказов иначе раздул бы журнал ядра и снимок окна без предела.
  const denials = new DeniedCollapse(write);
  const deprecations = new DeprecatedCollapse(write);
  const record = (entry: JournalEntry) => {
    if (entry.kind === 'denied') denials.record(entry);
    else if (entry.kind === 'deprecated-call') deprecations.record(entry);
    else write(entry);
  };
  const flushRepeats = () => {
    denials.flush();
    deprecations.flush();
  };
  const enabled = new Set(options.enabled);
  const watchdog = { interval: 1000, timeout: 5000, strikes: 3, window: 10 * 60_000, ...options.watchdog };
  const layer = new WindowLayer((snapshot) => options.onWindow?.(snapshot), options.windowTitle);
  const limits = limitsOf(options.os?.limits, options.limits);
  const osEnv: OsEnvironment = { ...(options.os ?? defaultOs()), limits };
  const notices = new Notices(
    () => {
      const show = osEnv.notify;
      // Под замком с hideNotifications текст уведомления виден на заблокированном экране ОС - уходит без него.
      return show && ((title, body, events) => (layer.hideNotifications ? show('Cyborg', 'новое событие', events) : show(title, body, events)));
    },
    (pluginId, click) => ctx.parts.osRequests.clickNotice(pluginId, click),
    osEnv.notifyLimits,
  );
  const manifests: PluginManifest[] = [];
  const known: PluginManifest[] = [];
  const gateway = new OsGateway(
    osEnv,
    (d) => record({ pluginId: d.pluginId, kind: 'denied', method: d.method, detail: d.detail, ...(d.reason && { reason: d.reason }) }),
    (id) => {
      // Права расширяет только слой пользователя (ADR-CH-0015): файл воркспейса приходит из репозитория команды.
      const layers = options.config?.raw(id) ?? [];
      const merged = (trusted: boolean) => Object.assign({}, ...layers.filter(([layer]) => (layer === TRUSTED_LAYER) === trusted).map(([, data]) => (isRecord(data) ? data : {}))) as Record<string, unknown>;
      return { trusted: merged(true), untrusted: merged(false) };
    },
    (id, method, params) => {
      const host = ctx.parts.pool.hosts.get(ctx.hostOf(id) ?? id);
      if (host && !host.down) host.endpoint.notify(method, params);
    },
    (id) => known.find((k) => k.id === id),
    options.state && {
      read: () => {
        const raw = options.state?.raw(GRANTED_STATE).find(([layer]) => layer === 'workspace')?.[1];
        return isRecord(raw) ? raw.byPlugin : undefined;
      },
      write: async (byPlugin) => options.state?.write('workspace', GRANTED_STATE, 1, { byPlugin }),
    },
    async (id, params) => {
      const host = ctx.parts.pool.hosts.get(ctx.hostOf(id) ?? id);
      if (!host || host.down) throw new CoreError('Unavailable', `${id}: хост не работает`);
      return host.endpoint.request('serve.request', params);
    },
    {
      expired: (e) => record({ kind: 'pty-expired', ...e }),
      kept: () => options.onKeptPty?.(),
      watchdog: options.watchdog,
      // pty-хост - хост ядра, а не плагинов: в журнале он называется как хост, но снятых плагинов у него нет (`plugins` пуст), владельцы потерянных pty - в `lostPtys`.
      hostDown: ({ reason, plugins }) => record({ kind: 'host-down', hostId: PTY_HOST_ID, reason, culprits: [], plugins: [], affects: [], lostPtys: plugins }),
      hostRestarted: () => record({ kind: 'host-restart', hostId: PTY_HOST_ID, plugins: [] }),
      hostAbandoned: (failures) => record({ kind: 'host-abandoned', hostId: PTY_HOST_ID, failures, plugins: [] }),
    },
  );

  for (const raw of options.manifests) {
    const parsed = parseManifest(raw, options.apiVersion);
    const id = parsed.ok ? parsed.manifest.id : parsed.id;
    if (parsed.ok) known.push(parsed.manifest);
    if (id !== undefined && !enabled.has(id)) record({ pluginId: id, kind: 'disabled' });
    else if (!parsed.ok) record({ pluginId: id ?? '?', kind: 'invalid', errors: parsed.errors });
    else manifests.push(parsed.manifest);
  }
  for (const id of enabled) {
    if (!manifests.some((m) => m.id === id) && !journal.some((e) => e.pluginId === id)) record({ pluginId: id, kind: 'not-found' });
  }
  // После разбора манифестов: строка, тип которой владелец убрал, отсеивается при чтении.
  const documents = new DocumentTable(
    options.state && {
      read: () => {
        const raw = options.state?.raw(DOCUMENTS_STATE).find(([layer]) => layer === 'workspace')?.[1];
        return isRecord(raw) ? raw.list : undefined;
      },
      write: async (list) => options.state?.write('workspace', DOCUMENTS_STATE, 1, { list }),
    },
    (pluginId, type) => {
      const m = known.find((k) => k.id === pluginId);
      if (!m) return undefined;
      return m.documents && Object.hasOwn(m.documents, type) ? (m.documents[type]?.restorable ?? null) : null;
    },
    () => options.onDocuments?.(),
  );

  const reserved = options.bundled ? { prefixes: options.reservedPrefixes ?? [], bundled: new Set(options.bundled) } : undefined;
  const graph = resolveGraph(manifests, options.apiVersion, reserved);
  for (const [pluginId, reasons] of graph.rejected) record({ pluginId, kind: 'rejected', reasons });
  await options.onGraph?.(graph);

  const byId = new Map(manifests.map((m) => [m.id, m]));
  const wire = { manifests, bindings: [...graph.bindings].map(([id, b]) => [id, [...b]] as const) };
  const registry = new ContractRegistry(manifests, graph.bindings);
  const manifestOf = (pluginId: string): PluginManifest => {
    const m = byId.get(pluginId);
    if (!m) throw new CoreError('Unavailable', `плагина ${pluginId} нет`);
    return m;
  };
  const hostIds = assignHosts(manifests, options.hosts ?? {}, new Set(options.bundled ?? []), record);
  const groupIds = assignUiGroups(manifests, options.uiGroups ?? {}, options.userUiGroups ?? {}, new Set(options.bundled ?? []), record);
  const accepted = graph.order.map(manifestOf);
  // Без `bundled` поставку не от чего отличить: записи нет, как нет и проверки зарезервированных пространств.
  if (options.bundled) for (const pluginId of graph.order) if (!options.bundled.includes(pluginId)) record({ pluginId, kind: 'third-party' });
  const platform = options.platform ?? process.platform;
  const keys = bindKeys(accepted, new Set(options.bundled ?? []), platform, record, options.menuKeys);
  applyUserKeys(keys, options.keybindings ?? [], accepted, platform, record);

  const built: { parts?: Parts } = {};
  const ctx: KernelContext = {
    options,
    journal,
    record,
    flushRepeats,
    enabled,
    watchdog,
    activationTimeout: options.activationTimeout ?? 10_000,
    callTimeout: options.callTimeout ?? 10 * 60_000,
    limits,
    osEnv,
    layer,
    notices,
    gateway,
    documents,
    manifests,
    known,
    byId,
    graph,
    registry,
    wire,
    manifestOf,
    hostOf: (pluginId) => hostIds.get(pluginId),
    groupOf: (pluginId) => groupIds.get(pluginId),
    keys,
    active: [],
    unloading: false,
    get parts() {
      if (!built.parts) throw new Error('части ядра ещё не созданы');
      return built.parts;
    },
  };
  built.parts = build(ctx);
  return ctx;
}
