// Страницы оболочки и плагинов (строки), отдаются через протоколы cyborg-shell и cyborg-plugin.
exports.shellHtml = `<!doctype html><meta charset="utf-8"><body><input id="ctl"><div id="local"></div><div id="frames"></div>
<script src="/shell.js"></script>`;

exports.shellJs = `
const q = new URLSearchParams(location.search);
const n = +q.get('frames') || 0, mode = q.get('mode') || 'empty', same = q.get('same') === '1', sb = q.get('sb') === '1';
window.__state = { loaded: 0, reports: {}, n };
const origin = (i) => 'cyborg-plugin://' + (same ? 'shared' : 'p' + i);
for (let i = 0; mode !== 'local' && i < n; i++) {
  const f = document.createElement('iframe');
  f.id = 'f_' + i; if (sb) f.setAttribute('sandbox', 'allow-scripts'); f.style.cssText = 'width:480px;height:300px;border:0';
  f.onload = () => { window.__state.loaded++; };
  f.src = origin(i) + '/index.html?m=' + mode + '&i=' + i;
  document.getElementById('frames').appendChild(f);
}
window.addEventListener('message', (ev) => {
  const d = ev.data;
  if (d && d.type === 'port') document.getElementById('f_' + d.id).contentWindow.postMessage({ type: 'port' }, sb ? '*' : origin(d.id), ev.ports);
  if (d && d.type === 'report') window.__state.reports[d.i] = d.results;
});
if (mode === 'local') {
  const s = document.createElement('script'); s.src = '/xterm.js';
  s.onload = () => {
    for (let i = 0; i < n; i++) {
      const el = document.createElement('div'); el.style.cssText = 'width:480px;height:300px'; document.getElementById('local').appendChild(el);
      const t = new Terminal({ cols: 80, rows: 20, scrollback: 1000 }); t.open(el);
      for (let k = 0; k < 300; k++) t.write('local terminal ' + i + ' line ' + k + ' ' + 'x'.repeat(40) + '\\r\\n');
    }
    window.__state.loaded = n;
  };
  document.body.appendChild(s);
}
window.runEcho = async (count) => { const rt = []; const T0 = performance.now(); for (let i = 0; i < count; i++) { const t = performance.now(); await cy.echo(i); rt.push((performance.now() - t) * 1000); } rt.sort((a, b) => a - b); const p = (x) => +rt[Math.min(rt.length - 1, Math.floor(rt.length * x))].toFixed(0); return { n: count, meanMicros: +(((performance.now() - T0) * 1000) / count).toFixed(1), p50: p(0.5), p95: p(0.95), p99: p(0.99) }; };
`;

exports.pluginHtml = `<!doctype html><meta charset="utf-8"><body><div id="t"></div>
<script>window.__inline = 1;</script>
<script src="/plugin.js"></script>`;

exports.pluginJs = `
const params = new URLSearchParams(location.search);
const mode = params.get('m') || 'empty', idx = params.get('i');
const results = { origin: location.origin, node: { require: typeof require, process: typeof process }, inlineScriptRan: window.__inline === 1 };
try { void parent.document.body; results.parentDom = 'ALLOWED'; } catch (e) { results.parentDom = 'blocked: ' + e.name; }
try { void top.cy; results.parentCy = 'ALLOWED'; } catch (e) { results.parentCy = 'blocked: ' + e.name; }
fetch('cyborg-plugin://other/x.txt').then((r) => { results.fetchOtherOrigin = 'ALLOWED ' + r.status; }).catch((e) => { results.fetchOtherOrigin = 'blocked: ' + e.message; });
fetch('https://example.com/').then((r) => { results.fetchInternet = 'ALLOWED ' + r.status; }).catch((e) => { results.fetchInternet = 'blocked: ' + e.message; });
window.__keys = [];
addEventListener('keydown', (e) => window.__keys.push(e.key + (e.ctrlKey ? '+ctrl' : '') + (e.shiftKey ? '+shift' : '')));
let port = null, bytes = 0;
addEventListener('message', (ev) => {
  if (ev.data && ev.data.type === 'port') {
    port = ev.ports[0];
    port.onmessage = async (e) => {
      const d = e.data;
      if (d instanceof Uint8Array) { bytes += d.byteLength; return; }
      if (d.cmd === 'end') { port.postMessage({ cmd: 'done', bytes }); bytes = 0; return; }
      if (d.cmd === 'rtt') {
        const rt = []; const T0 = performance.now();
        for (let i = 0; i < d.n; i++) { const t = performance.now(); const w = new Promise((res) => { port.__w = res; }); port.postMessage({ ping: i }); await w; rt.push((performance.now() - t) * 1000); }
        rt.sort((a, b) => a - b); const p = (x) => +rt[Math.min(rt.length - 1, Math.floor(rt.length * x))].toFixed(0);
        port.postMessage({ cmd: 'rtt-result', n: d.n, meanMicros: +(((performance.now() - T0) * 1000) / d.n).toFixed(1), p50: p(0.5), p95: p(0.95), p99: p(0.99) }); return;
      }
      if (d.pong !== undefined && port.__w) { const w = port.__w; port.__w = null; w(); }
    };
    port.postMessage({ cmd: 'hello', i: idx });
  }
});
function report() { parent.postMessage({ type: 'report', i: idx, results }, '*'); }
if (mode === 'xterm') {
  const s = document.createElement('script'); s.src = '/xterm.js';
  s.onload = () => {
    const t = new Terminal({ cols: 80, rows: 20, scrollback: 1000 }); t.open(document.getElementById('t'));
    for (let k = 0; k < 300; k++) t.write('plugin terminal ' + idx + ' line ' + k + ' ' + 'x'.repeat(40) + '\\r\\n');
    results.xterm = 'ok'; setTimeout(report, 300);
  };
  s.onerror = () => { results.xterm = 'load failed'; report(); };
  document.body.appendChild(s);
} else setTimeout(report, 400);
`;
