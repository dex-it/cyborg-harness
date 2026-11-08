// Замер горячего пути pty (K-14): задержка вывода и число сообщений в хост при разных интервалах склейки; настоящий node-pty, без окна.
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { cpus, platform, arch, release } from 'node:os';
import { PtyTable } from '../../core/src/pty.ts';

const require = createRequire(import.meta.url);
const nodePty = require('node-pty');
const json = process.argv.includes('--json');
const INTERVALS = [0, 2, 4, 8, 16];
const WARMUP = 30;
const SAMPLES = 300;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, p) => {
  const s = xs.toSorted((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? NaN;
};
const stats = (xs) => ({ n: xs.length, p50: +pct(xs, 50).toFixed(2), p95: +pct(xs, 95).toFixed(2), p99: +pct(xs, 99).toFixed(2) });

function table(flushMs, onData) {
  const pushed = { messages: 0, chars: 0, pushMs: 0 };
  const t = new PtyTable(
    { spawn: (file, args, o) => nodePty.spawn(file, args, o) },
    (_, method, params) => {
      if (method !== 'pty.data') return;
      const started = performance.now();
      // Цена сообщения в хост: сериализация, как у канала fork-хоста.
      JSON.stringify({ method, params });
      pushed.pushMs += performance.now() - started;
      pushed.messages++;
      pushed.chars += params.data.length;
      onData(params.data, started);
    },
    undefined,
    undefined,
    { ptyFlushMs: flushMs },
  );
  return { t, pushed };
}

const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', LANG: 'C.UTF-8' };
const spawnOpts = (program, args) => ({ program, args, env, cols: 120, rows: 40, persist: false });

async function exited(t, id) {
  for (let i = 0; i < 200 && t.list('spike').some((p) => p.id === id && !p.exit); i++) await sleep(10);
}

/** Эхо клавиши: запись в cat до прихода её эха; между нажатиями пауза, как у человека. */
async function echo(flushMs) {
  let want = '';
  let buffer = '';
  let resolveEcho;
  const { t, pushed } = table(flushMs, (data) => {
    buffer += data;
    if (want && buffer.includes(want)) {
      buffer = '';
      resolveEcho?.(performance.now());
    }
  });
  const wire = t.spawn('spike', spawnOpts('/bin/cat', []));
  await sleep(200);
  const lat = [];
  for (let i = 0; i < WARMUP + SAMPLES; i++) {
    want = `k${String(i).padStart(4, '0')}`;
    const got = new Promise((r) => (resolveEcho = r));
    const started = performance.now();
    t.write('spike', wire.id, want);
    const at = await got;
    if (i >= WARMUP) lat.push(at - started);
    await sleep(15);
  }
  t.kill('spike', wire.id, 'SIGKILL');
  await exited(t, wire.id);
  t.release('spike');
  return { scenario: 'эхо клавиши', flushMs, ...stats(lat), messages: pushed.messages };
}

// Поток под нагрузкой: пачки по 8 КиБ и метка времени; stdout в tty синхронный, поэтому темп задаёт сам pty.
const FLOOD = `const f='x'.repeat(1024);const end=Date.now()+DURATION;function b(){for(let i=0;i<8;i++)process.stdout.write(f);process.stdout.write('@'+(performance.timeOrigin+performance.now()).toFixed(3)+'@');if(Date.now()<end)setImmediate(b);else process.stdout.write('#DONE#')}b()`;
// Редкий вывод TUI: кусок около 200 байт раз в 16 мс, как спиннер и строка статуса агента.
const TUI = `const f='y'.repeat(200);const end=Date.now()+DURATION;const t=setInterval(()=>{process.stdout.write(f+'@'+(performance.timeOrigin+performance.now()).toFixed(3)+'@');if(Date.now()>end){clearInterval(t);process.stdout.write('#DONE#')}},16)`;

async function stream(name, code, ms, flushMs) {
  const lat = [];
  let tail = '';
  let done;
  const finished = new Promise((r) => (done = r));
  const { t, pushed } = table(flushMs, (data, now) => {
    const text = tail + data;
    const wall = performance.timeOrigin + now;
    let end = 0;
    for (const m of text.matchAll(/@(\d+\.\d+)@/g)) {
      lat.push(wall - Number(m[1]));
      end = m.index + m[0].length;
    }
    // Метка короче 32 знаков: разрезанная между кусками целиком лежит в остатке.
    tail = text.slice(end).slice(-32);
    if (text.includes('#DONE#')) done();
  });
  const wire = t.spawn('spike', spawnOpts(process.execPath, ['-e', code.replace('DURATION', String(ms))]));
  await Promise.race([finished, sleep(ms + 5000)]);
  await exited(t, wire.id);
  t.release('spike');
  const seconds = ms / 1000;
  return { scenario: name, flushMs, ...stats(lat), messages: pushed.messages, perSecond: Math.round(pushed.messages / seconds), mibPerSecond: +(pushed.chars / 1024 / 1024 / seconds).toFixed(1), pushMs: +pushed.pushMs.toFixed(1) };
}

const rows = [];
for (const flushMs of INTERVALS) rows.push(await echo(flushMs));
for (const flushMs of INTERVALS) rows.push(await stream('редкий вывод TUI', TUI, 3000, flushMs));
for (const flushMs of INTERVALS) rows.push(await stream('поток под нагрузкой', FLOOD, 3000, flushMs));

const result = { node: process.version, platform: `${platform()}-${arch()} ${release()}`, cpu: `${cpus()[0]?.model ?? '?'} x${String(cpus().length)}`, rows };
if (json) console.log(JSON.stringify(result, null, 2));
else {
  console.log(`Node ${result.node}, ${result.platform}, ${result.cpu}\n`);
  console.log('сценарий | склейка, мс | p50 | p95 | p99, мс | сообщений | в секунду | МиБ/с | сериализация, мс');
  for (const r of rows) console.log(`  ${r.scenario} | ${r.flushMs} | ${r.p50} | ${r.p95} | ${r.p99} | ${r.messages} | ${r.perSecond ?? '-'} | ${r.mibPerSecond ?? '-'} | ${r.pushMs ?? '-'}`);
}
