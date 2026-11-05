// Хост как обычный процесс Node (Electron с ELECTRON_RUN_AS_NODE) и каналом IPC.
const t0 = performance.now();
process.on('message', (m) => {
  if (m && m.cmd === 'ping') { process.send({ cmd: 'pong', id: m.id }); return; }
  if (m && m.cmd === 'probe') {
    const out = {};
    const run = (name, fn) => { try { out[name] = fn(); } catch (err) { out[name] = 'ERR ' + (err.code || err.message); } };
    run('readEtcHosts', () => require('node:fs').readFileSync('/etc/hosts', 'utf8').length + ' bytes');
    run('readAllowedDir', () => require('node:fs').readdirSync(__dirname).length + ' entries');
    run('writeTmp', () => { require('node:fs').writeFileSync('/tmp/spike-perm-test', 'x'); return 'written'; });
    run('childProcess', () => require('node:child_process').execFileSync('/bin/echo', ['hi']).toString().trim());
    run('worker', () => { const { Worker } = require('node:worker_threads'); new Worker('1', { eval: true }).terminate(); return 'ok'; });
    run('addon', () => { const pty = require(require('node:path').join(m.repo, 'node_modules/node-pty')); return 'loaded'; });
    run('env HOME', () => String(process.env.HOME));
    run('permission.has fs.read /etc/hosts', () => String(process.permission && process.permission.has('fs.read', '/etc/hosts')));
    process.send({ cmd: 'probe-result', out });
    // сеть: проверяем отдельно, это асинхронно
    require('node:net').connect(443, '1.1.1.1').on('connect', function () { process.send({ cmd: 'net', out: 'connect to 1.1.1.1:443 OK' }); this.destroy(); }).on('error', (e) => process.send({ cmd: 'net', out: 'ERR ' + (e.code || e.message) })).setTimeout(3000, function () { process.send({ cmd: 'net', out: 'timeout' }); this.destroy(); });
  }
});
process.send({ cmd: 'ready', bootMs: performance.now() - t0, node: process.version, permission: typeof process.permission });
