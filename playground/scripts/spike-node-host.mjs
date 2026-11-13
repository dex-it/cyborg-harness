// Спайк TR-20: хост плагинов как процесс Node под --permission с пустым env против utilityProcess. Отчёт и вердикт - docs/05-verification/spike-node-host.md.
// Три части: (1) замеры в Electron на ядре приложения (старт, память, вызов, ctx.os, поток, пинг, сторож, клонирование) - src/main/spike-node-host.ts;
// (2) способы загрузки проверенных байтов - spike-node-host-load.mjs; (3) размер, подпись и фьюз RunAsNode - spike-node-host-binary.mjs.
// Запуск: npm run spike:node-host [-- --json] [--node-bin=<node>] [--no-sandbox]; на Linux - xvfb-run ... --no-sandbox. Нужен собранный playground (npm run build).
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { binaryFacts } from './spike-node-host-binary.mjs';
import { loadExperiment } from './spike-node-host-load.mjs';
import { createRequire } from 'node:module';

const repo = resolve(import.meta.dirname, '..', '..');
const argv = process.argv.slice(2);
const json = argv.includes('--json');
const nodeBin = argv.find((a) => a.startsWith('--node-bin='))?.slice('--node-bin='.length) ?? process.execPath;
const electronArgs = argv.filter((a) => a === '--no-sandbox');
const only = argv.find((a) => a.startsWith('--only='))?.slice('--only='.length);
// Бюджеты шлюза меряются медианой трёх прогонов (playground/budgets.json): замер повторяется, в отчёт идёт медиана каждой ячейки; сырые прогоны - в поле `runs` JSON.
const runs = Number(argv.find((a) => a.startsWith('--runs='))?.slice('--runs='.length) ?? 1);

const median = (xs) => {
  const sorted = xs.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
/** Медиана по прогонам для каждого числа отчёта; нечисловые значения берутся из первого прогона. Формы отчётов совпадают (те же режимы, строки, порядок). */
function medianOf(reports, path = []) {
  const at = (r) => path.reduce((node, key) => node?.[key], r);
  const own = reports.map(at);
  const value = at(reports[0]);
  if (typeof value === 'number') return median(own.filter((x) => typeof x === 'number' && !Number.isNaN(x)));
  if (Array.isArray(value)) return value.map((_, i) => medianOf(reports, [...path, i]));
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).map((key) => [key, medianOf(reports, [...path, key])]));
  return value;
}

const dir = mkdtempSync(join(tmpdir(), 'cyborg-spike-node-host-'));
const out = join(dir, 'node-host.json');
let code = 0;
let measured;
let rawRuns;
if (only === undefined || only === 'measure') {
  rawRuns = [];
  for (let i = 0; i < runs; i++) {
    const app = spawn(join(repo, 'node_modules', '.bin', 'electron'), [repo, `--spike-node-host=${out}`, `--node-bin=${nodeBin}`, `--user-data-dir=${join(dir, 'data')}`, ...electronArgs], { stdio: ['ignore', 'inherit', 'inherit'] });
    code ||= await new Promise((r) => app.once('exit', r));
    rawRuns.push(JSON.parse(readFileSync(out, 'utf8')));
  }
  measured = runs === 1 ? rawRuns[0] : medianOf(rawRuns);
}
const loading = only === undefined || only === 'load' ? [await loadExperiment(nodeBin), await loadExperiment(createRequire(import.meta.url)('electron'), { electronAsNode: true })] : undefined;
const binaries = only === undefined || only === 'binary' ? await binaryFacts({ nodeBin }) : undefined;
rmSync(dir, { recursive: true, force: true });

const report = { measured, runs: runs > 1 ? rawRuns : undefined, loading, binaries };
if (json) console.log(JSON.stringify(report, null, 2));
else {
  if (measured) {
    console.log(`Electron ${measured.electron}, Node ${measured.node}, ${measured.platform}-${measured.arch}, ${measured.cpus}; бинарник Node: ${measured.nodeBin ?? '-'} (${measured.nodeBinVersion ?? '-'})`);
    for (const m of measured.modes) {
      console.log(`\n== ${m.mode}: ${m.description}`);
      if (m.probeOnly) console.log(`  НЕ СТАРТУЕТ: ${m.probeOnly}`);
      if (m.error) console.log(`  ОШИБКА: ${m.error}`);
      if (m.starts) console.log(`  старт хоста до activated, мс: p50 ${m.starts.p50Ms} | p95 ${m.starts.p95Ms} | max ${m.starts.maxMs} (n=${m.starts.samples})`);
      for (const r of m.memory ?? []) console.log(`  память: хостов ${r.hosts} | PSS (macOS: footprint) ${r.pssMb ?? '-'} МБ | RSS ${r.rssMb ?? '-'} МБ | на хост ${r.pssPerHostMb ?? '-'} МБ`);
      for (const c of m.calls ?? []) console.log(`  вызов: ${c.path} | ${c.sizeBytes} Б | p50 ${c.p50} | p95 ${c.p95} | p99 ${c.p99} мс`);
      for (const o of m.os ?? []) console.log(`  ctx.os.fs.readText: ${o.sizeBytes} Б | p50 ${o.p50} | p95 ${o.p95} | p99 ${o.p99} мс`);
      for (const s of m.streams ?? []) console.log(`  поток: ${s.path} | ${s.chunks} x ${s.chunkBytes} | ${s.ms} мс | ${s.mbps} МиБ/с`);
      for (const p of m.ping ?? []) console.log(`  пинг в занятый хост: блок ${p.blockMs} мс -> ответ ${p.pingDuringMs} мс`);
      for (const w of m.work ?? []) console.log(`  синхронная работа: ${w.work} | ${w.ms} мс | ${w.detail || '-'}`);
      for (const w of m.watchdog ?? []) console.log(`  сторож ${w.watchdog} | ${w.failure} | обнаружение ${w.detectMs} мс | перезапуск ${w.restartMs} мс`);
      for (const c of m.clone ?? []) console.log(`  клонирование: ${c.value} -> ${c.outcome}`);
    }
  }
  for (const r of loading ?? []) {
    console.log(`\n== загрузка проверенных байтов: ${r.version} (${r.binary})`);
    for (const row of r.rows) console.log(`  ${row.mode} | под --permission: ${row.confined ? 'да' : 'нет'} | ${row.result ?? `ОТКАЗ ${row.error}`} | ${row.ms ?? '-'} мс`);
  }
  if (binaries) console.log(`\n== бинарники\n${JSON.stringify(binaries, null, 2)}`);
}
process.exitCode = code === 0 && !measured?.modes.some((m) => m.error) ? 0 : 1;
