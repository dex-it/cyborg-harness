// Замер хостов плагинов (SAD, открытый вопрос 7) на собранном playground; на Linux - xvfb-run ... --no-sandbox.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..', '..');
const dir = mkdtempSync(join(tmpdir(), 'cyborg-spike-hosts-'));
const out = join(dir, 'hosts.json');
const json = process.argv.includes('--json');
const electronArgs = process.argv.slice(2).filter((a) => a !== '--json');

const app = spawn(join(repo, 'node_modules', '.bin', 'electron'), [repo, `--spike-hosts=${out}`, `--user-data-dir=${join(dir, 'data')}`, ...electronArgs], { stdio: ['ignore', 'inherit', 'inherit'] });
const code = await new Promise((r) => app.once('exit', r));
const r = JSON.parse(readFileSync(out, 'utf8'));
rmSync(dir, { recursive: true, force: true });

if (json) console.log(JSON.stringify(r, null, 2));
else {
  console.log(`Electron ${r.electron}, Node ${r.node}, ${r.platform}-${r.arch}, ${r.cpus}\n`);
  console.log('Память: раскладка | хостов | плагинов | PSS, МБ | RSS, МБ | PSS на хост, МБ');
  for (const m of r.memory ?? []) console.log(`  ${m.layout} | ${m.hosts} | ${m.plugins} | ${m.pssMb ?? '-'} | ${m.rssMb ?? '-'} | ${m.pssPerHostMb ?? '-'}`);
  console.log('\nВызов: путь | байт | p50 | p95 | p99, мс');
  for (const c of r.calls ?? []) console.log(`  ${c.path} | ${c.sizeBytes} | ${c.p50} | ${c.p95} | ${c.p99}`);
  console.log('\nПоток: путь | кусков x байт | мс | МиБ/с');
  for (const s of r.streams ?? []) console.log(`  ${s.path} | ${s.chunks} x ${s.chunkBytes} | ${s.ms} | ${s.mbps}`);
  console.log('\nСинхронная работа в хосте: что | мс | подробности');
  for (const w of r.work ?? []) console.log(`  ${w.work} | ${w.ms} | ${w.detail || '-'}`);
  console.log('\nОтвет хоста, занятого синхронной работой: блок, мс | ответ, мс');
  for (const p of r.ping ?? []) console.log(`  ${p.blockMs} | ${p.pingDuringMs}`);
  console.log('\nСторож: interval/timeout | отказ | обнаружение, мс | перезапуск до activated, мс');
  for (const w of r.watchdog ?? []) console.log(`  ${w.watchdog} | ${w.failure} | ${w.detectMs} | ${w.restartMs}`);
  if (r.error) console.log(`\nОШИБКА: ${r.error}`);
}
process.exitCode = code === 0 && !r.error ? 0 : 1;
