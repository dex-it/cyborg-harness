// Спайк TR-20, пункт 4: как исполнить плагин из ПРОВЕРЕННЫХ байтов в процессе Node под --permission, не открывая файл повторно (docs/05-verification/spike-node-host.md).
// Ядро читает пакет один раз, проверяет подпись и хеши, и отдаёт хосту байты каналом `ipc`; хосту разрешено читать только свой вход (`--allow-fs-read=<этот файл>`).
// Способы: data: URL, module.registerHooks (виртуальная схема cyborg-verified: с графом модулей из памяти), vm.Script (cjs), vm.SourceTextModule (флаг --experimental-vm-modules)
// и контроль «с диска» - повторное открытие файла, которое под --permission должно упасть.
// Запуск: node playground/scripts/spike-node-host-load.mjs [--json] [--node-bin=<node>]; бинарник Electron в режиме Node берётся из пакета electron.
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SOURCES = {
  'plugin.mjs': "import { createHash } from 'node:crypto';\nimport helper from './helper.mjs';\nexport default { activate() { return `${helper} sha=${createHash('sha256').update('x').digest('hex').slice(0, 6)} perm=${typeof process.permission}`; } };\n",
  'helper.mjs': "export default 'помощник';\n",
  'bundle.mjs': "export default { activate() { return `бандл perm=${typeof process.permission}`; } };\n",
  'bundle.cjs': "module.exports = { activate() { return `cjs perm=${typeof module.require}/${typeof process.permission}`; } };\n",
};
const MODES = ['data-url', 'hooks', 'vm-script', 'vm-module', 'disk'];

async function host(mode) {
  const { default: vm } = await import('node:vm');
  const { registerHooks } = await import('node:module');
  process.once('message', async ({ files }) => {
    const src = Object.fromEntries(Object.entries(files).map(([name, base64]) => [name, Buffer.from(base64, 'base64').toString('utf8')]));
    const t0 = performance.now();
    const reply = {};
    try {
      if (mode === 'data-url') {
        reply.result = (await import(`data:text/javascript;base64,${Buffer.from(src['bundle.mjs']).toString('base64')}`)).default.activate();
      } else if (mode === 'hooks') {
        // Виртуальный URL: относительные импорты внутри пакета разрешаются в память, остальное (node:*) - обычным путём; файла на диске нет.
        registerHooks({
          resolve(specifier, context, next) {
            if (specifier.startsWith('cyborg-verified:')) return { url: specifier, shortCircuit: true, format: 'module' };
            if (context.parentURL?.startsWith('cyborg-verified:') && specifier.startsWith('./')) return { url: new URL(specifier, context.parentURL).href, shortCircuit: true, format: 'module' };
            return next(specifier, context);
          },
          load(url, context, next) {
            if (!url.startsWith('cyborg-verified:')) return next(url, context);
            const name = url.slice('cyborg-verified:/'.length);
            if (!(name in src)) throw new Error(`нет среди проверенных: ${name}`);
            return { format: 'module', source: src[name], shortCircuit: true };
          },
        });
        reply.result = (await import('cyborg-verified:/plugin.mjs')).default.activate();
      } else if (mode === 'vm-script') {
        const m = { exports: {} };
        new vm.Script(`(function (module, exports) {${src['bundle.cjs']}\n})`, { filename: 'cyborg-verified:/bundle.cjs' }).runInThisContext()(m, m.exports);
        reply.result = m.exports.activate();
      } else if (mode === 'vm-module') {
        const module = new vm.SourceTextModule(src['bundle.mjs'], { identifier: 'cyborg-verified:/bundle.mjs' });
        await module.link(() => {
          throw new Error('импортов нет');
        });
        await module.evaluate();
        reply.result = module.namespace.default.activate();
      } else {
        // Контроль: второе открытие файла по пути, как делает `import(путь)`.
        reply.result = (await import(pathToFileURL(process.argv[4]).href)).default.activate();
      }
    } catch (error) {
      reply.error = error.code ?? `${error.name}: ${error.message.slice(0, 100)}`;
    }
    reply.ms = Math.round((performance.now() - t0) * 100) / 100;
    process.send(reply);
  });
}

async function once(binary, mode, confined, env, diskFile) {
  // Канал json: V8 в бинарнике Electron новее, чем в стандартном Node, и advanced-сериализация между ними не читается (spike-node-host.md); байты едут base64.
  const files = Object.fromEntries(Object.entries(SOURCES).map(([name, text]) => [name, Buffer.from(text).toString('base64')]));
  const execArgv = [...(confined ? ['--permission', `--allow-fs-read=${import.meta.filename}`] : []), ...(mode === 'vm-module' ? ['--experimental-vm-modules', '--no-warnings'] : [])];
  const child = fork(import.meta.filename, ['--host', mode, diskFile], { execPath: binary, execArgv, env, serialization: 'json', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  const reply = await new Promise((resolve) => {
    child.once('message', resolve);
    child.once('exit', (code) => resolve({ error: `процесс вышел с кодом ${String(code)} до ответа` }));
    child.send({ files });
  });
  clearTimeout(timer);
  child.kill('SIGKILL');
  return reply;
}

export async function loadExperiment(binary, { electronAsNode = false } = {}) {
  const env = electronAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : {};
  const version = await new Promise((resolve) => {
    const child = fork(import.meta.filename, ['--version'], { execPath: binary, env, stdio: ['ignore', 'pipe', 'ignore', 'ipc'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.once('exit', () => resolve(out.trim()));
  });
  const rows = [];
  // Файл для контроля «с диска» лежит вне --allow-fs-read хоста; в нём тот же код, что дал бы повторный import после проверки.
  const diskDir = mkdtempSync(path.join(tmpdir(), 'cyborg-spike-load-'));
  const diskFile = path.join(diskDir, 'bundle.mjs');
  writeFileSync(diskFile, SOURCES['bundle.mjs']);
  try {
    for (const mode of MODES) for (const confined of [false, true]) rows.push({ mode, confined, ...(await once(binary, mode, confined, env, mode === 'disk' ? diskFile : '')) });
  } finally {
    rmSync(diskDir, { recursive: true, force: true });
  }
  return { binary, version, rows, sha: createHash('sha256').update(JSON.stringify(SOURCES)).digest('hex').slice(0, 8) };
}

if (process.argv[2] === '--version') {
  console.log(`node ${process.versions.node}${process.versions.electron ? ` (electron ${process.versions.electron})` : ''}`);
} else if (process.argv[2] === '--host') {
  await host(process.argv[3]);
} else if (process.argv[1] === import.meta.filename) {
  const argv = process.argv.slice(2);
  const electron = createRequire(import.meta.url)('electron');
  const results = [await loadExperiment(argv.find((a) => a.startsWith('--node-bin='))?.slice('--node-bin='.length) ?? process.execPath), await loadExperiment(electron, { electronAsNode: true })];
  if (argv.includes('--json')) console.log(JSON.stringify(results, null, 2));
  else
    for (const r of results) {
      console.log(`\n${r.version} (${r.binary})\nспособ | под --permission | результат | мс`);
      for (const row of r.rows) console.log(`  ${row.mode} | ${row.confined ? 'да' : 'нет'} | ${row.result ?? `ОТКАЗ ${row.error}`} | ${row.ms ?? '-'}`);
    }
}
