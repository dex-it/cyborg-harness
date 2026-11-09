// Пилот PL-05: Monaco и xterm во фреймах на cyborg-plugin://. Нужен собранный playground и дисплей (на Linux - xvfb-run ... --no-sandbox).
//   node playground/scripts/spike-monaco.mjs [csp] [sandbox] [memory] [--csp="<строка>"] [--json] [--no-sandbox]
// csp: наборы директив CSP вида и что с ними делают Monaco и xterm; sandbox: кадр без allow-same-origin; memory: память и время открытия.
// Без перечня разделов идут все. Результат - таблицы в stdout (docs/04-verification/spike-monaco-xterm.md) или JSON.
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { pssKb } from '../src/main/proc-memory.ts';
import { launch, repo, sleep, waitFor } from './cdp.mjs';

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const only = argv.filter((a) => ['csp', 'sandbox', 'memory'].includes(a));
const wanted = (name) => only.length === 0 || only.includes(name);
const custom = argv.find((a) => a.startsWith('--csp='))?.slice('--csp='.length);
const electronArgs = argv.filter((a) => a === '--no-sandbox');
const mac = process.platform === 'darwin';
const mb = (kb) => (kb === undefined ? undefined : Math.round(kb / 1024));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const BASE = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'";
/** Что проверяем: текущая VIEW_CSP, закрытая с явными источниками и её урезания по одной директиве. */
const CASES = [
  { name: 'VIEW_CSP сейчас', csp: undefined },
  { name: 'закрытая: script, style+inline, img+data, font', csp: BASE },
  { name: 'закрытая + worker-src self', csp: `${BASE}; worker-src 'self'` },
  { name: 'без font-src', csp: BASE.replace("; font-src 'self'", '') },
  { name: 'без img-src data:', csp: BASE.replace(' data:', '') },
  { name: "style-src без 'unsafe-inline'", csp: BASE.replace(" 'unsafe-inline'", '') },
  { name: 'worker-src blob: вместо файлов', csp: `${BASE}; worker-src blob:` },
  ...(custom === undefined ? [] : [{ name: 'своя (--csp)', csp: custom }]),
];

const states = (h, expected) => h.ev(`${JSON.stringify(expected)}.every((id) => document.querySelector('#plugins-list [data-plugin="' + id + '"]')?.dataset.state === 'active')`);

/** Окно открыто на вкладке «Виды»: во вкладках, которых не видно, у фреймов нет размера и Monaco ничего не рисует. */
async function showViews(h) {
  await waitFor('вкладка «Виды»', () => h.ev("document.getElementById('tab-views')?.click(), !!document.getElementById('tab-views')"));
}

/** Нарушения CSP в консоли окна: слушатель ставится в главном процессе, окно перезагружается, чтобы увидеть и ранние. */
async function watchConsole(h) {
  await h.main(`(() => {
    const { webContents } = process.mainModule.require('electron');
    const page = webContents.getAllWebContents().find((w) => w.getType() === 'window');
    globalThis.pilotLog = [];
    page.on('console-message', (e, ...rest) => globalThis.pilotLog.push(String(e.message ?? rest[1])));
  })()`);
  await h.ev.send('Page.reload');
  await sleep(500);
}

const consoleCsp = async (h) => {
  const lines = await h.main('globalThis.pilotLog');
  const directives = lines.flatMap((l) => /Content Security Policy directive:? ["']([a-z-]+)/.exec(l)?.slice(1) ?? []);
  return [...new Set(directives)].sort().join(',');
};

async function runCase({ name, csp }) {
  const h = await launch({ args: [...(csp === undefined ? [] : [`--view-csp=${csp}`]), ...electronArgs] });
  const row = { name, csp: csp ?? "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: (VIEW_CSP)" };
  try {
    await waitFor('плагины работают', () => states(h, ['sessions', 'editor', 'agent-shell']), 60_000);
    await watchConsole(h);
    await showViews(h);
    row.mounted = await waitFor('вид editor смонтирован', () => h.inView('editor', "document.getElementById('cyborg-view').dataset.mountMs ?? ''"), 10_000).then(() => true, () => false);
    row.opened = await waitFor('файл открыт', async () => /settings\.json: открыт/.test(await h.inView('editor', "document.getElementById('editor-state')?.textContent ?? ''")), 10_000).then(() => true, () => false);
    await sleep(1500);
    if (row.opened) {
      const info = await h.inView(
        'editor',
        `(async () => {
          const d = document.getElementById('cyborg-view').dataset;
          const fonts = await document.fonts.load('16px codicon').then((f) => f.length, () => -1);
          const classes = new Set([...document.querySelectorAll('.view-line span span')].map((s) => s.className));
          return { workers: d.workers ?? '', violations: d.violations ?? '', fonts, tokenClasses: classes.size, lines: document.querySelectorAll('.view-line').length };
        })()`,
      );
      Object.assign(row, info);
      const openFile = async (file) => {
        await h.inView('editor', `document.querySelector('cy-button[data-file="${file}"]').click()`);
        await waitFor(`${file} открыт`, async () => (await h.inView('editor', "document.getElementById('editor-state').textContent")).startsWith(`${file}: открыт`), 10_000);
      };
      // Файлы с ошибками: маркер приходит только из воркера языка, поэтому ввод с клавиатуры не нужен.
      const markerFrom = (owner, timeout) => waitFor(`маркер ${owner}`, async () => (await h.inView('editor', "document.getElementById('cyborg-view').dataset.markers ?? ''")).includes(`${owner}:`), timeout).then(() => true, () => false);
      await openFile('broken.json');
      row.jsonMarker = await markerFrom('json', 8000);
      if (csp === undefined || csp === BASE) {
        await openFile('sample.ts');
        row.tsMarker = await markerFrom('typescript', 25_000);
      }
    }
    await h.inView('sessions', "document.querySelector('#agents cy-button[data-agent=\"shell\"]').click()");
    row.xtermSession = await waitFor('сессия shell', async () => /^Оболочка: pid \d+$/.test(await h.inView('sessions', "document.getElementById('session-state').textContent")), 10_000).then(() => true, () => false);
    if (row.xtermSession) {
      await h.inView('sessions', `(() => { const l = document.getElementById('line'); l.value = 'echo агент-$((5*5))'; l.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); })()`);
      row.xterm = await waitFor('вывод в xterm', async () => /агент-25/.test(await h.inView('sessions', "[...document.querySelectorAll('#screen .xterm-rows > div')].map((d) => d.textContent).join('\\n')")), 8000).then(() => true, () => false);
    } else row.xterm = false;
    row.blocked = await consoleCsp(h);
    // Воркер из blob: - то, что Monaco делает без MonacoEnvironment; CSP вида должна его отклонить.
    if (row.opened) row.blobWorker = await h.inView('editor', `new Promise((resolve) => {
      const w = new Worker(URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' })));
      w.onmessage = () => resolve('работает');
      w.onerror = () => resolve('отклонён');
      setTimeout(() => resolve('молчит'), 1500);
    })`);
  } catch (error) {
    row.error = error instanceof Error ? error.message : String(error);
  } finally {
    await h.stop();
  }
  return row;
}

/** Кадр с `sandbox` без allow-same-origin: что с ним делают мост и модуль вида. */
async function runSandbox() {
  const h = await launch({ args: electronArgs });
  const results = [];
  try {
    await waitFor('плагины работают', () => states(h, ['sessions', 'editor']), 60_000);
    await watchConsole(h);
    await showViews(h);
    await waitFor('вид editor смонтирован', () => h.inView('editor', "document.getElementById('cyborg-view')?.dataset.mountMs ?? ''"), 10_000);
    // Последняя строка - не sandbox, а атрибут allow: пускает ли политика разрешений navigator.clipboard из кадра вида.
    for (const [plugin, sandbox, allow] of [['editor', 'allow-scripts'], ['sessions', 'allow-scripts'], ['editor', 'allow-scripts allow-same-origin'], ['sessions', 'allow-scripts allow-same-origin'], ['sessions', '', 'clipboard-read; clipboard-write'], ['sessions', '', '']]) {
      const tag = `sbx${String(results.length)}`;
      const before = (await h.main('globalThis.pilotLog.length')) ?? 0;
      await h.ev(`(() => { const f = document.createElement('iframe'); if (${JSON.stringify(sandbox)}) f.sandbox = ${JSON.stringify(sandbox)}; if (${JSON.stringify(allow ?? '')}) f.allow = ${JSON.stringify(allow ?? '')}; f.src = 'cyborg-plugin://${plugin}/?${tag}=1'; f.style.cssText = 'position:fixed;left:0;top:0;width:700px;height:500px;z-index:99'; f.id = ${JSON.stringify(tag)}; document.body.append(f); })()`);
      await sleep(7000);
      const probe = `(async () => {
        const out = { origin: location.origin, bridge: typeof window.cyborgView, mounted: !!document.querySelector('#cyborg-view > *') };
        try { localStorage.setItem('k', 'v'); out.localStorage = 'работает'; } catch (e) { out.localStorage = e.name; }
        try { out.indexedDB = typeof indexedDB.open === 'function' ? 'есть' : 'нет'; await new Promise((res, rej) => { const r = indexedDB.open('pilot'); r.onsuccess = res; r.onerror = () => rej(r.error); }); } catch (e) { out.indexedDB = e.name; }
        out.editor = document.getElementById('editor-state')?.textContent ?? null;
        out.screen = !!document.querySelector('.xterm') || !!document.querySelector('.monaco-editor');
        out.text = document.body.innerText.replace(/\\s+/g, ' ').slice(0, 140);
        out.agents = document.querySelectorAll('#agents cy-button').length;
        try { await navigator.clipboard.writeText('pilot'); out.clipboard = 'записал'; } catch (e) { out.clipboard = e.name; }
        return out;
      })()`;
      const found = await h.main(`(async () => {
        const { webContents } = process.mainModule.require('electron');
        const page = webContents.getAllWebContents().find((w) => w.getType() === 'window');
        const frame = page.mainFrame.framesInSubtree.find((f) => f.url.includes(${JSON.stringify(tag + '=1')}));
        if (!frame) return null;
        return Promise.race([frame.executeJavaScript(${JSON.stringify(probe)}), new Promise((r) => setTimeout(() => r('проба не ответила'), 5000))]);
      })()`);
      const log = (await h.main('globalThis.pilotLog')).slice(before);
      results.push({ plugin, sandbox: sandbox || (allow ? `allow=${allow}` : 'без атрибутов'), frame: found, console: [...new Set(log.map((l) => l.slice(0, 160)))].slice(0, 4) });
      await h.ev(`document.getElementById(${JSON.stringify(tag)}).remove()`);
    }
  } catch (error) {
    results.push({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    await h.stop();
  }
  return results;
}

/** Память и время открытия: окно без вида editor и с ним, по три запуска. */
async function runMemory() {
  const plugins = ['echo', 'chat', 'alice', 'bob', 'flaky', 'later', 'agent-claude-code', 'agent-shell', 'session-isolation', 'next-actions', 'sessions', 'pin-lock'];
  const hosts = { a: ['echo'], b: ['chat'], c: ['alice', 'bob'], d: ['flaky'], agents: ['agent-claude-code', 'agent-shell', 'session-isolation', 'next-actions'] };
  const runs = [];
  for (const withEditor of [false, true, false, true, false, true]) {
    const h = await launch({ config: { plugins: { enabled: withEditor ? [...plugins, 'editor'] : plugins, hosts } }, args: electronArgs });
    try {
      await waitFor('плагины работают', () => states(h, ['sessions', 'agent-shell', ...(withEditor ? ['editor'] : [])]), 60_000);
      await showViews(h);
      await waitFor('кнопка агента shell', () => h.inView('sessions', "(() => { const b = document.querySelector('#agents cy-button[data-agent=\"shell\"]'); b?.click(); return !!b && !b.disabled; })()"), 15_000);
      await waitFor('сессия shell', async () => /^Оболочка: pid \d+$/.test(await h.inView('sessions', "document.getElementById('session-state').textContent")), 15_000);
      if (withEditor) await waitFor('файл открыт', async () => (await h.inView('editor', "document.getElementById('cyborg-view').dataset.openedMs ?? ''")) !== '', 20_000);
      await sleep(4000);
      const procs = await h.main(`(() => {
        const { app, webContents } = process.mainModule.require('electron');
        const page = webContents.getAllWebContents().find((w) => w.getType() === 'window');
        const of = (origin) => page.mainFrame.framesInSubtree.find((f) => f.origin === origin)?.osProcessId ?? null;
        return { all: app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type })), editor: of('cyborg-plugin://editor'), sessions: of('cyborg-plugin://sessions') };
      })()`);
      const total = procs.all.reduce((sum, p) => sum + (pssKb(p.pid) ?? 0), 0);
      runs.push({
        withEditor,
        processes: procs.all.length,
        totalMb: mb(total),
        editorProcessMb: procs.editor === null ? undefined : mb(pssKb(procs.editor)),
        sessionsProcessMb: procs.sessions === null ? undefined : mb(pssKb(procs.sessions)),
        editorMountMs: withEditor ? Number(await h.inView('editor', "document.getElementById('cyborg-view').dataset.mountMs")) : undefined,
        editorOpenedMs: withEditor ? Number(await h.inView('editor', "document.getElementById('cyborg-view').dataset.openedMs")) : undefined,
      });
    } catch (error) {
      runs.push({ withEditor, error: error instanceof Error ? error.message : String(error) });
    } finally {
      await h.stop();
    }
  }
  const pick = (flag, key) => median(runs.filter((r) => r.withEditor === flag && r[key] !== undefined).map((r) => r[key]));
  const dist = join(repo, 'playground', 'dist', 'plugins', 'editor', 'ui');
  const size = (file) => Math.round(statSync(join(dist, file)).size / 1024);
  return {
    metric: mac ? 'footprint' : 'PSS',
    runs,
    summary: {
      totalWithoutEditorMb: pick(false, 'totalMb'),
      totalWithEditorMb: pick(true, 'totalMb'),
      editorProcessMb: pick(true, 'editorProcessMb'),
      sessionsProcessMb: pick(true, 'sessionsProcessMb'),
      editorMountMs: pick(true, 'editorMountMs'),
      editorOpenedMs: pick(true, 'editorOpenedMs'),
    },
    bundlesKb: { 'ui.js': size('ui.js'), 'ui.css': size('ui.css'), 'editor.worker': size('workers/editor.worker.js'), 'json.worker': size('workers/json.worker.js'), 'ts.worker': size('workers/ts.worker.js'), 'css.worker': size('workers/css.worker.js'), 'html.worker': size('workers/html.worker.js') },
  };
}

const result = {};
if (wanted('csp')) {
  result.csp = [];
  for (const c of CASES) result.csp.push(await runCase(c));
}
if (wanted('sandbox')) result.sandbox = await runSandbox();
if (wanted('memory')) result.memory = await runMemory();

if (json) console.log(JSON.stringify(result, null, 2));
else {
  const yes = (v) => (v === undefined ? '-' : v ? 'да' : 'нет');
  if (result.csp) {
    console.log('CSP: набор | вид смонтирован | файл открыт | классов токенов | воркеры | json-маркер от воркера | ts-маркер от воркера | codicon.ttf | xterm | blob-воркер | нарушены директивы');
    for (const r of result.csp) console.log(`  ${r.name} | ${yes(r.mounted)} | ${yes(r.opened)} | ${r.tokenClasses ?? '-'} | ${r.workers || '-'} | ${yes(r.jsonMarker)} | ${yes(r.tsMarker)} | ${r.fonts === undefined ? '-' : r.fonts > 0 ? 'загружен' : 'нет'} | ${yes(r.xterm)} | ${r.blobWorker ?? '-'} | ${r.blocked || '-'}${r.error ? ` | ОШИБКА ${r.error}` : ''}`);
  }
  if (result.sandbox) {
    console.log('\nsandbox: плагин | sandbox | origin кадра | мост | вид собран | localStorage | indexedDB | clipboard | консоль');
    for (const r of result.sandbox) console.log(r.error ? `  ОШИБКА ${r.error}` : `  ${r.plugin} | ${r.sandbox} | ${r.frame?.origin ?? '-'} | ${r.frame?.bridge ?? '-'} | ${yes(r.frame?.mounted)} | ${r.frame?.localStorage ?? '-'} | ${r.frame?.indexedDB ?? '-'} | ${r.frame?.clipboard ?? '-'} | ${r.console.join(' // ') || '-'}`);
  }
  if (result.memory) {
    console.log(`\nПамять (${result.memory.metric}) и время, медиана из трёх запусков:`);
    console.log(JSON.stringify(result.memory.summary, null, 2));
    console.log('Размеры сборки, КБ:', JSON.stringify(result.memory.bundlesKb));
    for (const r of result.memory.runs) console.log(' ', JSON.stringify(r));
  }
}
process.exitCode = 0;
