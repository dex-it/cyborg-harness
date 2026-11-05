// Хост плагинов для замеров: эхо, приём потока, проба прав и нативного модуля.
const t0 = performance.now();
const port = process.parentPort;
let dataPort = null;
let bytes = 0;

port.on('message', (e) => {
  const m = e.data;
  if (m && m.cmd === 'ping') { port.postMessage({ cmd: 'pong', id: m.id }); return; }
  if (m && m.cmd === 'port') {
    dataPort = e.ports[0];
    dataPort.on('message', (ev) => {
      const d = ev.data;
      if (d && d.ping !== undefined) { dataPort.postMessage({ pong: d.ping }); return; }
      if (d && (d.cmd === 'done' || d.cmd === 'rtt-result')) { port.postMessage({ ...d, cmd: d.cmd === 'done' ? 'blast-done' : 'direct-rtt' }); return; }
      if (d && d.end) { dataPort.postMessage({ bytes }); return; }
      bytes += d.byteLength || 0;
    });
    dataPort.start();
    return;
  }
  if (m && m.cmd === 'blast') { const chunk = new Uint8Array(65536); for (let i = 0; i < m.parts; i++) dataPort.postMessage(chunk); dataPort.postMessage({ cmd: 'end' }); return; }
  if (m && m.cmd === 'rtt') { dataPort.postMessage({ cmd: 'rtt', n: m.n }); return; }
  if (m && m.cmd === 'probe') {
    const out = {};
    const run = (name, fn) => { try { out[name] = fn(); } catch (err) { out[name] = 'ERR ' + (err.code || err.message); } };
    run('readEtcHosts', () => require('node:fs').readFileSync('/etc/hosts', 'utf8').length + ' bytes');
    run('readOwnDir', () => require('node:fs').readdirSync(__dirname).length + ' entries');
    run('childProcess', () => require('node:child_process').execFileSync('/bin/echo', ['hi']).toString().trim());
    run('worker', () => { const { Worker } = require('node:worker_threads'); new Worker('1', { eval: true }).terminate(); return 'ok'; });
    run('netConnect', () => 'api present: ' + typeof require('node:net').connect);
    run('addon', () => { const p = require('node:path').join(m.repo, 'node_modules/node-pty'); const pty = require(p); return 'loaded, spawn=' + typeof pty.spawn; });
    run('permissionFlag', () => String(process.permission ? 'process.permission present' : 'no process.permission'));
    run('execArgv', () => JSON.stringify(process.execArgv));
    port.postMessage({ cmd: 'probe-result', out });
    return;
  }
});

port.postMessage({ cmd: 'ready', bootMs: performance.now() - t0, rss: process.memoryUsage().rss, node: process.version });
