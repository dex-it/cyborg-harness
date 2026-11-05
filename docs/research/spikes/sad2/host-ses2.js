// Hardened JS: режимы lockdown и набор настоящих библиотек, исполняемых внутри Compartment.
const fs = require('node:fs');
const path = require('node:path');
const send = process.parentPort ? (m) => process.parentPort.postMessage(m) : (m) => process.send(m);
const mode = process.env.SES_MODE || 'default';
const res = { mode, steps: {}, libs: {} };
const step = (name, fn) => { try { res.steps[name] = fn(); } catch (e) { res.steps[name] = 'ERR ' + String(e && e.message || e).slice(0, 140); } };

require('ses');
const compat = { errorTaming: 'unsafe', overrideTaming: 'severe', consoleTaming: 'unsafe', stackFiltering: 'verbose' };
const t = performance.now();
lockdown(mode === 'compat' ? compat : {});
res.lockdownMs = +(performance.now() - t).toFixed(1);

const ctx = harden({ hello: (x) => 'ctx:' + x });
const P = (code, endow) => new Compartment({ ctx, ...(endow || {}) }).evaluate(code);

step('Date.now без endowment', () => P('String(Date.now())'));
step('Date.now с endowment Date', () => P('String(typeof Date.now() + " " + (Date.now() > 1e12))', { Date }));
step('Math.random без endowment', () => P('String(Math.random())'));
step('Math.random с endowment Math', () => P('String(typeof Math.random())', { Math }));
step('Error.prepareStackTrace', () => P(`(() => { try { Error.prepareStackTrace = () => 'x'; return 'ALLOWED' } catch (e) { return 'blocked: ' + e.name } })()`));
step('console без endowment', () => P('typeof console'));
step('setTimeout без endowment', () => P('typeof setTimeout'));
step('new Function', () => P(`(() => { try { return new Function('return 1')() } catch (e) { return 'blocked: ' + e.message.slice(0, 70) } })()`));
step('structuredClone', () => P('typeof structuredClone'));
step('TextEncoder / URL / AbortController', () => P('[typeof TextEncoder, typeof URL, typeof AbortController].join(",")'));
step('Promise / async', () => P('typeof Promise + " " + typeof (async () => 1)'));
step('Intl', () => P('typeof Intl + " " + new Intl.NumberFormat("ru-RU").format(1234.5)'));
step('Symbol.for глобальный реестр', () => P(`Symbol.for('x') === Symbol.for('x') ? 'shared registry' : 'ok'`));

const dir = path.join(__dirname, 'bundles');
const tests = {
  lodash: `Lib.chunk([1,2,3,4,5],2).length + ' ' + Lib.get({a:{b:3}},'a.b')`,
  'lodash.template': `Lib.template('hi <%= d.n %>', {variable: 'd'})({n: 'x'})`,
  zod: `(() => { const s = Lib.z.object({a: Lib.z.string()}); return JSON.stringify(s.safeParse({a: 'x'}).success) })()`,
  ajv: `(() => { const a = new Lib.default({}); const v = a.compile({type:'object', properties:{a:{type:'string'}}}); return String(v({a:'x'})) })()`,
  marked: `Lib.marked.parse('# hi **x**').trim()`,
  dayjs: `(Lib.default || Lib)('2026-11-05').add(1,'day').format('YYYY-MM-DD')`,
};
for (const [name, expr] of Object.entries(tests)) {
  const file = name === 'lodash.template' ? 'lodash.js' : name + '.js';
  const src = fs.readFileSync(path.join(dir, file), 'utf8');
  const entry = { load: '', run: '' };
  let c;
  const t0 = performance.now();
  try { c = new Compartment({ ctx, Date, Math, Intl, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, queueMicrotask }); const lib = c.evaluate('(function(global, self){ ' + src + '\n;return Lib })(globalThis, globalThis)'); c.globalThis.Lib = lib; entry.load = 'ok ' + (performance.now() - t0).toFixed(0) + ' ms'; }
  catch (e) { entry.load = 'ERR ' + String(e && e.message || e).slice(0, 140); }
  if (entry.load.startsWith('ok')) {
    try { entry.run = String(c.evaluate(expr)); } catch (e) { entry.run = 'ERR ' + String(e && e.message || e).slice(0, 140); }
  }
  res.libs[name] = entry;
}
send({ cmd: 'ses-result', res });
if (!process.parentPort) setTimeout(() => process.exit(0), 100);
