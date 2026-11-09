// Замер цены `fsync` в атомарной записи (K-12, ctx-os-coverage.md, разд. 5): последовательность та же, что в `writeAtomic` ядра - `open` с `O_EXCL`, запись, `chmod` режима существующего файла, `rename`; вариант «с fsync» добавляет `fsync` файла перед `rename`.
// Без шлюза, канала хоста и Electron: сырая цена записи на диск. Запуск - `npm run spike:fsync` (`-- --dir=<каталог>` на нужной ФС, `--json` для сырых рядов; `--writes=300`, `--series=4`, `--kib=64`).
import { constants } from 'node:fs';
import { chmod, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const option = (name, fallback) => {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const value = raw === undefined ? fallback : name === 'dir' ? raw : Number(raw);
  if (name !== 'dir' && !(Number.isInteger(value) && value > 0)) throw new Error(`--${name}: целое число больше нуля`);
  return value;
};
const writes = option('writes', 300);
const series = option('series', 4);
const kib = option('kib', 64);
const json = process.argv.includes('--json');
// 64 КиБ UTF-8 с многобайтными символами: размер в байтах как в ревью, не в символах.
const text = 'я'.repeat((kib * 1024) / 2);

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
const round = (n) => Math.round(n * 100) / 100;

async function once(file, sync) {
  const temp = `${file}.${Math.random().toString(16).slice(2, 14)}.tmp`;
  const start = performance.now();
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.chmod(0o644);
    if (sync) await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, file);
  return performance.now() - start;
}

const base = option('dir', tmpdir());
const dir = await mkdtemp(join(base, 'cyborg-spike-fsync-'));
try {
  const file = join(dir, 'state.json');
  await writeFile(file, 'старый');
  const rows = [];
  for (let s = 1; s <= series; s++) {
    for (const [variant, sync] of [['без fsync (как в ядре)', false], ['с fsync файла перед rename', true]]) {
      const times = [];
      for (let i = 0; i < writes; i++) times.push(await once(file, sync));
      times.sort((a, b) => a - b);
      rows.push({ series: s, variant, p50: round(quantile(times, 0.5)), p99: round(quantile(times, 0.99)) });
    }
  }
  await chmod(file, 0o644);
  if (json) console.log(JSON.stringify({ platform: process.platform, node: process.version, dir: base, writes, kib, rows }, null, 2));
  else {
    console.log(`${process.platform}, Node ${process.version}, каталог ${base}, ${String(writes)} записей по ${String(kib)} КиБ UTF-8, серий ${String(series)}`);
    console.log('| Вариант | серия | p50, мс | p99, мс |\n|---|---|---|---|');
    for (const r of rows) console.log(`| ${r.variant} | ${String(r.series)} | ${String(r.p50)} | ${String(r.p99)} |`);
    for (const variant of new Set(rows.map((r) => r.variant))) {
      const mine = rows.filter((r) => r.variant === variant);
      const range = (key) => `${String(Math.min(...mine.map((r) => r[key])))}-${String(Math.max(...mine.map((r) => r[key])))}`;
      console.log(`${variant}: p50 ${range('p50')}, p99 ${range('p99')}`);
    }
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
