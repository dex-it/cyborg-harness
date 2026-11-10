// Замер шлюза ctx.os (T-07) на собранном playground; бюджет сверяется с медианой p99 цены за --runs прогонов; на Linux - xvfb-run ... --no-sandbox.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..', '..');
const OWN = /^--(budget|watch-budget|runs|trace)=/;
const own = (a) => a === '--json' || OWN.test(a);
const json = process.argv.includes('--json');
const option = (name, fallback) => {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const value = raw === undefined ? fallback : Number(raw);
  if (!(value > 0)) throw new Error(`--${name}: число больше нуля`);
  return value;
};
/** Вызов через шлюз, мс на p99. */
const budget = option('budget', 1);
/** Событие fs.watch, мс на p99 сверх окна склейки: событие ждёт склейку по замыслу, и порог вызова ему не подходит. */
const watchBudget = option('watch-budget', 5);
/** Одиночный p99 на 300 вызовах прыгает между прогонами вдвое - бюджет сверяется с медианой. */
const runs = option('runs', 3);
/** Трасса операций ядра (K-28, NFR-CH-4001): по умолчанию включена, бюджет держится с ней; `--trace=off` даёт базу для сравнения. */
const trace = process.argv.find((a) => a.startsWith('--trace='))?.slice('--trace='.length) ?? 'on';
if (trace !== 'on' && trace !== 'off') throw new Error('--trace: on или off');
if (!Number.isInteger(runs)) throw new Error('--runs: целое число прогонов');
/** Склейка событий fs.watch в шлюзе (WATCH_COALESCE_MS): задержка по замыслу, в цену шлюза не входит. */
const WATCH_COALESCE_MS = 50;
/** Бюджет - на размеры таблицы «Вызов» spike-hosts.md; файл в 1 МиБ меряется справочно, его цена - копирование по каналу хоста. */
const BUDGET_MAX_BYTES = 65536;

async function measureOnce() {
  const dir = mkdtempSync(join(tmpdir(), 'cyborg-spike-gateway-'));
  const out = join(dir, 'gateway.json');
  try {
    const app = spawn(join(repo, 'node_modules', '.bin', 'electron'), [repo, `--spike-gateway=${out}`, `--user-data-dir=${join(dir, 'data')}`, `--gateway-trace=${trace}`, ...process.argv.slice(2).filter((a) => !own(a))], { stdio: ['ignore', 'inherit', 'inherit'] });
    const code = await new Promise((r) => app.once('exit', r));
    return { code, ...JSON.parse(readFileSync(out, 'utf8')) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const round = (n) => Math.round(n * 1000) / 1000;
const median = (xs) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length === 0 ? NaN : s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
/** Цена шлюза - вычитанием из p99 вызова p99 голого действия; у fs.watch ещё и окно склейки. */
function costsOf(r) {
  const find = (path, variant, size) => r.rows?.find((x) => x.path === path && x.variant === variant && x.sizeBytes === size);
  return (r.rows ?? [])
    .filter((x) => x.variant === 'голое')
    .map((bare) => {
      const lag = bare.path === 'fs.watch' ? WATCH_COALESCE_MS : 0;
      const of = (variant) => round((find(bare.path, variant, bare.sizeBytes)?.p99 ?? NaN) - bare.p99 - lag);
      return { path: bare.path, sizeBytes: bare.sizeBytes, gatewayP99: of('шлюз'), pluginP99: of('плагин') };
    });
}

const results = [];
for (let i = 0; i < runs; i++) results.push(await measureOnce());
const last = results.at(-1);
const perRun = results.map(costsOf);
const costs = perRun[0].map((c) => {
  const same = perRun.map((cs) => cs.find((x) => x.path === c.path && x.sizeBytes === c.sizeBytes));
  const limit = c.path === 'fs.watch' ? watchBudget : budget;
  const pluginP99 = round(median(same.map((x) => x?.pluginP99 ?? NaN)));
  const gatewayP99 = round(median(same.map((x) => x?.gatewayP99 ?? NaN)));
  // Ветка net.fetch с проверкой адреса из плагина не мерится (шлюз отверг бы 127.0.0.1 под именем): бюджет сверяется по цене транспорта с проверкой.
  const gated = Number.isFinite(pluginP99) ? pluginP99 : gatewayP99;
  return {
    path: c.path,
    sizeBytes: c.sizeBytes,
    limitMs: limit,
    gatewayP99,
    pluginP99,
    pluginP99Runs: same.map((x) => x?.pluginP99 ?? NaN),
    over: c.sizeBytes <= BUDGET_MAX_BYTES && !(gated <= limit),
  };
});
const failed = costs.filter((c) => c.over);
const errors = results.flatMap((r, i) => (r.code !== 0 || r.error ? [`прогон ${String(i + 1)}: ${r.error ?? `код ${String(r.code)}`}`] : []));

if (json) console.log(JSON.stringify({ budgetMs: budget, watchBudgetMs: watchBudget, trace, runs: results, costs }, null, 2));
else {
  console.log(`Electron ${last.electron}, Node ${last.node}, ${last.platform} ${last.arch}, ${last.cpus}; safeStorage ${last.secretsBackend}; трасса ${trace === 'on' ? `включена (записей в последнем прогоне: ${String(last.traceRecords)})` : 'выключена'}; ${String(runs)} прогонов по ${last.samples} вызовов после ${last.warmup} разогревочных\n`);
  console.log('Последний прогон: путь | вариант | байт | первый | p50 | p95 | p99, мс');
  for (const x of last.rows ?? []) console.log(`  ${x.path} | ${x.variant} | ${x.sizeBytes} | ${x.first} | ${x.p50} | ${x.p95} | ${x.p99}`);
  console.log(`\nЦена шлюза на p99, медиана прогонов, мс (вызов - ${budget}, fs.watch сверх склейки - ${watchBudget}): путь | байт | проверки (шлюз - голое) | из плагина (плагин - голое) | по прогонам`);
  for (const c of costs) console.log(`  ${c.path} | ${c.sizeBytes} | ${c.gatewayP99} | ${c.pluginP99} | ${c.pluginP99Runs.join(' / ')}${c.over ? '  ПРЕВЫШЕН' : c.sizeBytes > BUDGET_MAX_BYTES ? '  (справочно)' : ''}`);
  for (const e of errors) console.log(`\nОШИБКА: ${e}`);
}
if (failed.length > 0) console.error(`\nБюджет превышен: ${failed.map((c) => `${c.path} ${c.sizeBytes} Б (${Number.isFinite(c.pluginP99) ? c.pluginP99 : c.gatewayP99} мс при пределе ${c.limitMs})`).join(', ')}`);
process.exitCode = errors.length === 0 && costs.length > 0 && failed.length === 0 ? 0 : 1;
