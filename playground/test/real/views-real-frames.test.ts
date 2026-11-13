// TR-31 (docs/research/trust-and-isolation/06-work-plan.md, 5.8): виды на НАСТОЯЩЕМ Electron. Не `npm test`: нужны окно и дисплей (Linux - xvfb-run),
// запуск - `npm run test:views`, в CI шаг «виды на настоящем Electron». Подставных кадров здесь нет: playground собран, виды alice и bob делят группу duo,
// echo живёт в своей группе; вид «атакует» через DevTools Protocol (код исполняется в документе вида), результат читает тест.
//
// Что фиксирует тест (результаты первого прогона записаны в docs/05-verification/views-real-frames.md):
//  1. pushState на путь соседа по группе, на плагин другой группы и на корень: личность кадра (плагин моста) не меняется;
//  2. чужая страница во фрейме: вложенные фреймы вида с адресом другой группы и с внешним адресом блокирует CSP вида, уход самого фрейма на чужие адреса отклоняет
//     окно и пишет в журнал плагина; документ без адреса вида (srcdoc) моста не получает;
//  3. обход моста: у вида нет ни Node, ни `ipcRenderer`, ни моста окна, документ окна и фреймы соседних групп из вида недоступны, `window.open` не открывает окон;
//  4. привязка к кадру: у каждого кадра вида есть `frameTreeNodeId` и он не меняется ни при pushState, ни при перезагрузке документа.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

interface Harness {
  readonly ev: (expression: string) => Promise<unknown>;
  readonly main: (expression: string) => Promise<unknown>;
  readonly inView: (id: string, expression: string) => Promise<unknown>;
  readonly stderr: () => string;
  readonly stop: () => Promise<void>;
}
interface Cdp {
  readonly launch: (options?: { config?: unknown; args?: string[] }) => Promise<Harness>;
  readonly waitFor: (what: string, probe: () => unknown, timeout?: number) => Promise<unknown>;
  readonly sleep: (ms: number) => Promise<void>;
}
const cdp = (await import(pathToFileURL(path.resolve(import.meta.dirname, '..', '..', 'scripts', 'cdp.mjs')).href)) as Cdp;

interface Reply {
  value?: unknown;
  error?: string;
}

/** executeJavaScript кадра, который в этот момент перезагружается, не отвечает никогда: каждое обращение к виду ограничено по времени. */
const within = <T>(promise: Promise<T>, ms = 5000): Promise<T> => Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`нет ответа за ${String(ms)} мс`)), ms))]);

describe('TR-31: виды на настоящем Electron', () => {
  let app: Harness;
  before(async () => {
    const launched = await cdp.launch({ args: process.platform === 'linux' ? ['--no-sandbox'] : [] });
    app = { ...launched, inView: (id, expression) => within(launched.inView(id, expression)), main: (expression) => within(launched.main(expression), 15_000) };
    await cdp.waitFor('виды alice, bob и echo во фреймах', async () => Number(await app.ev("document.getElementById('tab-views')?.click(), document.querySelectorAll('.views iframe').length")) >= 3, 60_000);
    await cdp.waitFor('вид alice собран', async () => (await app.inView('alice', "document.querySelector('#cyborg-view') !== null")) === true, 30_000);
    await cdp.waitFor('вид echo собран', async () => (await app.inView('echo', "document.querySelector('#cyborg-view') !== null")) === true, 30_000);
  });
  after(async () => {
    await app.stop();
  });

  /** Фреймы видов с номером кадра, процессом рендера и адресом: то, что видит главный процесс. */
  const frames = () =>
    app.main(`(() => {
      const { webContents } = process.mainModule.require('electron');
      const page = webContents.getAllWebContents().find((w) => w.getType() === 'window');
      return page.mainFrame.framesInSubtree.filter((f) => f.parent).map((f) => ({ id: f.frameTreeNodeId, token: f.frameToken, url: f.url, origin: f.origin, parent: f.parent.frameTreeNodeId, pid: f.osProcessId }));
    })()`) as Promise<{ id: number; token: string; url: string; origin: string; parent: number; pid: number }[]>;
  const frameOf = async (plugin: string) => (await frames()).find((f) => f.url.startsWith('cyborg-plugin://') && new URL(f.url).pathname.split('/')[1] === plugin);
  /** Вид называет себя `path` через pushState и просит команду; адрес потом возвращается. */
  const asAt = (plugin: string, location: string, command: string, original: string) =>
    app.inView(plugin, `(async () => { history.pushState({}, '', ${JSON.stringify(location)}); try { return await window.cyborgView.run(${JSON.stringify(command)}); } finally { history.replaceState({}, '', ${JSON.stringify(original)}); } })()`) as Promise<Reply>;
  const journal = () => app.stderr().split('\n').filter((l) => l.startsWith('[plugins]'));

  test('ST-3005/8: pushState на путь соседа по группе личность вида не меняет: кадр alice остаётся alice, команда bob ему не своя', async () => {
    const before = await frameOf('alice');
    assert.ok(before && typeof before.id === 'number', 'у кадра вида есть frameTreeNodeId');
    assert.equal(before.origin, 'cyborg-plugin://duo');
    // Свою команду alice по-прежнему выполняет с любым путём в адресе.
    assert.equal((await asAt('alice', '/bob/', 'alice.hello', '/alice/?view=main')).error, undefined, 'alice, назвавшаяся bob, потеряла свою команду');
    // Команда bob из кадра alice, назвавшегося bob, раньше проходила как команда bob (U-19); теперь кадр - alice, и команда bob не своя.
    assert.match((await asAt('alice', '/bob/', 'bob.hello', '/alice/?view=main')).error ?? '', /не команда плагина alice/, 'кадр alice с адресом bob выполнил команду bob');
    assert.match((await asAt('alice', '/bob/', 'bob.status', '/alice/?view=main')).error ?? '', /не команда плагина alice/);
    // Плагин другой группы и корень: кадр так и остаётся alice, а не «не видом».
    assert.match((await asAt('alice', '/echo/', 'echo.ping', '/alice/?view=main')).error ?? '', /не команда плагина alice/, 'адрес плагина вне группы не сделал кадр echo');
    assert.match((await asAt('alice', '/', 'bob.hello', '/alice/?view=main')).error ?? '', /не команда плагина alice/);
    // Номер кадра при этом не менялся: ни от pushState, ни от возврата адреса.
    const after = await frameOf('alice');
    assert.equal(after.id, before.id);
    assert.equal(after.token, before.token);
  });

  test('ST-3005/8: и наоборот: bob с адресом alice остаётся bob, чужое состояние виду alice не отдаётся', async () => {
    assert.match((await asAt('bob', '/alice/', 'alice.hello', '/bob/?view=main')).error ?? '', /не команда плагина bob/);
    assert.equal((await asAt('bob', '/alice/', 'bob.hello', '/bob/?view=main')).error, undefined);
  });

  test('ST-3005/8: frameTreeNodeId кадра вида стабилен: pushState и перезагрузка документа его не меняют, номера у видов разные, процесс рендера общий у группы', async () => {
    const [alice, bob, echo] = await Promise.all([frameOf('alice'), frameOf('bob'), frameOf('echo')]);
    assert.ok(alice && bob && echo);
    assert.equal(new Set([alice.id, bob.id, echo.id]).size, 3, 'номера кадров разных видов совпали');
    assert.equal(alice.pid, bob.pid, 'группа duo - один процесс рендера');
    assert.notEqual(alice.pid, echo.pid, 'echo в другой группе - другой процесс');
    await app.inView('alice', 'window.__oldDocument = true');
    await app.ev("(() => { const f = document.querySelector('.views [data-plugin=alice] iframe'); f.src = f.src; })()");
    await cdp.waitFor('вид alice перезагружен (новый документ) и собран', async () => (await app.inView('alice', "window.__oldDocument === undefined && document.querySelector('#cyborg-view') !== null")) === true, 20_000);
    const again = await frameOf('alice');
    assert.equal(again?.id, alice.id, 'после перезагрузки документа номер кадра тот же');
    // Перезагруженный документ снова привязан: мост работает.
    assert.equal((await asAt('alice', '/bob/', 'alice.hello', '/alice/?view=main')).error, undefined);
  });

  test('ST-3005/9: чужая страница во фрейме вида: адрес другой группы и внешний адрес блокирует CSP (документ - страница ошибки без origin и без моста), srcdoc создаётся без моста', async () => {
    const nested = (src: string, attribute: 'src' | 'srcdoc' = 'src') =>
      app.inView('alice', `new Promise((resolve) => {
        const csp = [];
        document.addEventListener('securitypolicyviolation', (e) => csp.push(e.violatedDirective + ' ' + e.blockedURI));
        const frame = document.createElement('iframe');
        frame.setAttribute(${JSON.stringify(attribute)}, ${JSON.stringify(src)});
        frame.id = 'probe-nested';
        frame.onload = () => setTimeout(() => resolve({ csp, loaded: true }), 100);
        document.body.append(frame);
        setTimeout(() => resolve({ csp, loaded: false }), 2000);
      })`) as Promise<{ csp: string[]; loaded: boolean }>;
    const cleanup = () => app.inView('alice', "document.getElementById('probe-nested')?.remove(), true");
    /** Вложенные в alice кадры: адрес, origin и что видно из самого документа (`href`, мост, Node). */
    const insideAlice = async () => {
      const aliceId = (await frameOf('alice'))?.id;
      return (await app.main(`(async () => {
        const { webContents } = process.mainModule.require('electron');
        const page = webContents.getAllWebContents().find((w) => w.getType() === 'window');
        const out = [];
        for (const f of page.mainFrame.framesInSubtree) {
          if (!f.parent || f.parent.frameTreeNodeId !== ${String(aliceId)}) continue;
          const seen = await f.executeJavaScript('JSON.stringify({ href: location.href, bridge: typeof window.cyborgView, node: typeof require + typeof process })').catch((e) => String(e));
          out.push({ url: f.url, origin: f.origin, seen });
        }
        return out;
      })()`)) as { url: string; origin: string; seen: string }[];
    };
    for (const src of ['cyborg-plugin://echo/echo/?view=main', 'cyborg-plugin://duo/bob/?view=main', 'https://example.org/', 'data:text/html,%3Cb%3Ex%3C/b%3E']) {
      const result = await nested(src);
      assert.ok(result.csp.some((c) => c.startsWith('frame-src')), `${src}: нарушение frame-src не отчитано: ${JSON.stringify(result)}`);
      const [frame, ...rest] = await insideAlice();
      assert.equal(rest.length, 0);
      // Chromium оставляет заблокированному кадру запрошенный адрес в frame.url, но документ в нём - страница ошибки: origin 'null', моста и Node нет.
      assert.ok(frame, `${src}: кадра нет`);
      assert.equal(frame.origin, 'null', `${src}: у заблокированного кадра есть origin`);
      assert.deepEqual(JSON.parse(frame.seen), { href: 'chrome-error://chromewebdata/', bridge: 'undefined', node: 'undefinedundefined' }, `${src}: в заблокированном кадре есть документ`);
      await cleanup();
    }
    // srcdoc наследует CSP и origin вида, но адреса вида у него нет: мост ему не выдаётся, плагина у кадра нет.
    await nested('<p id="x">внутри</p>', 'srcdoc');
    const [srcdoc] = await insideAlice();
    assert.ok(srcdoc, 'srcdoc-фрейм не создался');
    assert.equal(srcdoc.url, 'about:srcdoc');
    assert.equal(srcdoc.origin, 'cyborg-plugin://duo', 'srcdoc наследует origin вида');
    assert.deepEqual(JSON.parse(srcdoc.seen), { href: 'about:srcdoc', bridge: 'undefined', node: 'undefinedundefined' }, 'во вложенном документе появился мост или Node');
    await cleanup();
  });

  test('ST-3005/9: уход самого фрейма вида на чужую группу, внешний адрес и data: отклонён и записан в журнал плагина; фрейм остаётся на своём виде', async () => {
    for (const target of ['cyborg-plugin://echo/echo/?view=main', 'https://example.org/away', 'data:text/html,%3Cb%3Ex%3C/b%3E']) {
      await app.inView('alice', `location.href = ${JSON.stringify(target)}; true`);
      await cdp.waitFor(`отказ перехода на ${target} записан`, () => journal().some((l) => l.includes('"pluginId":"alice","kind":"denied","method":"navigate"') && l.includes(target)), 15_000);
    }
    assert.equal(await app.inView('alice', 'location.pathname'), '/alice/', 'фрейм alice ушёл со своего адреса');
    assert.equal(await app.inView('alice', "typeof window.cyborgView.run"), 'function', 'после отказов мост на месте');
  });

  test('ST-3005/9: обход моста из вида: нет Node, ipcRenderer, моста окна и электрона; документ окна и вид другой группы недоступны; window.open окон не открывает', async () => {
    const probe = (await app.inView(
      'alice',
      `(() => {
        const tried = (f) => { try { return String(f()); } catch (e) { return 'исключение ' + e.name; } };
        return {
          node: [typeof require, typeof process, typeof module, typeof Buffer, typeof global].join(','),
          electron: [typeof ipcRenderer, typeof electron, typeof window.electron, typeof window.ipcRenderer].join(','),
          windowApi: [typeof window.playground, typeof window.cyborgWindow, tried(() => typeof window.parent.playground)].join(','),
          parentDocument: tried(() => window.parent.document.title),
          topLocation: tried(() => window.top.location.href),
          sibling: tried(() => window.parent.frames[2].document.title),
          openWindow: tried(() => window.open('cyborg-plugin://duo/alice/') === null),
          bridge: Object.keys(window.cyborgView).sort().join(','),
          frozen: [Object.isFrozen(window.cyborgView), tried(() => { window.cyborgView.run = () => 'подмена'; return window.cyborgView.run.toString().includes('подмена'); })].join(','),
          fileFetch: undefined,
        };
      })()`,
    )) as Record<string, string | undefined>;
    assert.equal(probe.node, 'undefined,undefined,undefined,undefined,undefined');
    assert.equal(probe.electron, 'undefined,undefined,undefined,undefined');
    assert.match(probe.windowApi ?? '', /^undefined,undefined,/, 'вид получил мост окна');
    assert.match(probe.parentDocument ?? '', /исключение SecurityError/, 'вид читает DOM документа окна');
    assert.match(probe.topLocation ?? '', /исключение SecurityError/);
    assert.match(probe.sibling ?? '', /исключение SecurityError/, 'вид читает DOM фрейма соседней группы');
    assert.equal(probe.openWindow, 'true', 'window.open вернул окно');
    const windows = await app.main("process.mainModule.require('electron').BrowserWindow.getAllWindows().length");
    assert.equal(windows, 1, 'вид открыл новое окно');
    // Файл со своего диска и сеть из вида закрыты CSP: connect-src 'self'.
    const fetches = (await app.inView(
      'alice',
      `Promise.all(['file:///etc/hosts', 'https://example.org/', 'cyborg-plugin://echo/echo/ui/ui.js'].map((u) => fetch(u).then((r) => 'ответ ' + r.status, (e) => 'отказ ' + e.name)))`,
    )) as string[];
    assert.deepEqual(fetches.map((f) => f.split(' ')[0]), ['отказ', 'отказ', 'отказ'], `fetch мимо origin: ${JSON.stringify(fetches)}`);
  });

  test('ST-3005/9: вид читает файлы соседа по группе (граница доверия - группа), но не вида другой группы', async () => {
    const own = (await app.inView('alice', "fetch('/alice/ui/ui.js').then((r) => r.status)")) as number;
    const neighbour = (await app.inView('alice', "fetch('/bob/ui/ui.js').then((r) => r.status)")) as number;
    const foreign = (await app.inView('alice', "fetch('cyborg-plugin://echo/echo/ui/ui.js').then((r) => r.status, () => 0)")) as number;
    assert.equal(own, 200);
    // Сосед по группе открыт: те же origin и процесс рендера; это и есть граница доверия группы (SAD 3.8), сторонний плагин всегда в своей группе.
    assert.equal(neighbour, 200, 'файлы соседа по группе недоступны: граница доверия сместилась');
    assert.equal(foreign, 0, 'вид читает файл плагина другой группы');
  });
});
