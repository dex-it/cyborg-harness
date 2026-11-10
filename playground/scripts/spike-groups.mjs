// Замер K-04: память при десяти видах, десять разных групп рендера против одной общей. Нужен собранный playground и дисплей (на Linux - xvfb-run ... --no-sandbox).
//   node playground/scripts/spike-groups.mjs [--json] [--no-sandbox] [--runs=3]
// Десять плагинов с одним видом каждый кладутся в playground/dist/plugins (поставка, сторонний общую группу не получает) и убираются в конце; в «общей» группе их собирает plugins.uiGroups.
// Виды идут настоящим путём: протокол cyborg-plugin://<группа>/<плагин>/, оболочка, мост. Результат - таблица (docs/05-verification/spike-render-groups.md) или JSON.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pssKb } from '../src/main/proc-memory.ts';
import { launch, repo, sleep, waitFor } from './cdp.mjs';

const argv = process.argv.slice(2);
const json = argv.includes('--json');
const electronArgs = argv.filter((a) => a === '--no-sandbox');
const runsPerVariant = Number(argv.find((a) => a.startsWith('--runs='))?.slice('--runs='.length) ?? 3);
const mac = process.platform === 'darwin';
const mb = (kb) => Math.round((kb ?? 0) / 1024);
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const IDS = Array.from({ length: 10 }, (_, i) => `probe${i}`);

const PLUGINS = join(repo, 'playground', 'dist', 'plugins');

/** Десять плагинов в каталоге поставки: манифест, пустая главная часть и вид из одной строки. */
function makeProbes() {
  for (const id of IDS) {
    const dir = join(PLUGINS, id);
    mkdirSync(join(dir, 'ui'), { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ id, version: '1.0.0', engines: { cyborg: '^1' }, ui: { views: { main: './ui/ui.js' } } }));
    writeFileSync(join(dir, 'index.mjs'), 'export default { activate() {} };\n');
    writeFileSync(join(dir, 'ui', 'ui.js'), `export function mount(root) { root.textContent = '${id}'; return { dispose() {} }; }\n`);
  }
}

const VARIANTS = [
  { name: 'десять групп (по плагину)', plugins: { enabled: IDS } },
  { name: 'одна общая группа', plugins: { enabled: IDS, uiGroups: { all: IDS } } },
];

async function once(variant) {
  const h = await launch({ config: { plugins: variant.plugins }, args: electronArgs });
  try {
    await waitFor('десять видов во фреймах', async () => (await h.ev("document.getElementById('tab-views')?.click(), document.querySelectorAll('.views iframe').length")) === 10, 60_000);
    await waitFor('виды собраны', async () => {
      const ready = await Promise.all(IDS.map((id) => h.inView(id, "document.querySelector('#cyborg-view')?.textContent ?? ''")));
      return ready.every((t, i) => t === IDS[i]);
    }, 60_000);
    await sleep(4000);
    const info = await h.main(`(() => {
      const { app, webContents } = process.mainModule.require('electron');
      const page = webContents.getAllWebContents().find((w) => w.getType() === 'window');
      const frames = page.mainFrame.framesInSubtree.filter((f) => f.url.startsWith('cyborg-plugin://'));
      return { all: app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type })), frames: frames.map((f) => f.osProcessId), origins: [...new Set(frames.map((f) => f.origin))].length };
    })()`);
    const total = info.all.reduce((sum, p) => sum + (pssKb(p.pid) ?? 0), 0);
    return { processes: info.all.length, frameProcesses: new Set(info.frames).size, origins: info.origins, totalMb: mb(total) };
  } finally {
    await h.stop();
  }
}

makeProbes();
const results = [];
try {
  for (let i = 0; i < runsPerVariant; i++) {
    for (const variant of VARIANTS) {
      try {
        results.push({ variant: variant.name, ...(await once(variant)) });
      } catch (error) {
        results.push({ variant: variant.name, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
} finally {
  for (const id of IDS) rmSync(join(PLUGINS, id), { recursive: true, force: true });
}
const summary = VARIANTS.map((v) => {
  const ok = results.filter((r) => r.variant === v.name && r.error === undefined);
  return { variant: v.name, runs: ok.length, processes: median(ok.map((r) => r.processes)), frameProcesses: median(ok.map((r) => r.frameProcesses)), origins: median(ok.map((r) => r.origins)), totalMb: median(ok.map((r) => r.totalMb)) };
});
if (json) console.log(JSON.stringify({ metric: mac ? 'footprint' : 'PSS', results, summary }, null, 2));
else {
  console.log(`Метрика: ${mac ? 'footprint (macOS)' : 'PSS'}; запусков на вариант: ${runsPerVariant}\n`);
  console.log('Вариант | запусков | процессов | процессов у видов | origin | сумма по процессам, МБ (медиана)');
  for (const s of summary) console.log(`  ${s.variant} | ${s.runs} | ${s.processes} | ${s.frameProcesses} | ${s.origins} | ${s.totalMb}`);
  for (const r of results.filter((x) => x.error)) console.log(`  ОШИБКА ${r.variant}: ${r.error}`);
}
process.exitCode = results.some((r) => r.error) ? 1 : 0;
