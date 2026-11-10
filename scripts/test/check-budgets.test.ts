import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { checkGateway, checkHosts, fails, main, parseMeasurement, render } from '../check-budgets.ts';
import type { Budgets } from '../check-budgets.ts';

// P-10: сверка замеров с порогами из playground/budgets.json. Замеры - образцы формы `spike-gateway.mjs --json` и `spike-hosts.mjs --json`.
const repo = path.resolve(import.meta.dirname, '..', '..');
const real = JSON.parse(fs.readFileSync(path.join(repo, 'playground', 'budgets.json'), 'utf8')) as Budgets;

const budgets: Budgets = {
  decision: { source: 'https://example.test/21', row: 6, date: '2026-11-07' },
  gateway: { callP99Ms: 1, watchP99Ms: 5, maxBytes: 65536, blocking: ['linux'], guarded: ['fs.readText', 'fs.watch', 'pty.write', 'secrets.get'], blockingMargin: 1.5 },
  hosts: { blocking: [], limits: { linux: { pssPerHostMb: null, callP99Ms: null }, darwin: { pssPerHostMb: null, callP99Ms: null } } },
};

const cost = (path: string, sizeBytes: number, pluginP99: number | null, gatewayP99: number | null = 0.1): { path: string; sizeBytes: number; pluginP99: number | null; gatewayP99: number | null } => ({ path, sizeBytes, pluginP99, gatewayP99 });

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});
function tmp(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cyborg-budgets-'));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

describe('файл порогов в репозитории', () => {
  it('числа решения D-00, строка 6, со ссылкой на задачу и норму', () => {
    assert.equal(real.decision.source, 'https://github.com/dex-it/cyborg-harness/issues/21');
    assert.equal(real.decision.row, 6);
    assert.equal(real.decision.date, '2026-11-07');
    assert.equal(real.gateway.callP99Ms, 1);
    assert.equal(real.gateway.watchP99Ms, 5);
    assert.equal(real.gateway.maxBytes, 65536);
    assert.deepEqual(real.gateway.blocking, ['linux']);
    assert.deepEqual(real.gateway.guarded, ['fs.readText', 'fs.watch', 'pty.write', 'secrets.get']);
    assert.equal(real.gateway.blockingMargin, 1.5);
    assert.ok(fs.existsSync(path.join(repo, 'docs', '03-requirements', '01-plugin-host', 'srs.md')));
  });

  it('память и старт без порогов: задание по хостам информационное, пока владелец не задал числа', () => {
    assert.deepEqual(real.hosts.blocking, []);
    for (const platform of ['linux', 'darwin']) assert.deepEqual(real.hosts.limits[platform], { pssPerHostMb: null, callP99Ms: null });
  });
});

describe('checkGateway', () => {
  it('цена в пределах порогов - ни одного превышения', () => {
    const findings = checkGateway(budgets, { costs: [cost('fs.readText', 64, 0.65), cost('fs.watch', 64, 0.9)], runs: [{ code: 0 }] }, 'linux');
    assert.deepEqual(findings.map((f) => f.over), [false, false]);
  });

  it('вызов дороже порога блокировки (бюджет 1 мс на запас 1,5) на Linux красит PR', () => {
    const [f] = checkGateway(budgets, { costs: [cost('pty.write', 65536, 1.6)] }, 'linux');
    assert.equal(f?.over, true);
    assert.equal(f.blocking, true);
    assert.equal(f.limit, 1);
    assert.equal(f.blockAbove, 1.5);
    assert.equal(fails(f), true);
  });

  it('между бюджетом и порогом блокировки - строка выше бюджета, но PR зелёный (запас на шум раннера)', () => {
    const [f] = checkGateway(budgets, { costs: [cost('fs.readText', 64, 1.2)] }, 'linux');
    assert.equal(f?.over, true);
    assert.equal(fails(f), false);
    assert.match(render('Шлюз', [f]), /выше бюджета, в запасе до 1\.5/);
  });

  it('не охраняемые пути (fs.readText.cold, net.fetch) шумят на раннере: выше порога, но не красят', () => {
    const findings = checkGateway(budgets, { costs: [cost('fs.readText.cold', 64, 2.6), cost('net.fetch', 65536, 1.4), cost('net.fetch.checked', 65536, 9)] }, 'linux');
    assert.deepEqual(findings.map((f) => [f.over, f.blocking, fails(f)]), [[true, false, false], [true, false, false], [true, false, false]]);
  });

  it('ровно на пороге - ещё в бюджете (не больше 1 мс)', () => {
    const [f] = checkGateway(budgets, { costs: [cost('fs.readText', 64, 1)] }, 'linux');
    assert.equal(f?.over, false);
  });

  it('fs.watch сверяется со своим порогом 5 мс, а не с порогом вызова', () => {
    const findings = checkGateway(budgets, { costs: [cost('fs.watch', 64, 3), cost('fs.watch', 64, 5.5), cost('fs.watch', 64, 8)] }, 'linux');
    assert.deepEqual(findings.map((f) => [f.limit, f.over, fails(f)]), [[5, false, false], [5, true, false], [5, true, true]]);
  });

  it('размер выше 64 КиБ справочный и в сверку не входит', () => {
    const findings = checkGateway(budgets, { costs: [cost('fs.readText', 1048576, 3.6), cost('fs.readText', 65536, 0.4)] }, 'linux');
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.over, false);
  });

  it('без цены из плагина берётся цена шлюза (net.fetch)', () => {
    const [f] = checkGateway(budgets, { costs: [cost('net.fetch', 64, null, 1.4)] }, 'linux');
    assert.equal(f?.value, 1.4);
    assert.equal(f.over, true);
  });

  it('на macOS превышение печатается, но не блокирует', () => {
    const [f] = checkGateway(budgets, { costs: [cost('fs.readText', 64, 2)] }, 'darwin');
    assert.equal(f?.over, true);
    assert.equal(f.blocking, false);
    assert.equal(fails(f), false);
  });

  it('прогон с ошибкой и пустой замер - тоже красные: замер, которого не было, не зелёный', () => {
    const failed = checkGateway(budgets, { costs: [cost('fs.readText', 64, 0.3)], runs: [{ code: 0 }, { code: 1, error: 'окно не открылось' }] }, 'linux');
    assert.equal(failed.some((f) => f.over && f.blocking && f.metric.includes('окно не открылось')), true);
    const empty = checkGateway(budgets, { costs: [] }, 'linux');
    assert.equal(empty.some((f) => f.over && f.blocking), true);
  });

  it('NaN вместо цены - превышение', () => {
    const [f] = checkGateway(budgets, { costs: [cost('fs.readText', 64, NaN, NaN)] }, 'linux');
    assert.equal(f?.over, true);
  });
});

describe('checkHosts', () => {
  const result = {
    memory: [
      { layout: 'один хост', pssPerHostMb: 56 },
      { layout: 'десять хостов', pssPerHostMb: 34.5 },
    ],
    calls: [
      { path: 'главный -> хост (команда)', sizeBytes: 64, p99: 0.4 },
      { path: 'главный -> хост (команда)', sizeBytes: 65536, p99: 0.64 },
      { path: 'разные хосты (контракт)', sizeBytes: 64, p99: 1.4 },
    ],
  };

  it('пока порогов нет (null), строки информационные и ничего не краснят', () => {
    const findings = checkHosts(budgets, result, 'linux', 65536);
    assert.deepEqual(findings.map((f) => [f.value, f.limit, f.over]), [[56, null, false], [0.64, null, false]]);
  });

  it('число в файле и платформа в blocking включают проверку; пороги у платформ свои', () => {
    const strict: Budgets = { ...budgets, hosts: { blocking: ['linux'], limits: { linux: { pssPerHostMb: 50, callP99Ms: 1 }, darwin: { pssPerHostMb: 500, callP99Ms: null } } } };
    const linux = checkHosts(strict, result, 'linux', 65536);
    assert.deepEqual(linux.map((f) => [f.over, f.blocking]), [[true, true], [false, true]]);
    const mac = checkHosts(strict, result, 'darwin', 65536);
    assert.deepEqual(mac.map((f) => [f.over, f.blocking]), [[false, false], [false, false]]);
  });

  it('ошибка замера хостов попадает в строку', () => {
    const findings = checkHosts({ ...budgets, hosts: { ...budgets.hosts, blocking: ['linux'] } }, { error: 'нет окна' }, 'linux', 65536);
    assert.equal(findings.some((f) => f.metric.includes('нет окна') && f.over && f.blocking), true);
  });
});

describe('parseMeasurement', () => {
  it('чистый JSON и JSON после посторонних строк Electron', () => {
    assert.deepEqual(parseMeasurement('{"a":1}'), { a: 1 });
    assert.deepEqual(parseMeasurement('[1234:ERROR] что-то\nещё строка\n{\n  "a": 2\n}\n'), { a: 2 });
  });

  it('после JSON строки Electron и xvfb (CI Linux: «Unexpected non-whitespace character after JSON»)', () => {
    const json = JSON.stringify({ a: 3, nested: { b: [1, 2] } }, null, 2);
    assert.deepEqual(parseMeasurement(`${json}\n[1234:0101/000000.000:ERROR:bus.cc(407)] Failed to connect\n`), { a: 3, nested: { b: [1, 2] } });
    assert.deepEqual(parseMeasurement(`Downloading Electron binary...\n${json}\nfontconfig: trailing\n{ не json }\n`), { a: 3, nested: { b: [1, 2] } });
  });

  it('без JSON - ошибка', () => {
    assert.throws(() => parseMeasurement('пусто'), /нет JSON/);
  });
});

describe('main: код выхода', () => {
  const files = (price: number): Record<string, string> => ({
    'budgets.json': JSON.stringify(budgets),
    'gateway.json': JSON.stringify({ costs: [cost('fs.readText', 64, price)], runs: [{ code: 0 }] }),
  });

  it('в бюджете - код 0 и таблица', () => {
    const dir = tmp(files(0.5));
    const result = main(['--gateway', 'gateway.json', '--budgets', 'budgets.json', '--platform', 'linux'], dir);
    assert.equal(result.code, 0);
    assert.match(result.out, /fs\.readText, 64 Б \| 0\.5 мс \| 1 мс \| в бюджете/);
  });

  it('искусственное ухудшение выше порога - код 1 с названием метрики', () => {
    const dir = tmp(files(1.7));
    const result = main(['--gateway', 'gateway.json', '--budgets', 'budgets.json', '--platform', 'linux'], dir);
    assert.equal(result.code, 1);
    assert.match(result.err, /бюджет превышен: fs\.readText, 64 Б 1\.7 мс при пороге блокировки 1\.5/);
    assert.match(result.out, /ПРЕВЫШЕН/);
  });

  it('та же цена на macOS - код 0, превышение только в таблице', () => {
    const dir = tmp(files(1.7));
    const result = main(['--gateway', 'gateway.json', '--budgets', 'budgets.json', '--platform', 'darwin'], dir);
    assert.equal(result.code, 0);
    assert.match(result.out, /выше бюджета, не блокирует/);
  });

  it('сводка дописывается в файл --summary', () => {
    const dir = tmp({ ...files(0.5), 'summary.md': 'раньше\n' });
    main(['--gateway', 'gateway.json', '--budgets', 'budgets.json', '--platform', 'linux', '--summary', 'summary.md'], dir);
    assert.match(fs.readFileSync(path.join(dir, 'summary.md'), 'utf8'), /^раньше\n[\s\S]*Шлюз ctx\.os/);
  });

  it('нет файла замера или не заданы входы - исключение, а не зелёный выход', () => {
    const dir = tmp({ 'budgets.json': JSON.stringify(budgets) });
    assert.throws(() => main(['--gateway', 'нет.json', '--budgets', 'budgets.json'], dir), /ENOENT/);
    assert.throws(() => main(['--budgets', 'budgets.json'], dir), /нужен --gateway/);
    assert.throws(() => main(['--gateway'], dir), /требует значение/);
  });
});

describe('render', () => {
  it('порог null - «не задан» и «информационно»', () => {
    const text = render('Хосты', [{ metric: 'память', value: 56, limit: null, unit: 'МБ', over: false, blocking: false, blockAbove: null }]);
    assert.match(text, /\| память \| 56 МБ \| не задан \| информационно \|/);
  });
});
