import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TRUSTED_LAYER } from './config.ts';
import { CoreError, errorMessage } from './errors.ts';
import { resolveGraph } from './graph.ts';
import { DocumentTable } from './documents.ts';
import { assignHosts } from './host-pool.ts';
import { assignUiGroups } from './ui-groups.ts';
import { appendBounded, DeniedCollapse, DeprecatedCollapse, PTY_HOST_ID } from './journal.ts';
import type { KernelContext, Parts } from './kernel-context.ts';
import type { JournalEntry, LoadOptions } from './kernel-types.ts';
import { applyUserKeys, bindKeys } from './keybindings.ts';
import { limitsOf } from './limits.ts';
import { menuAccelerators } from './menus.ts';
import { parseManifest, type PluginManifest } from './manifest.ts';
import { Notices } from './notices.ts';
import { OsGateway, type OsEnvironment } from './os-gateway.ts';
import { Trace } from './trace.ts';
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
 * Значения секретов для записи трассы с аргументами (K-33): плагины, чьи значения могли попасть в аргументы, - вызывающий и адресат.
 * Участник `plugin:<id>` и `view:<id>` - этот плагин, `host:<id>` - хост, чей плагин не определён, и тогда все плагины хоста (как строка хоста в K-29); человек (`user`) и мост секретов не имеют.
 * Чужие секреты не вычёркиваются: плагин, записавший в хранилище короткое слово, портил бы чужую диагностику.
 */
function traceSecrets(ctx: KernelContext, caller: string, callee: string | undefined): string[] {
  const ids = new Set<string>();
  for (const who of [caller, callee]) {
    const match = /^(plugin|view|host):(.+)$/.exec(who ?? '');
    if (match?.[1] === undefined || match[2] === undefined) continue;
    if (match[1] === 'host') for (const id of ctx.byId.keys()) if (ctx.hostOf(id) === match[2]) ids.add(id);
    if (match[1] !== 'host') ids.add(match[2]);
  }
  return ctx.gateway.secretValues(ids);
}

/** Сообщения шлюза плагину: вывод pty и события `fs.watch` считаются счётчиком за интервал (FR-CH-4005), выход pty пишется записью (FR-CH-4007). */
function traceStream(trace: Trace, pluginId: string, method: string, params: unknown): void {
  if (!trace.enabled || !isRecord(params)) return;
  if (method === 'pty.data' && typeof params.data === 'string') trace.count('pty-output', pluginId, Buffer.byteLength(params.data));
  else if (method === 'fs.change' && Array.isArray(params.names) && params.names.length > 0) {
    trace.count('fs-watch', pluginId, params.names.reduce((n: number, name: unknown) => n + (typeof name === 'string' ? Buffer.byteLength(name) : 0), 0));
  } else if (method === 'pty.exit' && isRecord(params.exit) && typeof params.exit.code === 'number') {
    trace.ptyExit(pluginId, { code: params.exit.code, ...(typeof params.exit.signal === 'number' && { signal: params.exit.signal }) });
  }
}

/**
 * Общее состояние ядра: журнал, разобранные манифесты, граф, раскладка по хостам, сочетания, шлюз ОС и слой окна.
 * Порядок записей в журнал (разбор манифестов, отказы графа, раскладка по хостам, сочетания) здесь и есть порядок запуска;
 * `build` создаёт части, когда всё это готово, но ни одна часть при создании ничего не вызывает.
 */
export async function createContext(options: LoadOptions, build: (ctx: KernelContext) => Parts): Promise<KernelContext> {
  const journal: JournalEntry[] = [];
  const built: { parts?: Parts } = {};
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
    // Журнал пишется и до создания частей (разбор манифестов): тогда меню читать нечем и нечего.
    built.parts?.menus.onJournal(entry.kind);
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
  const trace = new Trace(options.onTrace, {
    streamMs: limits.traceStreamMs,
    hostOf: (pluginId) => ctx.hostOf(pluginId),
    // Через PluginLog, как все строки ядра: текст исключения приёмника идёт под пределами длины и частоты.
    failed: (error) => ctx.parts.logs.hostLine('трасса', `onTrace бросил, записи трассы могут теряться: ${errorMessage(error)}`, 'error'),
    // Аргументы пишутся только по флагу запуска и только если есть кому записи читать (K-33).
    ...(options.traceArgs === true && options.onTrace !== undefined && { args: { limit: limits.traceArgsBytes, secrets: (caller: string, callee: string | undefined) => traceSecrets(ctx, caller, callee) } }),
  });
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
      traceStream(trace, id, method, params);
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
  const groupIds = assignUiGroups(manifests, options.uiGroups ?? {}, new Set(options.bundled ?? []), record);
  const accepted = graph.order.map(manifestOf);
  // Без `bundled` поставку не от чего отличить: записи нет, как нет и проверки зарезервированных пространств.
  if (options.bundled) for (const pluginId of graph.order) if (!options.bundled.includes(pluginId)) record({ pluginId, kind: 'third-party' });
  const platform = options.platform ?? process.platform;
  // Акселераторы пунктов плагинов стоят в таблице после акселераторов приложения и окна: при споре выигрывают они, затем пункт с меньшим именем.
  const keys = bindKeys(accepted, new Set(options.bundled ?? []), platform, record, { ...options.menuKeys, ...menuAccelerators(accepted) });
  applyUserKeys(keys, options.keybindings ?? [], accepted, platform, record);

  const ctx: KernelContext = {
    options,
    journal,
    record,
    trace,
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
