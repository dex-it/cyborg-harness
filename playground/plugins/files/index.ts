import type { Disposable, PluginContext, PluginModule, TreeMarkKind } from '@cyborg-harness/contracts';

// Пилот PL-04: модель дерева файлов без окна. Дерево строится по ctx.os.fs.list, обновляется по именам из fs.watch (stat на каждое известное имя, list каталога - когда появилось незнакомое
// или имён слишком много) и не опрашивает ничего: без событий плагин не делает ни одного вызова. Отметки состояния даёт любой плагин контракта cyborg.tree-decoration (git и другие).
// Предел шлюза - 64 слежения на плагин, и слежение за каталогом не рекурсивное: следим за корнем и раскрытыми каталогами, при нехватке вытесняется давнее раскрытый
// (его узел помечается устаревшим и перечитывается при следующем раскрытии).

/** `MAX_WATCHES` шлюза (core/src/os-gateway.ts): считается здесь, чтобы не упираться в отказ шлюза. */
const MAX_WATCHES = 64;
/** Имён в одном событии больше - дешевле прочитать каталог, чем звать stat на каждое. */
const RELIST_AT = 64;
/**
 * ОС теряет события при лавине (на macOS корень не назвал три из шести ушедших при checkout каталогов, хвост #147): событиям нельзя верить как единственному источнику.
 * Лавина - не меньше STORM_NAMES имён подряд без тишины в RESYNC_QUIET_MS; после тишины перечитываются все узлы. Так же после оповещения git об индексе и голове.
 * В простое это ни одного вызова.
 */
const STORM_NAMES = 16;
const RESYNC_QUIET_MS = 300;
/** Каталог git не часть дерева: его изменения - дело плагина git. */
const HIDDEN = new Set(['.git']);

type Kind = 'file' | 'dir' | 'link' | 'other';
type Mark = TreeMarkKind | 'changed';

interface Node {
  readonly dir: string;
  readonly entries: Map<string, Kind>;
  watch: Disposable | undefined;
  /** Слежения нет: изменения каталога плагин не видит, перечитать при раскрытии. */
  stale: boolean;
  /** Порядок раскрытия: вытесняется самый давний. */
  seq: number;
  /** События одного каталога обрабатываются по очереди. */
  work: Promise<unknown>;
}

const isCode = (error: unknown, code: string): boolean => typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const files: PluginModule = {
  activate(ctx: PluginContext) {
    const { fs } = ctx.os;
    const nodes = new Map<string, Node>();
    const counters = { list: 0, stat: 0, batches: 0, relists: 0, markRuns: 0, evicted: 0, resyncs: 0 };
    let root: string | undefined;
    let rootLost: string | undefined;
    let version = 0;
    let seq = 0;
    /** Путь отметки (без хвостового `/`, у корня) -> вид; каталоги с изменениями внутри. */
    let marks = new Map<string, TreeMarkKind>();
    let changedDirs = new Set<string>();

    const join = (dir: string, name: string): string => `${dir}/${name}`;
    const rel = (path: string): string => (root === undefined ? path : path === root ? '' : path.slice(root.length + 1));
    const inside = (path: string): boolean => root !== undefined && (path === root || path.startsWith(`${root}/`));
    const parentOf = (path: string): string => path.slice(0, path.lastIndexOf('/'));

    function markOf(path: string, kind: Kind): Mark | null {
      const r = rel(path);
      const own = marks.get(r);
      if (own !== undefined) return own;
      // Всё внутри неотслеживаемого каталога не отслеживается тоже: git называет только каталог.
      for (let p = parentOf(r); p !== ''; p = parentOf(p)) if (marks.get(p) === 'untracked') return 'untracked';
      if (kind === 'dir' && changedDirs.has(r)) return 'changed';
      return null;
    }

    function view(node: Node) {
      return {
        dir: node.dir,
        watched: node.watch !== undefined,
        stale: node.stale,
        entries: [...node.entries].map(([name, kind]) => [name, kind, markOf(join(node.dir, name), kind)] as const),
      };
    }

    // --- чтение каталога и разбор события ---

    async function list(dir: string): Promise<Map<string, Kind>> {
      counters.list++;
      const entries = await fs.list(dir);
      return new Map(entries.filter((e) => !HIDDEN.has(e.name)).map((e) => [e.name, e.kind]));
    }

    function dropSubtree(dir: string): void {
      for (const [path, node] of nodes) {
        if (path !== dir && !path.startsWith(`${dir}/`)) continue;
        node.watch?.dispose();
        node.watch = undefined;
        nodes.delete(path);
      }
    }

    /** Каталог перечитан целиком; ушедшие каталоги забывают свои узлы. Да - состав изменился. */
    async function relist(node: Node): Promise<boolean> {
      counters.relists++;
      const next = await list(node.dir);
      let changed = false;
      for (const [name, kind] of node.entries) {
        if (next.get(name) === kind) continue;
        changed = true;
        dropSubtree(join(node.dir, name));
      }
      for (const [name, kind] of next) if (node.entries.get(name) !== kind) changed = true;
      node.entries.clear();
      for (const [name, kind] of next) node.entries.set(name, kind);
      return changed;
    }

    /** Известное имя: узел обновляется одним stat; исчезнувшее удаляется. Ссылка остаётся ссылкой: stat раскрывает её в цель. */
    async function restat(node: Node, name: string): Promise<boolean> {
      const known = node.entries.get(name);
      if (known === undefined) return false;
      const path = join(node.dir, name);
      counters.stat++;
      try {
        const st = await fs.stat(path);
        if (known === 'link' || known === 'other' || st.kind === known) return false;
        node.entries.set(name, st.kind);
        dropSubtree(path);
        return true;
      } catch (error) {
        if (isCode(error, 'NotFound')) {
          node.entries.delete(name);
          dropSubtree(path);
          return true;
        }
        // Ссылка наружу или нет прав: имя остаётся таким, каким его показал list.
        if (isCode(error, 'PermissionDenied')) return false;
        throw error;
      }
    }

    async function onNames(node: Node, names: readonly string[]): Promise<void> {
      counters.batches++;
      const shown = [...new Set(names)].filter((n) => !HIDDEN.has(n));
      if (shown.length === 0 || nodes.get(node.dir) !== node) return;
      noteBurst(shown.length);
      let changed = false;
      try {
        if (shown.length > RELIST_AT || shown.some((n) => !node.entries.has(n))) changed = await relist(node);
        else for (const name of shown) changed = (await restat(node, name)) || changed;
      } catch (error) {
        // Удалён сам наблюдаемый каталог: шлюз слежение не закрывает (каталог на месте, пока проверка пути не провалилась), и о потере говорит только событие с его именем.
        if (isCode(error, 'NotFound') && (await fs.stat(node.dir).then(() => false, () => true))) return onClosed(node, 'каталог удалён');
        throw error;
      }
      if (changed) version++;
      scheduleMarks();
    }

    // --- перечитывание после лавины и смены ветки ---

    const burst = { names: 0, timer: undefined as NodeJS.Timeout | undefined };

    /** Узел перечитан целиком; исчезнувший каталог закрывается как при ошибке слежения. */
    async function resync(node: Node): Promise<void> {
      if (nodes.get(node.dir) !== node) return;
      counters.resyncs++;
      try {
        if (await relist(node)) version++;
      } catch (error) {
        if (isCode(error, 'NotFound')) await onClosed(node, 'каталог исчез');
        else throw error;
      }
    }

    /**
     * После тишины перечитываются все узлы, а не только те, где были события: потерянное событие по определению не оставляет следа,
     * и лавина под checkout теряла имена в каталогах, о которых не пришло ни одного (ai-cyborg, 4 узла из 48 расходились с диском).
     */
    function armResync(): void {
      clearTimeout(burst.timer);
      burst.timer = setTimeout(() => {
        burst.names = 0;
        burst.timer = undefined;
        // Родители раньше детей: ушедший каталог забирает свои узлы с собой.
        for (const node of [...nodes.values()].sort((a, b) => a.dir.length - b.dir.length)) void enqueue(node, () => resync(node));
      }, RESYNC_QUIET_MS);
    }

    function noteBurst(count: number): void {
      burst.names += count;
      if (burst.names >= STORM_NAMES) {
        armResync();
        return;
      }
      // Редкие мелкие события лавины не делают: счёт сбрасывается, если за RESYNC_QUIET_MS новых не было.
      burst.timer ??= setTimeout(() => {
        burst.names = 0;
        burst.timer = undefined;
      }, RESYNC_QUIET_MS);
    }

    // --- слежение: не больше MAX_WATCHES, самый давний раскрытый уступает место ---

    let attachQueue: Promise<unknown> = Promise.resolve();
    const watched = (): Node[] => [...nodes.values()].filter((n) => n.watch !== undefined);

    function evict(except: Node): boolean {
      const victim = watched()
        .filter((n) => n.dir !== root && n !== except)
        .sort((a, b) => a.seq - b.seq)[0];
      if (victim === undefined) return false;
      victim.watch?.dispose();
      victim.watch = undefined;
      victim.stale = true;
      counters.evicted++;
      return true;
    }

    function attach(node: Node): Promise<void> {
      const run = async (): Promise<void> => {
        if (nodes.get(node.dir) !== node || node.watch !== undefined) return;
        while (watched().length >= MAX_WATCHES) if (!evict(node)) break;
        try {
          node.watch = await fs.watch(
            node.dir,
            (names) => void enqueue(node, () => onNames(node, names)),
            (reason) => void enqueue(node, () => onClosed(node, reason)),
          );
          node.stale = false;
        } catch (error) {
          // Слежение недоступно (предел шлюза иной, чем мы считаем): узел живёт без него и перечитывается при раскрытии.
          node.stale = true;
          ctx.log(`слежение за ${node.dir} не открыто: ${message(error)}`, 'warn');
        }
      };
      const next = attachQueue.then(run, run);
      attachQueue = next;
      return next;
    }

    function enqueue(node: Node, job: () => Promise<void>): Promise<void> {
      node.work = node.work.then(job).catch((error: unknown) => ctx.log(`${node.dir}: ${message(error)}`, 'warn'));
      return node.work as Promise<void>;
    }

    /** Ядро закрыло слежение (каталог удалён, права ушли): узел и всё под ним забыто, родитель перечитан. */
    async function onClosed(node: Node, reason: string): Promise<void> {
      if (nodes.get(node.dir) !== node) return;
      node.watch = undefined;
      if (node.dir === root) {
        rootLost = reason;
        dropSubtree(node.dir);
        version++;
        return;
      }
      dropSubtree(node.dir);
      const parent = nodes.get(parentOf(node.dir));
      if (parent !== undefined && (await relist(parent))) version++;
      scheduleMarks();
    }

    // --- отметки ---

    const subscribed = new Map<string, Promise<Disposable | undefined>>();
    // Поля объекта, а не переменные: просьба приходит во время `await`, и анализ потока иначе считает `again` всегда ложным.
    const marksQueue = { running: false, again: false };
    const asked = (): boolean => marksQueue.again;

    /** Запрос отметок сразу; пока он идёт, остальные просьбы склеиваются в один следующий (git status дорог, события идут пачками). */
    function scheduleMarks(): void {
      if (root === undefined) return;
      if (marksQueue.running) {
        marksQueue.again = true;
        return;
      }
      marksQueue.running = true;
      void (async () => {
        try {
          do {
            marksQueue.again = false;
            await refreshMarks();
          } while (asked());
        } finally {
          marksQueue.running = false;
        }
      })();
    }

    const STRENGTH: readonly TreeMarkKind[] = ['conflict', 'untracked', 'added', 'renamed', 'deleted', 'modified'];

    async function refreshMarks(): Promise<void> {
      const at = root;
      if (at === undefined) return;
      counters.markRuns++;
      const next = new Map<string, TreeMarkKind>();
      for (const provider of ctx.contracts.all('cyborg.tree-decoration', 1)) {
        try {
          for (const m of await provider.impl.marks(at)) {
            const path = m.path.replace(/\/$/, '');
            const old = next.get(path);
            if (old === undefined || STRENGTH.indexOf(m.kind) < STRENGTH.indexOf(old)) next.set(path, m.kind);
          }
        } catch (error) {
          ctx.log(`отметки от ${provider.pluginId}: ${message(error)}`, 'warn');
        }
      }
      if (root !== at) return;
      const dirs = new Set<string>();
      for (const path of next.keys()) for (let p = parentOf(path); p !== ''; p = parentOf(p)) dirs.add(p);
      const same = next.size === marks.size && [...next].every(([p, k]) => marks.get(p) === k);
      marks = next;
      changedDirs = dirs;
      if (!same) version++;
    }

    /** Поставщики отметок приходят и уходят; каждый сообщает, что набор отметок корня мог измениться. */
    function followProviders(): void {
      const present = new Set<string>();
      for (const provider of ctx.contracts.all('cyborg.tree-decoration', 1)) {
        present.add(provider.pluginId);
        if (subscribed.has(provider.pluginId)) continue;
        subscribed.set(
          provider.pluginId,
          provider.impl.onChange((at) => {
            if (at !== root) return;
            // Индекс или голова поменялись (commit, checkout, pull): каталоги могли смениться так, что событий не хватит.
            scheduleMarks();
            armResync();
          }).then(
            (sub) => sub,
            (error: unknown) => {
              ctx.log(`подписка на ${provider.pluginId}: ${message(error)}`, 'warn');
              return undefined;
            },
          ),
        );
      }
      for (const [id, sub] of subscribed) {
        if (present.has(id)) continue;
        subscribed.delete(id);
        void sub.then((s) => s?.dispose());
      }
      scheduleMarks();
    }

    // --- команды ---

    async function open(dir: string, kind: 'root' | 'node'): Promise<Node> {
      const known = nodes.get(dir);
      const node: Node = known ?? { dir, entries: new Map(), watch: undefined, stale: true, seq: 0, work: Promise.resolve() };
      node.seq = ++seq;
      nodes.set(dir, node);
      try {
        // Слежение раньше чтения: правка между ними даст событие, а не потеряется.
        await attach(node);
        node.entries.clear();
        for (const [name, k] of await list(dir)) node.entries.set(name, k);
        version++;
      } catch (error) {
        if (kind === 'root' || known === undefined) dropSubtree(dir);
        throw error;
      }
      return node;
    }

    function reset(): void {
      clearTimeout(burst.timer);
      burst.timer = undefined;
      burst.names = 0;
      for (const node of nodes.values()) node.watch?.dispose();
      nodes.clear();
      marks = new Map();
      changedDirs = new Set();
      rootLost = undefined;
    }

    ctx.commands.register('files.root', async (path) => {
      if (typeof path !== 'string' || !path.startsWith('/')) throw new Error('files.root: нужен абсолютный путь');
      reset();
      root = path.replace(/\/+$/, '');
      const node = await open(root, 'root').catch((error: unknown) => {
        root = undefined;
        throw error;
      });
      followProviders();
      return view(node);
    });

    ctx.commands.register('files.expand', async (path) => {
      if (typeof path !== 'string' || !inside(path)) throw new Error('files.expand: каталог вне корня дерева');
      const parent = nodes.get(parentOf(path));
      const kind = parent?.entries.get(path.slice(path.lastIndexOf('/') + 1));
      if (path === root) throw new Error('files.expand: корень уже раскрыт');
      if (kind === undefined) throw new Error(`files.expand: ${path} не показан в дереве - раскройте родителя`);
      if (kind === 'link') throw new Error(`files.expand: ${path} - ссылка, ссылки не раскрываются`);
      if (kind !== 'dir') throw new Error(`files.expand: ${path} - не каталог`);
      return view(await open(path, 'node'));
    });

    ctx.commands.register('files.collapse', (path) => {
      if (typeof path !== 'string' || path === root) throw new Error('files.collapse: нужен раскрытый каталог, не корень');
      dropSubtree(path);
      version++;
      return undefined;
    });

    ctx.commands.register('files.open', (path) => ctx.commands.run('viewer.open', { path }));

    ctx.commands.register('files.state', async () => {
      // Обработка событий идёт по очередям узлов: состояние берётся после того, как они разобраны.
      await Promise.all([...nodes.values()].map((n) => n.work));
      return {
        root: root ?? null,
        version,
        rootLost: rootLost ?? null,
        watches: watched().length,
        counters: { ...counters },
        pending: marksQueue.running,
        marks: Object.fromEntries(marks),
        nodes: Object.fromEntries([...nodes].map(([dir, node]) => [dir, view(node)])),
      };
    });

    ctx.subscriptions.add(
      ctx.contracts.onChange('cyborg.tree-decoration', () => {
        if (root !== undefined) followProviders();
      }),
      {
        dispose() {
          clearTimeout(burst.timer);
          reset();
          for (const sub of subscribed.values()) void sub.then((s) => s?.dispose());
        },
      },
    );
    return undefined;
  },
};

export default files;
