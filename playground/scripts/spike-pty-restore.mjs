// Спайк SP-01 (SAD, вопрос 14) на настоящем claude: нужен вход в аккаунт и сеть, поэтому не в CI; итоги - docs/05-verification/spike-pty-restore.md.
import { Buffer } from 'node:buffer';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

const repo = resolve(import.meta.dirname, '..', '..');

// node-pty в репозитории собран под Electron (postinstall), поэтому спайк идёт в его Node.
if (!process.versions.electron) {
  const child = spawn(join(repo, 'node_modules', '.bin', 'electron'), [import.meta.filename, ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  process.exitCode = await new Promise((r) => child.once('exit', r));
} else {
  await main();
}

async function main() {
  const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const only = arg('only')?.split(',');
  const modes = arg('mode')?.split(',') ?? ['inline', 'fullscreen'];
  const jsonOut = arg('json');
  const model = arg('model') ?? 'haiku';

  // headless-xterm и сериализация - только для спайка, в зависимости репозитория не входят.
  const deps = process.env.SPIKE_PTY_DEPS ?? join(tmpdir(), 'cyborg-spike-pty-deps');
  if (!existsSync(join(deps, 'node_modules', '@xterm', 'addon-serialize'))) {
    execFileSync('npm', ['install', '--prefix', deps, '--no-audit', '--no-fund', '@xterm/headless@6.0.0', '@xterm/addon-serialize@0.14.0'], { stdio: 'inherit' });
  }
  const req = createRequire(join(deps, 'package.json'));
  const { Terminal } = req('@xterm/headless');
  const { SerializeAddon } = req('@xterm/addon-serialize');
  const nodePty = createRequire(join(repo, 'package.json'))('node-pty');
  const { PtyTable, Tail, BACKLOG_LIMIT, groupKilled } = await import(join(repo, 'core', 'src', 'pty.ts'));
  const { inlinePtyHost } = await import(join(repo, 'core', 'src', 'pty-link.ts'));

  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc');

  const COLS = 100;
  const ROWS = 30;
  const WIDE = { cols: 120, rows: 40 };
  const SETTLE_MS = 5000;
  const STEP_MS = 50;
  const PASS_MS = 1000;
  // Сессия длиннее 256 К - часы работы; малый хвост даёт тот же срез начала сессии за один ответ.
  const SHORT_LIMIT = 2048;

  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && k !== 'ELECTRON_RUN_AS_NODE'));
  const shell = process.env.SHELL ?? '/bin/bash';
  const claudeVersion = execFileSync(shell, ['-lc', 'claude --version'], { env, encoding: 'utf8' }).trim();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const term = (cols, rows) => new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true });
  const flush = (...ts) => Promise.all(ts.map((t) => new Promise((r) => t.write('', r))));

  const screen = (t) => {
    const b = t.buffer.active;
    const lines = [];
    for (let y = 0; y < t.rows; y++) lines.push(b.getLine(b.baseY + y)?.translateToString(true) ?? '');
    return lines;
  };

  const cells = (t) => {
    const b = t.buffer.active;
    const out = [];
    const cell = b.getNullCell();
    for (let y = 0; y < t.rows; y++) {
      const line = b.getLine(b.baseY + y);
      const row = [];
      for (let x = 0; x < t.cols; x++) {
        const c = line?.getCell(x, cell);
        row.push(c ? [c.getChars(), c.getWidth(), c.getFgColorMode(), c.getFgColor(), c.getBgColorMode(), c.getBgColor(), c.isBold(), c.isItalic(), c.isUnderline(), c.isInverse(), c.isDim()].join('|') : '');
      }
      out.push(row);
    }
    return { type: b.type, rows: out, cursor: `${String(b.cursorX)},${String(b.cursorY)}` };
  };

  const MODES = ['applicationCursorKeysMode', 'applicationKeypadMode', 'bracketedPasteMode', 'insertMode', 'mouseTrackingMode', 'originMode', 'reverseWraparoundMode', 'sendFocusMode', 'wraparoundMode'];
  const modesOf = (t) => Object.fromEntries(MODES.map((m) => [m, t.modes[m]]));

  const diff = (ref, view) => {
    const ma = modesOf(ref);
    const mb = modesOf(view);
    const modes = MODES.filter((m) => ma[m] !== mb[m]).map((m) => `${m.replace(/Mode$/, '')}=${String(mb[m])}`);
    if (ref.cols !== view.cols || ref.rows !== view.rows) return { cells: ref.cols * ref.rows, rows: ref.rows, buffer: false, cursor: false, modes };
    const a = cells(ref);
    const b = cells(view);
    let c = 0;
    let r = 0;
    for (let y = 0; y < a.rows.length; y++) {
      let rowDiff = 0;
      for (let x = 0; x < a.rows[y].length; x++) if (a.rows[y][x] !== b.rows[y][x]) rowDiff++;
      c += rowDiff;
      if (rowDiff) r++;
    }
    return { cells: c, rows: r, buffer: a.type === b.type, cursor: a.cursor === b.cursor, modes };
  };
  const clean = (d) => d.cells === 0 && d.buffer && d.modes.length === 0;

  const insideEscape = (all, at) => {
    let state = 'text';
    for (let i = 0; i < at; i++) {
      const ch = all.charCodeAt(i);
      if (state === 'text') state = ch === 0x1b ? 'esc' : 'text';
      else if (state === 'esc') state = ch === 0x5b ? 'csi' : ch === 0x5d || ch === 0x50 ? 'osc' : 'text';
      else if (state === 'csi') state = ch >= 0x40 && ch <= 0x7e ? 'text' : 'csi';
      else if (state === 'osc') state = ch === 0x07 ? 'text' : ch === 0x1b ? 'osc-esc' : 'osc';
      else if (state === 'osc-esc') state = ch === 0x5c ? 'text' : 'osc';
    }
    const hi = all.charCodeAt(at - 1);
    return state !== 'text' ? state : hi >= 0xd800 && hi <= 0xdbff ? 'surrogate' : '';
  };

  async function session(mode, preOutput = '', backlogLimit = BACKLOG_LIMIT) {
    const ref = { t: term(COLS, ROWS) };
    const serialize = new SerializeAddon();
    ref.t.loadAddon(serialize);
    const views = new Set();
    let raw = '';
    const backend = {
      spawn(file, args, o) {
        const p = groupKilled(nodePty.spawn(file, args, o));
        p.onData((d) => {
          raw += d;
          ref.t.write(d);
        });
        return p;
      },
    };
    // Хост pty в том же процессе: тот же протокол, что у отдельного процесса, хвост и шаг размера ведёт он (K-01).
    const table = new PtyTable(inlinePtyHost(backend), (_plugin, method, params) => {
      if (method === 'pty.data') for (const v of views) v.write(params.data);
    }, { backlog: backlogLimit });
    const settings = JSON.stringify({ tui: mode === 'inline' ? 'default' : 'fullscreen' });
    const script = `${preOutput}exec claude --model ${model} --settings '${settings}'`;
    const wire = await table.spawn('spike', { program: shell, args: ['-lc', script], cwd: repo, env, cols: COLS, rows: ROWS, persist: true });
    const s = {
      raw: () => raw,
      text: () => screen(ref.t),
      async ready() {
        const until = Date.now() + 30_000;
        while (Date.now() < until) {
          await flush(ref.t);
          if (s.text().some((l) => l.startsWith('❯')) && s.text().some((l) => l.includes('shift+tab') || l.includes('? for shortcuts'))) return wait(1000);
          await wait(200);
        }
        throw new Error(`claude не показал приглашение:\n${s.text().join('\n')}`);
      },
      async prompt(n) {
        table.write('spike', wire.id, `Выведи целые числа от 1 до ${String(n)}, каждое на своей строке, без пояснений и без инструментов.`);
        await wait(400);
        table.write('spike', wire.id, '\r');
      },
      async answered(n, timeout = 90_000) {
        const until = Date.now() + timeout;
        while (Date.now() < until) {
          await flush(ref.t);
          const all = [];
          const b = ref.t.buffer.active;
          for (let y = 0; y < b.length; y++) all.push(b.getLine(y)?.translateToString(true).trim());
          if (all.includes(String(n)) && s.text().some((l) => l.startsWith('❯') && l.trim() === '❯')) return;
          await wait(200);
        }
        throw new Error(`ответ до ${String(n)} не дошёл:\n${s.text().join('\n')}`);
      },
      detach: () => table.detach('spike'),
      // Снимок берётся до attach: шаг размера внутри attach сразу запускает перерисовку, и снимок после него уже не чистый.
      async attach(size) {
        await flush(ref.t);
        const t0 = performance.now();
        const snapshot = serialize.serialize();
        const serializeMs = performance.now() - t0;
        const back = await table.attach('spike', wire.id);
        const tail = term(size?.cols ?? COLS, size?.rows ?? ROWS);
        const snap = term(COLS, ROWS);
        tail.write(back.backlog);
        snap.write(snapshot);
        views.add(tail);
        views.add(snap);
        if (size) {
          snap.resize(size.cols, size.rows);
          ref.t.resize(size.cols, size.rows);
          table.resize('spike', wire.id, size.cols, size.rows);
        }
        const start = performance.now();
        const cut = raw.length - back.backlog.length;
        const res = {
          streamAtAttach: raw.length,
          tail: { bytes: back.backlog.length, cut: cut > 0 ? insideEscape(raw, cut) || 'нет' : 'хвост целиком' },
          snapshot: { bytes: snapshot.length, serializeMs: +serializeMs.toFixed(1) },
        };
        await flush(ref.t, tail, snap);
        res.tail.first = diff(ref.t, tail);
        res.snapshot.first = diff(ref.t, snap);
        while (performance.now() - start < SETTLE_MS) {
          await flush(ref.t, tail, snap);
          const ms = Math.round(performance.now() - start);
          for (const [name, t] of [['tail', tail], ['snapshot', snap]]) {
            const d = diff(ref.t, t);
            res[name].last = d;
            if (!clean(d)) res[name].matchMs = undefined;
            else res[name].matchMs ??= ms;
          }
          await wait(STEP_MS);
        }
        for (const name of ['tail', 'snapshot']) res[name].pass = res[name].matchMs !== undefined && res[name].matchMs <= PASS_MS;
        res.views = { ref: screen(ref.t), tail: screen(tail), snapshot: screen(snap) };
        return res;
      },
      close: () => table.releaseAll(),
    };
    return s;
  }

  const long = `awk 'BEGIN{for(i=1;i<=6000;i++) printf "\\033[3%dmстрока %06d ................................................\\033[0m\\n", i%7+1, i}'; `;

  const scenarios = [
    {
      key: 'а',
      title: 'вскоре после старта',
      modes: ['inline', 'fullscreen'],
      async run(s) {
        s.detach();
        await s.ready();
        return s.attach();
      },
    },
    {
      key: 'б1',
      title: 'длинный вывод оболочки до claude, больше хвоста',
      modes: ['inline', 'fullscreen'],
      pre: long,
      async run(s) {
        await s.ready();
        await s.prompt(40);
        await s.answered(40);
        s.detach();
        await wait(1000);
        return s.attach();
      },
    },
    {
      key: 'б2',
      title: `сессия claude длиннее хвоста (хвост ${String(SHORT_LIMIT)} симв.)`,
      modes: ['inline', 'fullscreen'],
      limit: SHORT_LIMIT,
      async run(s) {
        await s.ready();
        await s.prompt(200);
        await s.answered(200);
        s.detach();
        await wait(1000);
        return s.attach();
      },
    },
    {
      key: 'в',
      title: 'attach во время ответа на альтернативном экране',
      modes: ['fullscreen'],
      async run(s) {
        await s.ready();
        await s.prompt(200);
        await wait(800);
        s.detach();
        await wait(1500);
        return s.attach();
      },
    },
    {
      key: 'г',
      title: 'обрыв владельца при активном выводе, attach после',
      modes: ['inline', 'fullscreen'],
      async run(s) {
        await s.ready();
        await s.prompt(150);
        await wait(800);
        s.detach();
        await s.answered(150);
        await wait(1000);
        return s.attach();
      },
    },
    {
      key: 'д',
      title: `attach с другим размером (${String(COLS)}x${String(ROWS)} -> ${String(WIDE.cols)}x${String(WIDE.rows)})`,
      modes: ['inline', 'fullscreen'],
      async run(s) {
        await s.ready();
        await s.prompt(40);
        await s.answered(40);
        s.detach();
        await wait(1000);
        return s.attach(WIDE);
      },
    },
  ];

  const results = [];
  const streams = [];
  for (const sc of scenarios) {
    if (only && !only.includes(sc.key)) continue;
    for (const mode of sc.modes) {
      if (!modes.includes(mode)) continue;
      const s = await session(mode, sc.pre, sc.limit);
      try {
        const r = await sc.run(s);
        results.push({ scenario: sc.key, title: sc.title, mode, raw: s.raw().length, ...r });
        streams.push(s.raw());
        console.error(`${sc.key} ${mode}: хвост ${fmt(r.tail)}; снимок ${fmt(r.snapshot)}`);
      } catch (e) {
        results.push({ scenario: sc.key, title: sc.title, mode, error: e.message });
        console.error(`${sc.key} ${mode}: ОШИБКА ${e.message}`);
      } finally {
        s.close();
      }
      await wait(500);
    }
  }

  const cuts = [];
  {
    const line = (i) => `\x1b[3${String((i % 7) + 1)}mстрока ${String(i)}\x1b[0m \x1b]8;;https://example.com/${String(i)}\x07ссылка\x1b]8;;\x07 😀\r\n`;
    const k = 100;
    const all = Array.from({ length: 200 }, (_, i) => line(i + 1)).join('');
    const mid = all.indexOf(line(k));
    const expected = `строка ${String(k)} ссылка 😀`;
    const cases = [
      ['CSI SGR: срез после ESC', mid + 1],
      ['CSI SGR: срез после ESC [', mid + 2],
      ['OSC 8: срез внутри адреса', all.indexOf('example.com', mid) + 3],
      ['суррогатная пара эмодзи', all.indexOf('😀', mid) + 1],
    ];
    for (const [title, at] of cases) {
      const tail = new Tail(all.length - at);
      tail.push(all);
      const ref = term(COLS, ROWS);
      const view = term(COLS, ROWS);
      ref.write(all);
      view.write(tail.text());
      await flush(ref, view);
      const d = diff(ref, view);
      cuts.push({ title, state: insideEscape(all, at) || 'нет', cells: d.cells, rows: d.rows, first: view.buffer.active.getLine(0)?.translateToString(true) ?? '', expected });
    }
  }

  const cost = {};
  {
    const stream = streams.reduce((a, b) => (b.length > a.length ? b : a), '');
    const n = 10;
    gc();
    const before = process.memoryUsage();
    const keep = [];
    for (let i = 0; i < n; i++) {
      const t = term(COLS, ROWS);
      t.write(stream);
      keep.push(t);
    }
    await flush(...keep);
    gc();
    const after = process.memoryUsage();
    const heap = (m) => m.heapUsed + m.external + m.arrayBuffers;
    cost.streamChars = stream.length;
    cost.memPerSessionMb = +((heap(after) - heap(before)) / n / 1e6).toFixed(2);
    cost.rssPerSessionMb = +((after.rss - before.rss) / n / 1e6).toFixed(2);
    const big = stream.repeat(Math.max(1, Math.ceil(8e6 / Math.max(1, stream.length))));
    const t = term(COLS, ROWS);
    const ser = new SerializeAddon();
    t.loadAddon(ser);
    const cpu0 = process.cpuUsage();
    const t0 = performance.now();
    t.write(big);
    await flush(t);
    const ms = performance.now() - t0;
    const cpu = process.cpuUsage(cpu0);
    const mb = Buffer.byteLength(big) / 1e6;
    cost.parsedMb = +mb.toFixed(1);
    cost.parseMbps = +(mb / (ms / 1000)).toFixed(1);
    cost.parseCpuMsPerMb = +((cpu.user + cpu.system) / 1000 / mb).toFixed(1);
    const s0 = performance.now();
    const snapshot = ser.serialize();
    cost.serializeMs = +(performance.now() - s0).toFixed(1);
    cost.snapshotChars = snapshot.length;
    cost.bufferLines = t.buffer.active.length;
    keep.length = 0;
  }

  const meta = { platform: `${process.platform}-${process.arch}`, electron: process.versions.electron, node: process.versions.node, claude: claudeVersion, model, size: `${String(COLS)}x${String(ROWS)}`, backlogLimit: BACKLOG_LIMIT, passMs: PASS_MS, settleMs: SETTLE_MS };
  const report = { meta, results, cuts, cost };
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 2));

  console.log(`${meta.platform}, Electron ${meta.electron}, Node ${meta.node}, claude ${meta.claude}, модель ${model}, окно ${meta.size}, хвост ${String(BACKLOG_LIMIT)} символов\n`);
  console.log('Сценарий | режим | поток к attach, симв. | вариант | сразу: ячеек/строк | через 5 с: ячеек/строк | через 5 с: буфер, режимы, курсор | совпал, мс | размер, симв. | срез / сериализация | порог');
  for (const r of results) {
    if (r.error) {
      console.log(`  ${r.scenario} | ${r.mode} | ОШИБКА: ${r.error.split('\n')[0]}`);
      continue;
    }
    for (const name of ['tail', 'snapshot']) {
      const v = r[name];
      const extra = [v.last.buffer ? '' : 'другой буфер', v.last.modes.join(' '), v.last.cursor ? '' : 'курсор'].filter(Boolean).join(', ');
      console.log(`  ${r.scenario} | ${r.mode} | ${String(r.streamAtAttach)} | ${name === 'tail' ? 'хвост' : 'снимок'} | ${String(v.first.cells)}/${String(v.first.rows)} | ${String(v.last.cells)}/${String(v.last.rows)} | ${extra || '-'} | ${String(v.matchMs ?? 'нет')} | ${String(v.bytes)} | ${name === 'tail' ? v.cut : `${String(v.serializeMs)} мс`} | ${v.pass ? 'да' : 'нет'}`);
    }
  }
  console.log('\nСрез хвоста длиннее экрана: случай | состояние разбора | экран: ячеек/строк | первая строка вида | эта строка у эталона');
  for (const c of cuts) console.log(`  ${c.title} | ${c.state} | ${String(c.cells)}/${String(c.rows)} | ${JSON.stringify(c.first.slice(0, 50))} | ${JSON.stringify(c.expected.slice(0, 50))}`);
  console.log(`\nЦена снимка: поток ${String(cost.streamChars)} симв. | память на сессию ${String(cost.memPerSessionMb)} МБ (RSS ${String(cost.rssPerSessionMb)}) | разбор ${String(cost.parsedMb)} МБ: ${String(cost.parseMbps)} МБ/с, CPU ${String(cost.parseCpuMsPerMb)} мс/МБ | сериализация ${String(cost.serializeMs)} мс, ${String(cost.snapshotChars)} симв., ${String(cost.bufferLines)} строк буфера`);
  if (process.argv.includes('--screens')) {
    for (const r of results.filter((x) => !x.error && (!x.tail.pass || !x.snapshot.pass))) {
      for (const name of ['ref', 'tail', 'snapshot']) console.log(`\n--- ${r.scenario} ${r.mode} ${name}\n${r.views[name].join('\n')}`);
    }
  }
  process.exit(results.some((r) => r.error) ? 1 : 0);

  function fmt(v) {
    return `сразу ${String(v.first.cells)}, через 5 с ${String(v.last.cells)}, совпал ${v.matchMs === undefined ? 'нет' : `${String(v.matchMs)} мс`}`;
  }
}
