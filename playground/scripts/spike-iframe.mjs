// Замер видов во фреймах (SAD2, открытый вопрос 11) на собранном playground; нужен дисплей (на Linux - xvfb-run ... --no-sandbox).
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..', '..');
const dir = mkdtempSync(join(tmpdir(), 'cyborg-spike-'));
const out = join(dir, 'spike.json');
const json = process.argv.includes('--json');
const electronArgs = process.argv.slice(2).filter((a) => a !== '--json');

const app = spawn(join(repo, 'node_modules', '.bin', 'electron'), [repo, `--spike=${out}`, `--user-data-dir=${join(dir, 'data')}`, ...electronArgs], { stdio: ['ignore', 'inherit', 'inherit'] });
const code = await new Promise((r) => app.once('exit', r));
const result = JSON.parse(readFileSync(out, 'utf8'));
rmSync(dir, { recursive: true, force: true });

if (json) console.log(JSON.stringify(result, null, 2));
else {
  console.log(`Electron ${result.electron}, Chromium ${result.chrome}, ${result.platform}-${result.arch}\n`);
  console.log('Память: фреймов | origin | процессов | рендеров | процессов у фреймов | workingSet, МБ | PSS, МБ | load, мс');
  for (const m of result.memory ?? []) console.log(`  ${m.frames} | ${m.origins} | ${m.processes} | ${m.renderers} | ${m.frameProcesses} | ${m.workingSetMb} | ${m.pssMb ?? '-'} | ${m.mountMs}`);
  console.log('\nЗадержка: путь | p50 | p95 | p99, мс | поток 4 МиБ, мс | МБ/с');
  for (const l of result.latency ?? []) console.log(`  ${l.path} | ${l.p50} | ${l.p95} | ${l.p99} | ${l.streamMs} | ${l.streamMbps}`);
  console.log('\nКлавиши при фокусе в поле фрейма: ввод | фокус во фрейме | before-input-event | keydown во фрейме | напечатано');
  for (const k of result.keys ?? []) console.log(`  ${k.input} | ${k.focusInFrame} | ${k.beforeInputEvent.join(' ')} | ${k.frameKeydown.join(' ') || '-'} | ${k.typed || '-'}`);
  console.log('\nПеретаскивание между фреймами, CDP:', JSON.stringify(result.drag));
  console.log('Перетаскивание настоящей мышью: как | dragstart | drop | типы | путь | источник по ядру');
  for (const d of result.realDrag ?? []) console.log(`  ${d.how} | ${d.dragstartIn ?? '-'} | ${d.dropIn ?? '-'} | ${d.dropTypes?.join(' ') ?? '-'} | ${d.dropPath || '-'} | ${d.dropFrom ?? '-'}`);
  if (result.error) console.log(`\nОШИБКА: ${result.error}`);
}
process.exitCode = code === 0 && !result.error ? 0 : 1;
