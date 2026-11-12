import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watch as watchFs } from 'node:fs';
import { appendFile, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { waitFor } from '../../core/test/wait-for.ts';
import { git, makeRepo, sandbox, startPilot, writeFiles, type Pilot } from './pilot-kit.ts';

// PL-04: дерево файлов в плагине files поверх fs.list, fs.stat и одного рекурсивного fs.watch шлюза за корнем (#205), отметки от git и открытие файла в viewer - три плагина в трёх хостах-процессах (forkHosts), настоящий репозиторий.

type Entry = readonly [string, string, string | null];
interface NodeView {
  dir: string;
  entries: Entry[];
}
interface State {
  root: string | null;
  version: number;
  rootLost: string | null;
  watches: number;
  pending: boolean;
  counters: { list: number; stat: number; batches: number; relists: number; markRuns: number; resyncs: number };
  marks: Record<string, string>;
  nodes: Record<string, NodeView>;
}

const FILES = { 'a.txt': 'a\n', 'src/b.ts': 'b\n', 'src/deep/c.ts': 'c\n', 'docs/readme.md': '# r\n' };
const names = (node: NodeView | undefined): string[] => (node?.entries ?? []).map((e) => e[0]).toSorted();
const state = (p: Pilot): Promise<State> => p.k.run('files.state') as Promise<State>;
const nosy = { id: 'nosy', permissions: {} };
const ARMED = '.armed';

/**
 * macOS (FSEvents) начинает доставку не в тот миг, когда fs.watch вернулся: правка сразу после него пропадает (хвост #147). Как в core/test/os.test.ts, до проверки
 * пишем в наблюдаемые каталоги пробный файл, пока дерево о нём не узнает; потом убираем его и ждём, пока дерево успокоится.
 */
async function arm(p: Pilot, dirs: readonly string[]): Promise<void> {
  const seen = (st: State, dir: string) => names(st.nodes[dir]).includes(ARMED);
  let n = 0;
  await waitFor('слежение отозвалось на пробные записи', async () => {
    const st = await state(p);
    if (dirs.every((d) => seen(st, d))) return true;
    for (const d of dirs) if (!seen(st, d)) await writeFile(path.join(d, ARMED), String(n++));
    return undefined;
  });
  for (const d of dirs) await rm(path.join(d, ARMED));
  await waitFor('пробные файлы ушли из дерева', async () => {
    const st = await state(p);
    return dirs.every((d) => !seen(st, d)) && !st.pending ? true : undefined;
  });
}

async function started(files: Readonly<Record<string, string>> = FILES, ids: Parameters<typeof startPilot>[0]['ids'] = ['files', 'git', 'viewer'], watch?: Parameters<typeof startPilot>[0]['watch']) {
  const box = await sandbox('cyborg-pl04-');
  const repo = await makeRepo(box, files);
  const p = await startPilot({ box, repo, ids, probes: [nosy], ...(watch && { watch }) });
  const dispose = async () => {
    await p[Symbol.asyncDispose]();
    await box[Symbol.asyncDispose]();
  };
  return { box, repo, p, [Symbol.asyncDispose]: dispose };
}
const QUIET_MS = 500;

/**
 * Дерево устоялось: отметки запрошены, запросов в работе нет, и ни счётчики, ни число сырых событий не менялись QUIET_MS подряд.
 * Одного «запросов нет» мало: запоздалое событие (дубль от FSEvents после удаления пробного файла) запускает запрос позже, чем тест снял снимок,
 * и такой запрос подхватывал правку, сделанную уже после снимка (так упал тест нерекурсивного слежения на macOS).
 */
const settled = (p: Pilot, runs = 1) => {
  let last = '';
  let since = Date.now();
  return waitFor('дерево устоялось: отметки получены, запросов и событий нет', async () => {
    const st = await state(p);
    const key = `${JSON.stringify(st.counters)}/${String(st.version)}/${String(p.watches.raw)}`;
    if (key !== last || st.pending || st.counters.markRuns < runs) {
      last = key;
      since = Date.now();
      return undefined;
    }
    return Date.now() - since >= QUIET_MS ? true : undefined;
  });
};

test('files: дерево корня и раскрытие каталога идут через fs.list шлюза; .git скрыт; отметки приходят от git из другого хоста', async () => {
  await using s = await started();
  const { p, repo } = s;
  assert.equal(new Set([p.k.hostOf('files'), p.k.hostOf('git'), p.k.hostOf('viewer')]).size, 3, 'три плагина - три хоста');
  const rootNode = (await p.k.run('files.root', repo)) as NodeView;
  assert.deepEqual(names(rootNode), ['a.txt', 'docs', 'src']);
  assert.deepEqual(rootNode.entries.find((e) => e[0] === 'src')?.[1], 'dir');
  const src = (await p.k.run('files.expand', path.join(repo, 'src'))) as NodeView;
  assert.deepEqual(src.entries.map((e) => `${e[0]}:${e[1]}`).toSorted(), ['b.ts:file', 'deep:dir']);
  await arm(p, [repo, path.join(repo, 'src')]);

  await appendFile(path.join(repo, 'src', 'b.ts'), 'x\n');
  await writeFile(path.join(repo, 'new.txt'), 'n\n');
  const after = await waitFor('отметки git дошли до дерева', async () => {
    const st = await state(p);
    return st.marks['src/b.ts'] === 'modified' && st.marks['new.txt'] === 'untracked' && names(st.nodes[repo]).includes('new.txt') ? st : undefined;
  });
  const marked = (dir: string, name: string) => after.nodes[dir]?.entries.find((e) => e[0] === name)?.[2];
  assert.equal(marked(repo, 'src'), 'changed', 'каталог с изменением внутри отмечен по детям');
  assert.equal(marked(repo, 'docs'), null);
  assert.equal(marked(path.join(repo, 'src'), 'b.ts'), 'modified');
  assert.equal(marked(repo, 'new.txt'), 'untracked');
});

test('files: без событий нет ни одного вызова - ни fs.list, ни fs.stat, ни git; правка известного файла стоит одного stat и одного запроса отметок, без перечитывания каталога', async () => {
  await using s = await started();
  const { p, repo } = s;
  await p.k.run('files.root', repo);
  await p.k.run('files.expand', path.join(repo, 'src'));
  await arm(p, [repo, path.join(repo, 'src')]);
  await settled(p);
  const idle = await state(p);
  const gitBefore = (await p.gitRuns()).length;
  await new Promise((r) => setTimeout(r, 1500));
  const still = await state(p);
  assert.deepEqual(still.counters, idle.counters, 'простой: счётчики вызовов не сдвинулись');
  assert.equal((await p.gitRuns()).length, gitBefore, 'простой: git не запускался');

  await appendFile(path.join(repo, 'src', 'b.ts'), 'x\n');
  const changed = await waitFor('правка дошла до отметок', async () => {
    const st = await state(p);
    return st.marks['src/b.ts'] === 'modified' ? st : undefined;
  });
  assert.equal(changed.counters.stat - idle.counters.stat, 1, 'один stat на изменённое имя');
  assert.equal(changed.counters.list, idle.counters.list, 'каталог не перечитывался');
  assert.equal(changed.counters.relists, idle.counters.relists);
  assert.equal(changed.counters.markRuns - idle.counters.markRuns, 1, 'один запрос отметок на пачку');
  assert.equal((await p.gitRuns()).length - gitBefore, 1, 'один git status на пачку');
});

test('files: новый файл, удалённый файл, переименованный каталог - каждый узел обновляется по своим именам, соседние каталоги не трогаются', async () => {
  await using s = await started();
  const { p, repo } = s;
  await p.k.run('files.root', repo);
  await p.k.run('files.expand', path.join(repo, 'src'));
  await p.k.run('files.expand', path.join(repo, 'src', 'deep'));
  await p.k.run('files.expand', path.join(repo, 'docs'));
  await arm(p, [repo, path.join(repo, 'src'), path.join(repo, 'src', 'deep'), path.join(repo, 'docs')]);
  await settled(p);
  const docsBefore = (await state(p)).nodes[path.join(repo, 'docs')];

  await writeFile(path.join(repo, 'src', 'added.ts'), 'a');
  await waitFor('новый файл виден', async () => (names((await state(p)).nodes[path.join(repo, 'src')]).includes('added.ts') ? true : undefined));
  await rm(path.join(repo, 'src', 'added.ts'));
  await waitFor('удалённый файл ушёл', async () => (!names((await state(p)).nodes[path.join(repo, 'src')]).includes('added.ts') ? true : undefined));

  await rename(path.join(repo, 'src', 'deep'), path.join(repo, 'src', 'deeper'));
  const renamed = await waitFor('переименование разобрано', async () => {
    const st = await state(p);
    return names(st.nodes[path.join(repo, 'src')]).includes('deeper') ? st : undefined;
  });
  assert.ok(!names(renamed.nodes[path.join(repo, 'src')]).includes('deep'));
  assert.equal(renamed.nodes[path.join(repo, 'src', 'deep')], undefined, 'узел ушедшего каталога забыт');
  assert.equal(renamed.watches, 1, 'слежение одно, за корнем: ни ушедший, ни раскрытый каталог своего слежения не имеют');
  assert.deepEqual(renamed.nodes[path.join(repo, 'docs')]?.entries, docsBefore?.entries, 'docs не менялся');
});

test('files: раскрытый каталог удалён - узел и поддерево забыты, родитель перечитан, слежение за корнем живо, ошибок нет', async () => {
  await using s = await started();
  const { p, repo } = s;
  await p.k.run('files.root', repo);
  await p.k.run('files.expand', path.join(repo, 'src'));
  await p.k.run('files.expand', path.join(repo, 'src', 'deep'));
  await arm(p, [repo, path.join(repo, 'src'), path.join(repo, 'src', 'deep')]);
  await rm(path.join(repo, 'src'), { recursive: true });
  const st = await waitFor('удаление разобрано', async () => {
    const cur = await state(p);
    return !names(cur.nodes[repo]).includes('src') && cur.nodes[path.join(repo, 'src')] === undefined ? cur : undefined;
  });
  assert.equal(st.nodes[path.join(repo, 'src', 'deep')], undefined);
  assert.equal(st.watches, 1, 'слежение за корнем живо');
  assert.deepEqual(p.k.journal.filter((e) => e.kind === 'failed'), []);
  await assert.rejects(p.k.run('files.expand', path.join(repo, 'src')), /не показан в дереве/);
});

test('files: корень удалён - rootLost с причиной, а не тишина', async () => {
  await using s = await started();
  const { p, repo } = s;
  await p.k.run('files.root', repo);
  await arm(p, [repo]);
  await rm(repo, { recursive: true });
  const st = await waitFor('потеря корня замечена', async () => {
    const cur = await state(p);
    return cur.rootLost === null ? undefined : cur;
  });
  assert.match(st.rootLost ?? '', /исчез|прерван|вне|прав|удал/i);
  assert.equal(st.watches, 0);
});

test('files: слежение за корнем одно и рекурсивное - 70 раскрытых каталогов (больше предела 64) держат одну запись лимита шлюза, каждый узел видит свои правки, вытеснять некого', async () => {
  const wide = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`d${String(i).padStart(2, '0')}/f.txt`, 'x']));
  await using s = await started(wide, ['files']);
  const { p, repo } = s;
  await p.k.run('files.root', repo);
  const dirs = Array.from({ length: 70 }, (_, i) => path.join(repo, `d${String(i).padStart(2, '0')}`));
  for (const dir of dirs) await p.k.run('files.expand', dir);
  const full = await state(p);
  assert.equal(full.watches, 1, 'одно слежение на все 71 узла');
  assert.deepEqual(p.watches.opened, [repo], 'шлюзу открыто одно слежение, за корнем');
  assert.deepEqual(p.watches.recursive, [repo], 'и оно рекурсивное');
  assert.equal(p.watches.peak, 1);
  assert.equal(Object.keys(full.nodes).length, 71, 'корень и 70 каталогов раскрыты');
  assert.deepEqual(p.k.journal.filter((e) => e.kind === 'failed'), []);

  await arm(p, [repo, dirs[0] ?? '', dirs[69] ?? '']);
  // Первый и последний раскрытый каталоги следят одинаково: вытесненных, которые молчат до повторного раскрытия, больше нет.
  await writeFile(path.join(dirs[0] ?? '', 'new.txt'), 'n');
  await writeFile(path.join(dirs[69] ?? '', 'new.txt'), 'n');
  await waitFor('правки в давно и недавно раскрытых каталогах видны', async () => {
    const st = await state(p);
    return names(st.nodes[dirs[0] ?? '']).includes('new.txt') && names(st.nodes[dirs[69] ?? '']).includes('new.txt') ? true : undefined;
  });
  assert.equal((await state(p)).watches, 1);
  assert.equal(p.watches.opened.length, 1, 'новых слежений не открывалось');
});

test('files: checkout ветки с сотнями изменений - событий сколько угодно, обновлений и запросов git единицы, дерево совпадает с диском, отметки пусты', async (t) => {
  const many = Object.fromEntries(Array.from({ length: 30 }, (_, d) => Array.from({ length: 20 }, (_, f) => [`d${String(d).padStart(2, '0')}/f${String(f).padStart(2, '0')}.txt`, `main ${String(d)} ${String(f)}\n`] as const)).flat());
  await using s = await started(many);
  const { p, repo } = s;
  git(repo, 'checkout', '-q', '-b', 'other');
  await writeFiles(repo, Object.fromEntries(Object.keys(many).map((f) => [f, 'other\n'])));
  for (let d = 0; d < 30; d++) await rm(path.join(repo, `d${String(d).padStart(2, '0')}`, 'f00.txt'));
  await writeFiles(repo, { 'extra/new.txt': 'n\n' });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'other');
  git(repo, 'checkout', '-q', 'main');
  await p.k.run('files.root', repo);
  const expanded = Array.from({ length: 20 }, (_, d) => path.join(repo, `d${String(d).padStart(2, '0')}`));
  for (const dir of expanded) await p.k.run('files.expand', dir);
  await arm(p, [repo, ...expanded]);
  await settled(p);
  const before = await state(p);
  const gitBefore = (await p.gitRuns()).length;
  const rawBefore = p.watches.raw;

  git(repo, 'checkout', '-q', 'other');
  await waitFor('дерево совпало с веткой other', async () => {
    const st = await state(p);
    return names(st.nodes[repo]).includes('extra') && !names(st.nodes[path.join(repo, 'd00')]).includes('f00.txt') ? st : undefined;
  });
  await new Promise((r) => setTimeout(r, 1200));
  const after = await state(p);
  const raw = p.watches.raw - rawBefore;
  const runs = (await p.gitRuns()).length - gitBefore;
  t.diagnostic(`событий слежения ${String(raw)}, пачек ${String(after.counters.batches)}, перечитываний ${String(after.counters.relists)}, запросов отметок ${String(after.counters.markRuns - before.counters.markRuns)}, git status ${String(runs)}`);
  assert.ok(raw >= 20, `событий слежения ${String(raw)}`);
  assert.ok(after.counters.markRuns - before.counters.markRuns <= 6, `запросов отметок ${String(after.counters.markRuns - before.counters.markRuns)}`);
  assert.ok(runs <= 8, `git status запущен ${String(runs)} раз`);
  assert.ok(after.counters.batches < raw, `пачек ${String(after.counters.batches)} меньше событий ${String(raw)}: склейка работает`);
  assert.deepEqual(after.marks, {}, 'ветка совпадает с коммитом: отметок нет');
  for (let d = 0; d < 20; d++) {
    const dir = path.join(repo, `d${String(d).padStart(2, '0')}`);
    assert.ok(!names(after.nodes[dir]).includes('f00.txt'), `${dir}: удалённый файл ушёл`);
    assert.equal(names(after.nodes[dir]).length, 19);
  }
  assert.equal((await p.k.run('files.state') as State).watches, 1, 'слежение за корнем пережило checkout');
  assert.deepEqual(p.k.journal.filter((e) => e.kind === 'failed'), []);
});

test('files: коммит снаружи сбрасывает отметки без единого события рабочего дерева - их приносит onChange поставщика', async () => {
  await using s = await started();
  const { p, repo } = s;
  await p.k.run('files.root', repo);
  await arm(p, [repo]);
  await appendFile(path.join(repo, 'a.txt'), 'x\n');
  await waitFor('отметка появилась', async () => ((await state(p)).marks['a.txt'] === 'modified' ? true : undefined));
  const batches = (await state(p)).counters.batches;
  git(repo, 'commit', '-q', '-a', '-m', 'second');
  await waitFor('отметка снята после коммита', async () => (Object.keys((await state(p)).marks).length === 0 ? true : undefined));
  assert.ok(((await state(p)).counters.batches) - batches <= 1, 'каталоги дерева при коммите почти не шумят');
});

test('files: правка вглубь нераскрытого каталога даёт событие и отметку сама - без другой причины и без единого stat или list (рекурсивное слежение за корнем)', async () => {
  await using s = await started();
  const { p, repo } = s;
  await p.k.run('files.root', repo);
  await arm(p, [repo]);
  await settled(p);
  const quiet = await state(p);
  const rawBefore = p.watches.raw;
  await appendFile(path.join(repo, 'src', 'deep', 'c.ts'), 'x\n');
  const seen = await waitFor('отметка правки в нераскрытом каталоге появилась сама', async () => {
    const st = await state(p);
    return st.marks['src/deep/c.ts'] === 'modified' ? st : undefined;
  });
  assert.ok(p.watches.raw > rawBefore, 'корень получил событие о правке на два уровня глубже');
  assert.equal(seen.nodes[repo]?.entries.find((e) => e[0] === 'src')?.[2], 'changed', 'каталог на пути отмечен по детям');
  assert.equal(seen.counters.markRuns - quiet.counters.markRuns, 1, 'один запрос отметок на правку');
  assert.equal(seen.counters.stat, quiet.counters.stat, 'нераскрытый каталог узла не имеет: stat не звали');
  assert.equal(seen.counters.list, quiet.counters.list, 'и каталог не перечитывали');
});

test('files: свёрнутый каталог правок не разбирает - узла нет, stat и list не звались, а отметка приходит; событие, назвавшее неизвестное узлу имя глубже, перечитывает ближайший раскрытый предок', async () => {
  const lostNames = new Set<string>();
  await using s = await started(FILES, ['files', 'git', 'viewer'], lossy(() => false, (name) => lostNames.has(name)));
  const { p, repo } = s;
  await p.k.run('files.root', repo);
  await p.k.run('files.expand', path.join(repo, 'src'));
  await arm(p, [repo, path.join(repo, 'src')]);
  await settled(p);
  await p.k.run('files.collapse', path.join(repo, 'src'));
  const collapsed = await state(p);
  assert.equal(collapsed.nodes[path.join(repo, 'src')], undefined);
  await appendFile(path.join(repo, 'src', 'b.ts'), 'x\n');
  const marked = await waitFor('отметка правки в свёрнутом каталоге', async () => {
    const st = await state(p);
    return st.marks['src/b.ts'] === 'modified' ? st : undefined;
  });
  assert.equal(marked.counters.stat, collapsed.counters.stat, 'свёрнутый каталог узла не имеет: stat не звали');
  assert.equal(marked.counters.list, collapsed.counters.list);

  // Новый каталог внутри раскрытого `src`: ОС назвала файл внутри, а имя самого каталога потеряла. Узел `src` его не знает - перечитывается.
  await p.k.run('files.expand', path.join(repo, 'src'));
  await arm(p, [path.join(repo, 'src')]);
  await settled(p);
  lostNames.add('src/fresh');
  const relists = (await state(p)).counters.relists;
  await writeFiles(repo, { 'src/fresh/inner.ts': 'i\n' });
  const st = await waitFor('неизвестный узлу каталог появился по событию глубже', async () => {
    const cur = await state(p);
    return names(cur.nodes[path.join(repo, 'src')]).includes('fresh') ? cur : undefined;
  });
  assert.ok(st.counters.relists > relists, 'узел перечитан, а не угадан по имени');
});

test('files: события внутри .git, которые видит слежение за корнем, дерева и отметок не трогают - ни пачек, ни запросов, ни перечитываний', async () => {
  await using s = await started();
  const { p, repo } = s;
  await p.k.run('files.root', repo);
  await p.k.run('files.expand', path.join(repo, 'src'));
  await arm(p, [repo, path.join(repo, 'src')]);
  await settled(p);
  const rawBefore = p.watches.rawBy[repo] ?? 0;
  const quiet = await state(p);
  // Объекты, ссылки и журналы: десятки имён глубоко внутри .git; слежение за корнем рекурсивное и их видит (слежение git за самим .git их не видит: оно не рекурсивное).
  await writeFiles(path.join(repo, '.git'), Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`objects/zz/o${String(i)}`, 'o'])));
  await waitFor('слежение за корнем увидело события внутри .git', () => ((p.watches.rawBy[repo] ?? 0) > rawBefore ? true : undefined));
  await new Promise((r) => setTimeout(r, 400));
  const after = await state(p);
  assert.equal(after.counters.batches, quiet.counters.batches, 'пачки с одним .git дереву не нужны');
  assert.equal(after.counters.relists, quiet.counters.relists);
  assert.equal(after.counters.resyncs, quiet.counters.resyncs, 'и лавина внутри .git перечитывания не включает');
  assert.equal(after.counters.markRuns, quiet.counters.markRuns, 'git status по ним не запускается');
});

/**
 * Слежение, которое теряет события, как FSEvents при лавине (на checkout большого репозитория корень не назвал три из шести ушедших каталогов).
 * `drop(target)` теряет всё слежение, `dropName(name)` - события с таким именем (путь от корня через `/` у рекурсивного слежения).
 */
function lossy(drop: (target: string) => boolean, dropName: (name: string) => boolean = () => false): NonNullable<Parameters<typeof startPilot>[0]['watch']> {
  type Listener = (event: string, name: string | null) => void;
  return ((target: string, ...rest: [Listener] | [object, Listener]) => {
    const listener = rest.length === 1 ? rest[0] : rest[1];
    const filtered: Listener = (event, name) => {
      if (!drop(target) && !(name !== null && dropName(name))) listener(event, name);
    };
    return rest.length === 1 ? watchFs(target, filtered) : watchFs(target, rest[0] as { recursive: boolean }, filtered);
  }) as unknown as NonNullable<Parameters<typeof startPilot>[0]['watch']>;
}

test('files: ОС потеряла события каталогов при checkout - дерево догоняет по оповещению git об индексе и голове', async () => {
  const drop = { on: false };
  await using s = await started(FILES, ['files', 'git', 'viewer'], lossy((target) => drop.on && !target.endsWith('.git')));
  const { p, repo } = s;
  git(repo, 'checkout', '-q', '-b', 'other');
  await rm(path.join(repo, 'docs'), { recursive: true });
  await writeFiles(repo, { 'extra/new.txt': 'n\n', 'src/more.ts': 'm\n' });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'other');
  git(repo, 'checkout', '-q', 'main');
  await p.k.run('files.root', repo);
  await p.k.run('files.expand', path.join(repo, 'src'));
  await p.k.run('files.expand', path.join(repo, 'docs'));
  await arm(p, [repo, path.join(repo, 'src'), path.join(repo, 'docs')]);
  await settled(p);

  drop.on = true;
  git(repo, 'checkout', '-q', 'other');
  const st = await waitFor('дерево догнало диск без событий каталогов', async () => {
    const cur = await state(p);
    return names(cur.nodes[repo]).includes('extra') && !names(cur.nodes[repo]).includes('docs') && names(cur.nodes[path.join(repo, 'src')]).includes('more.ts') ? cur : undefined;
  });
  assert.equal(st.nodes[path.join(repo, 'docs')], undefined, 'узел ушедшего каталога забыт');
  // Счётчик перечитываний не проверяется: дерево могло догнать и по закрытию слежения за ушедшим каталогом (onClose шлюза), ждём наблюдаемый итог, а не путь к нему.
});

/**
 * Лавина, из которой ОС доставила события только первых DELIVERED файлов и события конца, а середину потеряла (FSEvents при checkout). Файлы пишутся с паузой `pauseMs`: 0 - как быстрая
 * машина, 5 - как медленный раннер, где запись трёх волн идёт дольше тишины RESYNC_QUIET_MS.
 *
 * Тишина считается по доставленным событиям, а плагин не видит записи, о которой ОС промолчала. Если доставка оборвана в начале записи, перечитывание наступает через 300 мс после последнего
 * доставленного события - на медленной машине раньше, чем допишется лавина, - и прочитывает неполный каталог; недошедшие события его уже не обновят. Поэтому доставку обрывает не счёт
 * событий (число событий на файл у ОС своё: Linux - несколько на запись, FSEvents - одно), а имя, а после конца записи тест доставляет хвост лавины - правку первых DELIVERED файлов,
 * известных узлу: это перезапускает тишину уже после записи, и перечитывание всегда видит каталог целиком, как бы медленно он ни писался.
 */
const DELIVERED = 20;
async function avalancheLost(pauseMs: number): Promise<void> {
  const many = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`bulk/f${String(i).padStart(3, '0')}.txt`, 'x']));
  const lost = (name: string): boolean => {
    const index = /^bulk\/f(\d+)\.txt$/.exec(name)?.[1];
    return index !== undefined && Number(index) >= DELIVERED;
  };
  await using s = await started({ ...FILES, 'bulk/keep.txt': 'k' }, ['files'], lossy(() => false, lost));
  const { p, repo } = s;
  await p.k.run('files.root', repo);
  await p.k.run('files.expand', path.join(repo, 'bulk'));
  await arm(p, [repo, path.join(repo, 'bulk')]);
  // Лавина тремя волнами по 50 файлов: слежение доставит события первых DELIVERED файлов первой волны, остальное потеряет; перечитанный по первой пачке каталог дальше не обновится.
  const waves = [0, 1, 2].map((w) => Object.fromEntries(Object.entries(many).slice(w * 50, w * 50 + 50)));
  for (const wave of waves) {
    for (const [name, text] of Object.entries(wave)) {
      await writeFiles(repo, { [name]: text });
      if (pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  // Хвост лавины: запись окончена, ОС называет правки первых файлов; их не меньше STORM_NAMES, поэтому тишина отсчитывается заново, от конца записи.
  await writeFiles(repo, Object.fromEntries(Object.entries(many).slice(0, DELIVERED).map(([name]) => [name, 'tail'])));
  const st = await waitFor('каталог перечитан после лавины', async () => {
    const cur = await state(p);
    return names(cur.nodes[path.join(repo, 'bulk')]).length === 151 ? cur : undefined;
  });
  assert.ok(st.counters.resyncs >= 1, 'перечитывание после тишины');
}

test('files: лавина событий, из которых ОС доставила только начало - после тишины перечитываются все узлы', () => avalancheLost(0));

test('files: лавина событий, из которых ОС доставила только начало, на медленном раннере (запись дольше тишины) - после тишины перечитываются все узлы', () => avalancheLost(5));

test('files: лавина событий со всего дерева не гонит git status на каждую пачку - отметки запрашиваются один раз после тишины и приходят верными', async () => {
  const many = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`bulk/deep/f${String(i).padStart(3, '0')}.txt`, 'x']));
  await using s = await started();
  const { p, repo } = s;
  await p.k.run('files.root', repo);
  await arm(p, [repo]);
  await settled(p);
  const before = await state(p);
  // Три волны по 50 файлов в нераскрытом каталоге: каждая - отдельная пачка шлюза, и каждая сама по себе уже лавина (не меньше 16 имён).
  for (const w of [0, 1, 2]) {
    await writeFiles(repo, Object.fromEntries(Object.entries(many).slice(w * 50, w * 50 + 50)));
    await new Promise((r) => setTimeout(r, 120));
  }
  const st = await waitFor('отметки лавины пришли', async () => {
    const cur = await state(p);
    return cur.marks.bulk === 'untracked' && !cur.pending ? cur : undefined;
  });
  assert.equal(st.nodes[repo]?.entries.find((e) => e[0] === 'bulk')?.[2], 'untracked');
  const runs = st.counters.markRuns - before.counters.markRuns;
  assert.ok(runs >= 1 && runs <= 2, `запросов отметок на лавину ${String(runs)}: по одному на пачку было бы не меньше трёх`);
});

test('files: права - корень вне воркспейса отказан, ссылка наружу не раскрывается и не читается, ссылка внутрь читается; открывает файл только viewer и только по праву вызывающего', async () => {
  await using s = await started();
  const { p, repo, box } = s;
  const outside = box.path('outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'secret.txt'), 'секрет');
  await symlink(outside, path.join(repo, 'out'));
  await symlink(path.join(repo, 'src', 'b.ts'), path.join(repo, 'in.ts'));
  const rootNode = (await p.k.run('files.root', repo)) as NodeView;
  const kinds = Object.fromEntries(rootNode.entries.map((e) => [e[0], e[1]]));
  assert.equal(kinds.out, 'link');
  assert.equal(kinds['in.ts'], 'link');
  await assert.rejects(p.k.run('files.expand', path.join(repo, 'out')), /ссылк/);
  await assert.rejects(p.k.run('files.root', '/etc'), { code: 'PermissionDenied', message: /вне области fs\.read/ });

  // Открытие: свой файл и ссылка внутрь - читаются; ссылка наружу и чужой путь - PermissionDenied от ядра, viewer ничего не прочитал.
  await p.k.run('files.root', repo);
  assert.deepEqual(await p.k.run('files.open', path.join(repo, 'a.txt')), { path: path.join(repo, 'a.txt'), size: 2, shownBytes: 2, truncated: false });
  assert.deepEqual(await p.k.run('files.open', path.join(repo, 'in.ts')), { path: path.join(repo, 'in.ts'), size: 2, shownBytes: 2, truncated: false });
  for (const target of [path.join(repo, 'out', 'secret.txt'), '/etc/hosts']) await assert.rejects(p.k.run('files.open', target), /вне области fs\.read/);
  assert.equal(((await p.k.run('viewer.current')) as { path: string }).path, path.join(repo, 'in.ts'), 'отказанные открытия viewer не затронули');
  const denied = p.k.journal.filter((e) => e.kind === 'denied');
  assert.ok(denied.some((e) => e.pluginId === 'files' && e.reason === 'via-contract'), 'отказ files записан у вызывающего с причиной via-contract');

  // Плагин без права читать путь: команда viewer.open ему открыта, но guard отказывает до viewer; команды files чужим плагинам закрыты.
  await assert.rejects(p.k.run('nosy.run', 'viewer.open', { path: path.join(repo, 'a.txt') }), /вне области fs\.read/);
  await assert.rejects(p.k.run('nosy.run', 'files.root', repo), /не открыл команду другим плагинам/);
  assert.ok(p.k.journal.some((e) => e.kind === 'denied' && e.pluginId === 'nosy' && e.reason === 'via-contract'));
  assert.ok(p.k.journal.some((e) => e.kind === 'denied' && e.pluginId === 'nosy' && e.reason === 'command-callers'));
});
