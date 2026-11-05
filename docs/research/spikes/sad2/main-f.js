// Замер рендера: iframe с origin на плагин (процессы, память), мост MessagePort, перехват клавиш.
const { app, BrowserWindow, protocol, net, ipcMain, utilityProcess, MessageChannelMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const cp = require('node:child_process');
const pages = require('./pages.js');

const REPO = process.env.CYBORG_REPO || path.resolve(__dirname, '../../../..');
const XTERM = path.join(REPO, 'node_modules/@xterm/xterm/lib/xterm.js');
const OUT = path.join(process.env.SPIKE_OUT || __dirname, 'result-f.json');
const R = { electron: process.versions.electron, chrome: process.versions.chrome, steps: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mark = (s) => fs.appendFileSync(path.join(process.env.SPIKE_OUT || __dirname, 'progress.log'), new Date().toISOString() + ' ' + s + '\n');
const TO = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout: ' + what)), ms))]);
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

protocol.registerSchemesAsPrivileged([
  { scheme: 'cyborg-shell', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: 'cyborg-plugin', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

const footprintMB = (pid) => {
  try { const o = cp.execFileSync('footprint', ['-p', String(pid)]).toString(); const m = o.match(/Footprint:\s*([\d.]+)\s*(KB|MB|GB)/); if (!m) return 0; const v = parseFloat(m[1]); return m[2] === 'KB' ? v / 1024 : m[2] === 'GB' ? v * 1024 : v; } catch { return 0; }
};
function snapshot() {
  const procs = app.getAppMetrics();
  const by = {};
  for (const p of procs) { const t = p.type; by[t] = by[t] || { count: 0, footprintMB: 0 }; by[t].count++; by[t].footprintMB += footprintMB(p.pid); }
  let total = 0; for (const t in by) { by[t].footprintMB = +by[t].footprintMB.toFixed(1); total += by[t].footprintMB; }
  return { byType: by, totalFootprintMB: +total.toFixed(1) };
}

function serve(handlerFor) {
  return (req) => {
    const u = new URL(req.url);
    const send = (body, type, extra) => new Response(body, { headers: { 'content-type': type, ...(extra || {}) } });
    return handlerFor(u, send);
  };
}

function setupProtocols() {
  protocol.handle('cyborg-shell', serve((u, send) => {
    if (u.pathname === '/shell.js') return send(pages.shellJs, 'text/javascript');
    if (u.pathname === '/xterm.js') return send(fs.readFileSync(XTERM), 'text/javascript');
    return send(pages.shellHtml, 'text/html');
  }));
  protocol.handle('cyborg-plugin', serve((u, send) => {
    const csp = { 'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:" };
    if (u.pathname === '/plugin.js') return send(pages.pluginJs, 'text/javascript', csp);
    if (u.pathname === '/xterm.js') return send(fs.readFileSync(XTERM), 'text/javascript', csp);
    if (u.pathname === '/x.txt') return send('secret of ' + u.host, 'text/plain');
    return send(pages.pluginHtml, 'text/html', csp);
  }));
}

async function openShell(query, opts) {
  const win = new BrowserWindow({ show: !!(opts && opts.show), x: 0, y: 0, width: 1100, height: 800, webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  await win.loadURL('cyborg-shell://app/index.html?' + query);
  const n = +(new URLSearchParams(query).get('frames') || 0);
  for (let i = 0; i < 100; i++) {
    const st = await win.webContents.executeJavaScript('JSON.stringify({loaded: __state.loaded, reports: Object.keys(__state.reports).length})');
    const s = JSON.parse(st); if (s.loaded >= n && s.reports >= (query.includes('mode=local') ? 0 : n)) break; await sleep(100);
  }
  await sleep(1500);
  return win;
}

async function scenario(name, query) {
  mark('scenario ' + name);
  const win = await openShell(query);
  const snap = snapshot();
  const reports = JSON.parse(await win.webContents.executeJavaScript('JSON.stringify(__state.reports)'));
  win.destroy(); await sleep(1200);
  return { name, query, ...snap, firstReport: reports[0] || null, reportCount: Object.keys(reports).length };
}

app.on('window-all-closed', () => {});
async function main() {
  await app.whenReady();
  setupProtocols();
  ipcMain.handle('echo', (_e, x) => x);

  R.steps.baselineNoWindow = snapshot();
  const sc = [];
  sc.push(await scenario('оболочка без iframe', 'frames=0'));
  sc.push(await scenario('1 iframe (пустой)', 'frames=1&mode=empty'));
  sc.push(await scenario('10 iframe, разные origin (пустые)', 'frames=10&mode=empty&same=0'));
  sc.push(await scenario('10 iframe, один origin (пустые)', 'frames=10&mode=empty&same=1'));
  sc.push(await scenario('10 iframe с sandbox=allow-scripts (непрозрачный origin)', 'frames=10&mode=empty&same=1&sb=1'));
  sc.push(await scenario('10 терминалов xterm в одном документе (как сейчас)', 'frames=10&mode=local'));
  sc.push(await scenario('10 iframe с xterm, разные origin', 'frames=10&mode=xterm&same=0'));
  sc.push(await scenario('10 iframe с xterm, один origin', 'frames=10&mode=xterm&same=1'));
  R.steps.scenarios = sc;

  // Мост и задержки
  const win = await openShell('frames=1&mode=bridge&same=0');
  const host = utilityProcess.fork(path.join(__dirname, 'host.js'));
  await new Promise((res) => host.on('message', (m) => m && m.cmd === 'ready' && res()));
  const hostChan = new MessageChannelMain(); host.postMessage({ cmd: 'port' }, [hostChan.port2]); hostChan.port1.start();

  const bridge = {};
  // A. Сегодняшний путь: ipcRenderer.invoke в основную страницу
  bridge.ipcInvokeRttMicros = await win.webContents.executeJavaScript('runEcho(5000)');
  // B. Сегодняшний путь потока: webContents.send кусками по 64 КБ
  { const chunk = new Uint8Array(65536); const total = 200 * 1048576; const parts = total / chunk.length;
    await win.webContents.executeJavaScript('cy.resetBytes()'); const t = performance.now();
    for (let i = 0; i < parts; i++) win.webContents.send('data', chunk);
    for (let i = 0; i < 400; i++) { const b = await win.webContents.executeJavaScript('cy.bytes()'); if (b >= total) break; await sleep(25); }
    const dt = (performance.now() - t) / 1000; bridge.webContentsSendThroughput = { MB: total / 1048576, seconds: +dt.toFixed(2), MBps: Math.round(total / 1048576 / dt) }; }

  // C. Порт main -> iframe (через страницу оболочки)
  const ch = new MessageChannelMain(); const port = ch.port1; port.start();
  win.webContents.postMessage('port', { id: 0 }, [ch.port2]);
  await new Promise((res) => { port.once('message', (e) => e.data.cmd === 'hello' && res()); setTimeout(res, 4000); });
  bridge.portHandshake = 'ok';
  { const chunk = new Uint8Array(65536); const total = 200 * 1048576; const parts = total / chunk.length; const t = performance.now();
    for (let i = 0; i < parts; i++) port.postMessage(chunk);
    mark('C throughput'); const done = await TO(new Promise((res) => { port.on('message', function h(e) { if (e.data.cmd === 'done') { port.off('message', h); res(e.data); } }); port.postMessage({ cmd: 'end' }); }), 30000, 'port throughput');
    const dt = (performance.now() - t) / 1000; bridge.portToIframeThroughput = { MB: total / 1048576, receivedMB: Math.round(done.bytes / 1048576), seconds: +dt.toFixed(2), MBps: Math.round(total / 1048576 / dt) }; }
  // D. RTT iframe -> main -> iframe (эхо в main)
  { const onMsg = (e) => { if (e.data && e.data.ping !== undefined) port.postMessage({ pong: e.data.ping }); }; port.on('message', onMsg);
    const r = await new Promise((res) => { const h = (e) => { if (e.data.cmd === 'rtt-result') { port.off('message', h); res(e.data); } }; port.on('message', h); port.postMessage({ cmd: 'rtt', n: 5000 }); });
    port.off('message', onMsg); bridge.portRttViaMainMicros = r; }
  // E. RTT iframe -> main -> хост плагина -> main -> iframe
  { const onMsg = (e) => { if (e.data && e.data.ping !== undefined) hostChan.port1.postMessage({ ping: e.data.ping }); }; const onHost = (e) => { if (e.data && e.data.pong !== undefined) port.postMessage({ pong: e.data.pong }); };
    port.on('message', onMsg); hostChan.port1.on('message', onHost);
    const r = await new Promise((res) => { const h = (e) => { if (e.data.cmd === 'rtt-result') { port.off('message', h); res(e.data); } }; port.on('message', h); port.postMessage({ cmd: 'rtt', n: 5000 }); });
    port.off('message', onMsg); hostChan.port1.off('message', onHost); bridge.portRttViaHostMicros = r; }
  // F. Прямой путь хост плагина -> iframe (порт создаёт main и раздаёт концы, сам в потоке не участвует)
  { const h2 = utilityProcess.fork(path.join(__dirname, 'host.js')); await new Promise((res) => h2.on('message', (m) => m && m.cmd === 'ready' && res()));
    const c2 = new MessageChannelMain(); h2.postMessage({ cmd: 'port' }, [c2.port1]); win.webContents.postMessage('port', { id: 0 }, [c2.port2]); await sleep(600);
    const parts = (200 * 1048576) / 65536; const t = performance.now();
    mark('F blast'); h2.postMessage({ cmd: 'blast', parts }); const done = await TO(new Promise((res) => h2.on('message', function f(m) { if (m && m.cmd === 'blast-done') { h2.off('message', f); res(m); } })), 30000, 'direct blast');
    const dt = (performance.now() - t) / 1000; bridge.directHostToIframeThroughput = { MB: 200, receivedMB: Math.round(done.bytes / 1048576), seconds: +dt.toFixed(2), MBps: Math.round(200 / dt) };
    mark('F rtt'); h2.postMessage({ cmd: 'rtt', n: 5000 }); bridge.directHostIframeRtt = await TO(new Promise((res) => h2.on('message', function f(m) { if (m && m.cmd === 'direct-rtt') { h2.off('message', f); res(m); } })), 30000, 'direct rtt');
    h2.kill(); }
  R.steps.bridge = bridge;
  host.kill(); win.destroy(); await sleep(800);

  // Клавиши: фокус внутри iframe, before-input-event
  const keys = {};
  for (const swallow of [false, true]) {
    const w = await openShell('frames=1&mode=keys&same=0', { show: true });
    const log = []; w.webContents.on('before-input-event', (e, input) => { log.push(`${input.type}:${input.key}${input.control ? '+ctrl' : ''}${input.shift ? '+shift' : ''}`); if (swallow && input.type === 'keyDown' && input.key === 'F' && input.control && input.shift) e.preventDefault(); });
    w.focus(); w.webContents.focus();
    await w.webContents.executeJavaScript("document.getElementById('ctl').focus()");
    log.length = 0; w.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F', modifiers: ['control', 'shift'] }); w.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F', modifiers: ['control', 'shift'] }); await sleep(300);
    const control = [...log]; log.length = 0;
    await w.webContents.executeJavaScript("document.getElementById('f_0').focus()");
    const frame = w.webContents.mainFrame.frames[0];
    await frame.executeJavaScript('window.focus(); document.body.tabIndex = 0; document.body.focus(); 1');
    await sleep(500);
    const focusInfo = await w.webContents.executeJavaScript("document.activeElement && document.activeElement.tagName");
    for (const type of ['keyDown', 'keyUp']) w.webContents.sendInputEvent({ type, keyCode: 'F', modifiers: ['control', 'shift'] });
    for (const type of ['keyDown', 'keyUp']) w.webContents.sendInputEvent({ type, keyCode: 'C', modifiers: ['control'] });
    await sleep(500);
    const inFrame = await frame.executeJavaScript('JSON.stringify(window.__keys)');
    // и через CDP
    let cdp = null; try { w.webContents.debugger.attach('1.3'); log.length = 0; await frame.executeJavaScript('window.__keys.length = 0; 1');
      await w.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 2 | 8, windowsVirtualKeyCode: 70, key: 'F', code: 'KeyF' });
      await w.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2 | 8, windowsVirtualKeyCode: 70, key: 'F', code: 'KeyF' });
      await sleep(400); cdp = { beforeInput: [...log], inFrame: await frame.executeJavaScript('JSON.stringify(window.__keys)') }; w.webContents.debugger.detach(); } catch (e) { cdp = 'ERR ' + e.message; }
    keys[swallow ? 'preventDefault_in_before_input_event' : 'passthrough'] = { controlFocusInShellDocument_beforeInputEvent: control, activeElementInShell: focusInfo, sendInputEvent: { beforeInputEvent: log.slice(0, 8), receivedByIframePage: JSON.parse(inFrame) }, cdp };
    w.destroy(); await sleep(500);
  }
  R.steps.keys = keys;

  // Изоляция iframe: отчёт первой страницы уже в сценариях (firstReport)
  fs.writeFileSync(OUT, JSON.stringify(R, null, 2));
  app.quit();
}
setTimeout(() => { R.watchdog = 'партия не завершилась за 300 с'; fs.writeFileSync(OUT, JSON.stringify(R, null, 2)); process.exit(3); }, 300000);
main().catch((e) => { R.error = String(e && e.stack || e); fs.writeFileSync(OUT, JSON.stringify(R, null, 2)); app.quit(); });
