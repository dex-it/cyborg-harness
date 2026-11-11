import type { PluginModule } from '@cyborg-harness/contracts';
import { Pool } from './pool.ts';
import { LOGIN_FAILED, TOOLS, type Item, type TrackerId } from './tools.ts';

// Пилот PL-07: срез трекеров Cyborg - список MR/PR или задач через `ctx.os.process.run` для `gh api`, `glab api` и `jira`. Окна нет, в DEFAULT_CONFIG плагин не включён.
// Что берёт от ядра: права `process` с закреплёнными аргументами (манифест), тайм-аут, предел вывода и признак обрезки, убийство группы процессов, отмена сигналом (K-09).
// Что держит сам: пул с конкуренцией POOL_SIZE (очередь принадлежит плагину), отмену по идентификатору (вид сигнала не передаёт: AbortSignal не переживает structuredClone)
// и «последний выигрывает»: новый запрос к тому же списку отменяет прежний, устаревший ответ не доходит.

/** Конкуренция Cyborg (`trackers.ts`): число из требований, ядро её не навязывает. */
export const POOL_SIZE = 6;
/** Срок одного вызова программы: 120 с, как у Cyborg. */
export const TIMEOUT_MS = 120_000;
/** Буфер трекеров Cyborg (64 МиБ), он же потолок ядра: сверх него вывод обрезан и признак `truncated` превращается здесь в ошибку, а не в оборванный JSON. */
export const MAX_OUTPUT = 64 * 1024 * 1024;

export interface Listing {
  readonly tracker: TrackerId;
  readonly target: string;
  readonly items: readonly Item[];
  readonly tookMs: number;
}

interface Options {
  readonly requestId?: string;
  readonly timeoutMs?: number;
}

const isTracker = (value: unknown): value is TrackerId => typeof value === 'string' && Object.hasOwn(TOOLS, value);

function parseOptions(value: unknown): Options {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('trackers.list: третий аргумент - { requestId?, timeoutMs? }');
  const { requestId, timeoutMs } = value as Record<string, unknown>;
  if (requestId !== undefined && (typeof requestId !== 'string' || requestId === '')) throw new Error('trackers.list: requestId - непустая строка');
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > TIMEOUT_MS)) throw new Error(`trackers.list: timeoutMs - от 1 до ${String(TIMEOUT_MS)}`);
  return { ...(requestId !== undefined && { requestId }), ...(timeoutMs !== undefined && { timeoutMs }) };
}

const trackers: PluginModule = {
  async activate(ctx) {
    const proc = ctx.os.process;
    if (!proc) throw new Error('нет ctx.os.process: в манифесте trackers нет права process');
    // cwd программы - свой временный каталог, вне репозиториев (как у Cyborg). Ядро его не создаёт, а нет `cwd` - `NotFound`, неотличимый от «программы нет в PATH».
    await ctx.os.fs.mkdir(ctx.os.paths.temp);
    const pool = new Pool(POOL_SIZE);
    const counts = { requests: 0, finished: 0, failed: 0, cancelled: 0, superseded: 0 };
    /** Последний запрос на список (трекер и цель): новый отменяет прежний. */
    const latest = new Map<string, AbortController>();
    /** Запросы, которые вид может отменить по идентификатору. */
    const byId = new Map<string, AbortController>();

    const fetchList = async (tracker: TrackerId, target: string, timeoutMs: number, signal: AbortSignal): Promise<Listing> => {
      const tool = TOOLS[tracker];
      const args = tool.args(target);
      const t0 = Date.now();
      counts.requests++;
      let result;
      try {
        result = await proc.run(tool.program, args, { cwd: ctx.os.paths.temp, env: tool.env, timeoutMs, maxOutputBytes: MAX_OUTPUT, signal });
      } catch (error) {
        // Отмена (код Cancelled от ядра) не сбой; нет программы (NotFound) и отказ права (PermissionDenied) идут дальше как есть.
        if ((error as { code?: unknown }).code === 'Cancelled') counts.cancelled++;
        else counts.failed++;
        throw error;
      }
      // Ответ уже не нужен: сработала отмена, пока программа дописывала. С сработавшим сигналом process.run отказывает Cancelled, не запуская программу.
      if (signal.aborted) {
        counts.cancelled++;
        await proc.run(tool.program, args, { cwd: ctx.os.paths.temp, env: tool.env, signal });
        throw new Error('trackers: запрос отменён, ответ устарел');
      }
      counts.finished++;
      const fail = (message: string): never => {
        counts.failed++;
        throw new Error(`trackers: ${message}`);
      };
      if (result.truncated) return fail(`ответ ${tool.program} больше ${String(MAX_OUTPUT / 1024 / 1024)} МиБ, список не прочитан целиком`);
      if (result.signal !== null) return fail(`${tool.program} не ответил за ${String(timeoutMs)} мс и остановлен`);
      if (result.code !== 0) {
        const detail = result.stderr.trim().slice(0, 200);
        return fail(LOGIN_FAILED.test(result.stderr) ? `вход не выполнен (${tool.program}): ${detail}` : `${tool.program} завершился с кодом ${String(result.code)}: ${detail}`);
      }
      let json: unknown;
      try {
        json = JSON.parse(result.stdout);
      } catch {
        return fail(`ответ ${tool.program} - не JSON`);
      }
      try {
        return { tracker, target, items: tool.items(json), tookMs: Date.now() - t0 };
      } catch (error) {
        counts.failed++;
        throw error;
      }
    };

    ctx.commands.register('trackers.list', async (tracker: unknown, target: unknown, ...rest: unknown[]) => {
      if (!isTracker(tracker)) throw new Error(`trackers.list: трекер - github, gitlab или jira, получено ${JSON.stringify(tracker)}`);
      if (typeof target !== 'string') throw new Error('trackers.list: цель - строка');
      // Последним аргументом ядро кладёт сигнал отмены вызывающего (если он его передал); третий - необязательные параметры.
      const signal = rest.find((a): a is AbortSignal => a instanceof AbortSignal);
      const options = parseOptions(rest.find((a) => !(a instanceof AbortSignal)));
      const controller = new AbortController();
      const key = `${tracker}\n${target}`;
      if (options.requestId !== undefined && byId.has(options.requestId)) throw new Error(`trackers.list: requestId ${options.requestId} уже занят`);
      latest.get(key)?.abort();
      if (latest.has(key)) counts.superseded++;
      latest.set(key, controller);
      if (options.requestId !== undefined) byId.set(options.requestId, controller);
      if (signal?.aborted === true) controller.abort();
      else signal?.addEventListener('abort', () => controller.abort(), { once: true });
      try {
        return await pool.run(controller.signal, () => fetchList(tracker, target, options.timeoutMs ?? TIMEOUT_MS, controller.signal));
      } finally {
        if (latest.get(key) === controller) latest.delete(key);
        if (options.requestId !== undefined) byId.delete(options.requestId);
      }
    });
    ctx.commands.register('trackers.cancel', (requestId: unknown) => {
      const controller = typeof requestId === 'string' ? byId.get(requestId) : undefined;
      controller?.abort();
      return controller !== undefined;
    });
    ctx.commands.register('trackers.stats', () => ({ limit: pool.limit, running: pool.running, queued: pool.queued, peak: pool.peak, ...counts }));
  },
};

export default trackers;
