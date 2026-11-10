import type { Disposable, GitStatus, PluginContext, PluginModule, Subscription, TreeMark } from '@cyborg-harness/contracts';
import { marksOf, parseStatus } from './status.ts';

// Пилот PL-04: владелец git по SAD (раздел 4, правило 11). Единственный плагин с правом process на git; дереву и просмотру отдаёт состояние и отметки.
// Правка файлов рабочего дерева сюда не доходит - её видит тот, кто следит за деревом, и просит состояние заново; здесь следят только за .git (индекс, голова).

/** Аргументы закреплены правилом process в манифесте: `fsmonitor=false` - команда из .git/config чужого репозитория при `status` не запускается; `--no-optional-locks` - status не пишет в индекс и не мешает человеку. */
const STATUS_ARGS = ['--no-optional-locks', '-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '-z', '--branch'];
/** Имена в .git, по которым меняется то, что показывает дерево: индекс (add, commit, checkout), голова и упакованные ссылки. Ссылки в refs/ каталогом глубже не видны: fetch отметок не меняет. */
const WATCHED = new Set(['index', 'HEAD', 'packed-refs', 'MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD']);
/** Склейка россыпи событий .git при checkout в одно оповещение. */
const NOTIFY_MS = 100;
/** Репозиториев под слежением: каждый занимает слежение из 64 на плагин. */
const MAX_REPOS = 16;
const NOT_A_REPOSITORY = /not a git repository/i;

interface Tracked {
  readonly listeners: Set<() => void>;
  watch?: Disposable | undefined;
  timer?: NodeJS.Timeout;
}

const git: PluginModule = {
  activate(ctx: PluginContext) {
    const proc = ctx.os.process;
    if (!proc) throw new Error('нет ctx.os.process: в манифесте git нет права process');
    const runGit = (repo: string) => proc.run('git', STATUS_ARGS, { cwd: repo, timeoutMs: 30_000 });
    const { fs } = ctx.os;
    const tracked = new Map<string, Tracked>();

    // Один git status на репозиторий одновременно: вызовы, пришедшие во время работы, получают один следующий прогон - он начат после их запроса и не отстаёт от изменений.
    const flights = new Map<string, { running: Promise<GitStatus | null>; next?: Promise<GitStatus | null> }>();
    async function spawn(repo: string): Promise<GitStatus | null> {
      const result = await runGit(repo);
      if (result.code !== 0) {
        if (NOT_A_REPOSITORY.test(result.stderr)) return null;
        throw new Error(`git status: код ${String(result.code ?? result.signal)}: ${result.stderr.trim().slice(0, 200)}`);
      }
      if (result.truncated) throw new Error('git status: вывод длиннее предела, изменений слишком много');
      return parseStatus(result.stdout);
    }
    function status(repo: string): Promise<GitStatus | null> {
      const flight = flights.get(repo);
      if (flight === undefined) {
        const running = spawn(repo).finally(() => settle(repo));
        flights.set(repo, { running });
        return running;
      }
      flight.next ??= flight.running.then(
        () => start(repo),
        () => start(repo),
      );
      return flight.next;
    }
    function start(repo: string): Promise<GitStatus | null> {
      const running = spawn(repo).finally(() => settle(repo));
      flights.set(repo, { running });
      return running;
    }
    function settle(repo: string): void {
      const flight = flights.get(repo);
      if (flight?.next === undefined) flights.delete(repo);
    }

    function notify(repo: string): void {
      const t = tracked.get(repo);
      if (t === undefined) return;
      clearTimeout(t.timer);
      t.timer = setTimeout(() => {
        for (const listener of t.listeners) listener();
      }, NOTIFY_MS);
    }

    /** `.git` - каталог: следим за ним; файл (`git worktree`, подмодуль) указывает в другое место, и события о нём не придут - оповещений нет, status по-прежнему отвечает. */
    async function attach(repo: string, t: Tracked): Promise<void> {
      const dotGit = `${repo}/.git`;
      const st = await fs.stat(dotGit).catch(() => undefined);
      if (st?.kind !== 'dir') return;
      t.watch = await fs.watch(
        dotGit,
        (names) => {
          if (names.some((n) => WATCHED.has(n))) notify(repo);
        },
        (reason) => {
          ctx.log(`слежение за .git закрыто: ${reason}`, 'warn');
          t.watch = undefined;
          notify(repo);
        },
      );
    }

    async function follow(repo: string, listener: () => void): Promise<Subscription> {
      let t = tracked.get(repo);
      if (t === undefined) {
        if (tracked.size >= MAX_REPOS) throw new Error(`слежение больше чем за ${String(MAX_REPOS)} репозиториями не открывается`);
        t = { listeners: new Set() };
        tracked.set(repo, t);
        await attach(repo, t).catch((error: unknown) => {
          tracked.delete(repo);
          throw error;
        });
      }
      t.listeners.add(listener);
      const own = t;
      return {
        dispose() {
          own.listeners.delete(listener);
          if (own.listeners.size > 0 || tracked.get(repo) !== own) return;
          clearTimeout(own.timer);
          own.watch?.dispose();
          tracked.delete(repo);
        },
      };
    }

    // onChange обязан вернуть Subscription сразу (контракт синхронный по форме), а слежение заводится асинхронно: dispose до готовности снимает его по готовности.
    function subscribe(repo: string, listener: () => void): Subscription {
      const pending = follow(repo, listener);
      pending.catch((error: unknown) => ctx.log(`onChange ${repo}: ${error instanceof Error ? error.message : String(error)}`, 'warn'));
      return { dispose: () => void pending.then((s) => s.dispose(), () => undefined) };
    }

    ctx.contracts.provide('cyborg.git', '1.0', {
      status: (repo) => status(repo),
      onChange: (repo, listener) => subscribe(repo, listener),
    });

    // Оповещение дерева идёт о тех корнях, о которых оно уже спрашивало отметки: слежение за .git встаёт при первом marks(root) и живёт до выгрузки плагина.
    const decoration = new Set<(root: string) => void>();
    const followed = new Map<string, Promise<unknown>>();
    function followForDecoration(root: string): Promise<unknown> {
      let pending = followed.get(root);
      if (pending === undefined) {
        pending = follow(root, () => {
          for (const listener of decoration) listener(root);
        }).catch((error: unknown) => ctx.log(`слежение за ${root}: ${error instanceof Error ? error.message : String(error)}`, 'warn'));
        followed.set(root, pending);
      }
      return pending;
    }
    ctx.contracts.provide('cyborg.tree-decoration', '1.0', {
      async marks(root): Promise<TreeMark[]> {
        await followForDecoration(root);
        const s = await status(root);
        return s === null ? [] : marksOf(s);
      },
      onChange(listener) {
        decoration.add(listener);
        return { dispose: () => void decoration.delete(listener) };
      },
    });

    ctx.subscriptions.add({
      dispose() {
        for (const t of tracked.values()) {
          clearTimeout(t.timer);
          t.watch?.dispose();
        }
        tracked.clear();
      },
    });
    return undefined;
  },
};

export default git;
