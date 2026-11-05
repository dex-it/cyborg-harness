// Второй прогон: настоящая память (footprint), хост как процесс Node с правами, Hardened JS на библиотеках.
const { app, utilityProcess, MessageChannelMain } = require('electron');
const path = require('node:path');
const cp = require('node:child_process');
const fs = require('node:fs');

const REPO = process.env.CYBORG_REPO || path.resolve(__dirname, '../../../..');
const OUT = path.join(process.env.SPIKE_OUT || __dirname, 'result-u2.json');
const R = { electron: process.versions.electron, node: process.versions.node, steps: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const footprintMB = (pid) => {
  const o = cp.execFileSync('footprint', ['-p', String(pid)]).toString();
  const m = o.match(/Footprint:\s*([\d.]+)\s*(KB|MB|GB)/);
  if (!m) return null; const v = parseFloat(m[1]); return m[2] === 'KB' ? v / 1024 : m[2] === 'GB' ? v * 1024 : v;
};
const rssMB = (pid) => Number(cp.execFileSync('ps', ['-o', 'rss=', '-p', String(pid)]).toString().trim()) / 1024;
const once = (ch, cmd, ev) => new Promise((res) => { const h = (m) => { if (m && m.cmd === cmd) { ch.off(ev || 'message', h); res(m); } }; ch.on(ev || 'message', h); });

function forkUtility(file, opts, env) {
  const t = performance.now();
  const child = utilityProcess.fork(path.join(__dirname, file), [], { ...(opts || {}), env: { ...process.env, ...(env || {}) } });
  const ready = new Promise((resolve) => child.on('message', (m) => { if (m && m.cmd === 'ready') resolve({ ms: performance.now() - t, m }); }));
  return { child, ready, pid: () => child.pid, kill: () => child.kill() };
}
function forkNode(file, execArgv, env) {
  const t = performance.now();
  const child = cp.fork(path.join(__dirname, file), [], { execPath: process.execPath, execArgv: execArgv || [], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...(env || {}) }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const ready = new Promise((resolve, reject) => { child.on('message', (m) => { if (m && m.cmd === 'ready') resolve({ ms: performance.now() - t, m }); }); child.on('exit', (c) => reject(new Error('exit ' + c))); });
  ready.catch(() => {});
  return { child, ready, pid: () => child.pid, kill: () => child.kill() };
}

async function main() {
  await app.whenReady();
  const metrics = await (async () => { await sleep(500); return app.getAppMetrics().map((m) => ({ type: m.type, pid: m.pid })); })();
  R.steps.mainProcess = { footprintMB: +footprintMB(process.pid).toFixed(1), rssMB: +rssMB(process.pid).toFixed(1), processes: metrics };

  // 1. Память хостов-utilityProcess по footprint
  const mem = [];
  for (const n of [1, 3, 6, 10]) {
    const hs = []; for (let i = 0; i < n; i++) hs.push(forkUtility('host.js'));
    await Promise.all(hs.map((h) => h.ready)); await sleep(1500);
    const fp = hs.map((h) => footprintMB(h.pid())); const rss = hs.map((h) => rssMB(h.pid()));
    mem.push({ hosts: n, footprintMB_each: +(fp.reduce((a, b) => a + b, 0) / n).toFixed(1), footprintMB_total: +fp.reduce((a, b) => a + b, 0).toFixed(1), rssMB_each: +(rss.reduce((a, b) => a + b, 0) / n).toFixed(1) });
    hs.forEach((h) => h.kill()); await sleep(600);
  }
  R.steps.utilityMemory = mem;

  // 2. Пропускная способность: исправлено чтение ответа
  { const h = forkUtility('host.js'); await h.ready;
    const { port1, port2 } = new MessageChannelMain(); h.child.postMessage({ cmd: 'port' }, [port2]); port1.start();
    const chunk = new Uint8Array(65536); const total = 400 * 1048576; const parts = total / chunk.length; const t = performance.now();
    for (let i = 0; i < parts; i++) port1.postMessage(chunk);
    const got = await new Promise((res) => { port1.once('message', (e) => res(e.data)); port1.postMessage({ end: true }); });
    const dt = (performance.now() - t) / 1000;
    R.steps.throughputMainToHost = { sentMB: total / 1048576, receivedMB: Math.round(got.bytes / 1048576), seconds: +dt.toFixed(2), MBps: Math.round(total / 1048576 / dt) };
    h.kill(); await sleep(300); }

  // 2b. Флаги прав Node через utilityProcess.fork({ execArgv }): принимаются ли и действуют ли
  const upProbe = async (execArgv) => {
    const x = forkUtility('host.js', { execArgv, serviceName: 'probe' });
    try { await Promise.race([x.ready, sleep(5000).then(() => { throw new Error('не стартовал за 5 с'); })]); } catch (e) { x.kill(); return 'не запустился: ' + e.message; }
    const p = once(x.child, 'probe-result'); x.child.postMessage({ cmd: 'probe', repo: REPO });
    const r = await Promise.race([p, sleep(5000).then(() => ({ out: 'нет ответа' }))]); x.kill(); await sleep(300); return r.out;
  };
  R.steps.utilityPermission = { noFlags: await upProbe([]), withPermission: await upProbe(['--permission', '--allow-fs-read=' + __dirname]) };

  // 3. Хост как процесс Node с правами (ELECTRON_RUN_AS_NODE + --permission)
  const nodeProbe = async (execArgv) => {
    const x = forkNode('host-node.js', execArgv);
    try { await Promise.race([x.ready, sleep(8000).then(() => { throw new Error('не стартовал за 8 с'); })]); } catch (e) { x.kill(); return { startup: 'не запустился: ' + e.message }; }
    const p = once(x.child, 'probe-result'); const pn = once(x.child, 'net'); x.child.send({ cmd: 'probe', repo: REPO });
    const r = await Promise.race([p, sleep(8000).then(() => ({ out: 'нет ответа' }))]); const n = await Promise.race([pn, sleep(6000).then(() => ({ out: 'нет ответа' }))]);
    x.kill(); await sleep(300); return { ...r.out, net: n.out };
  };
  const allowed = ['--permission', '--allow-fs-read=' + __dirname, '--allow-fs-read=' + REPO + '/node_modules/node-pty', '--allow-fs-write=' + path.join(process.env.SPIKE_OUT || __dirname, 'tmp-w')];
  R.steps.nodeChildPermission = { noFlags: await nodeProbe([]), withPermission: await nodeProbe(allowed), withPermissionAndAddons: await nodeProbe([...allowed, '--allow-addons']) };

  // старт, память и RTT такого хоста
  { const mm = [];
    for (const n of [1, 3, 6]) {
      const hs = []; for (let i = 0; i < n; i++) hs.push(forkNode('host-node.js', ['--permission', '--allow-fs-read=' + __dirname]));
      const rd = await Promise.all(hs.map((h) => h.ready)); await sleep(1500);
      const fp = hs.map((h) => footprintMB(h.pid())); const rss = hs.map((h) => rssMB(h.pid()));
      mm.push({ hosts: n, readyMs_avg: +(rd.reduce((a, r) => a + r.ms, 0) / n).toFixed(0), footprintMB_each: +(fp.reduce((a, b) => a + b, 0) / n).toFixed(1), rssMB_each: +(rss.reduce((a, b) => a + b, 0) / n).toFixed(1) });
      hs.forEach((h) => h.kill()); await sleep(600);
    }
    R.steps.nodeChildMemory = mm;
    const x = forkNode('host-node.js', ['--permission', '--allow-fs-read=' + __dirname]); await x.ready; const rt = [];
    for (let i = 0; i < 20000; i++) { const t = performance.now(); const p = once(x.child, 'pong'); x.child.send({ cmd: 'ping', id: i }); await p; rt.push((performance.now() - t) * 1000); }
    R.steps.nodeChildRttIpcMicros = { n: 20000, p50: +pct(rt, 0.5).toFixed(0), p95: +pct(rt, 0.95).toFixed(0), p99: +pct(rt, 0.99).toFixed(0) };
    x.kill(); await sleep(300); }

  // 4. Hardened JS: режимы и библиотеки (в utilityProcess и в Node-процессе)
  const sesU = async (mode) => { const s = forkUtility('host-ses2.js', {}, { SES_MODE: mode }); const r = await Promise.race([once(s.child, 'ses-result'), sleep(60000).then(() => ({ timeout: true }))]); s.kill(); await sleep(300); return r.res || r; };
  R.steps.sesDefaultInUtility = await sesU('default');
  R.steps.sesCompatInUtility = await sesU('compat');
  { const s = forkNode('host-ses2.js', ['--permission', '--allow-fs-read=' + __dirname], { SES_MODE: 'compat' }); const r = await Promise.race([once(s.child, 'ses-result'), sleep(60000).then(() => ({ timeout: true }))]); s.kill(); R.steps.sesCompatInNodeChildWithPermission = r.res || r; }

  fs.writeFileSync(OUT, JSON.stringify(R, null, 2));
  app.quit();
}
main().catch((e) => { R.error = String(e && e.stack || e); fs.writeFileSync(OUT, JSON.stringify(R, null, 2)); app.quit(); });
