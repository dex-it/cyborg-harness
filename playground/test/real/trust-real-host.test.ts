// TR-01, TR-21, TR-22, TR-24 (docs/research/trust-and-isolation/06-work-plan.md): тесты-подделки на НАСТОЯЩЕМ Electron и настоящих процессах хостов.
// Не `npm test`: нужен Electron с дисплеем (Linux - xvfb-run), запуск - `npm run test:trust`, в CI шаг «доверие: нарушитель на настоящем utilityProcess и процессе Node».
// Нарушитель (playground/trust-probe/violator.ts) делает в хосте стороннего плагина то, что записала таблица 2.8 исследования; здесь результат сверяется с ожиданием по каждой строке
// и по двум способам запуска: `utility` (возврат на utilityProcess одной настройкой) и `node` (процесс Node под --permission и ограничителем ОС). Дыра записана как «ожидаемо открыто»
// со ссылкой на задачу, которая её закроет: когда задача закрывает строку, ожидание в `ROWS` переворачивается в том же коммите (иначе тест красный по правильной причине).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ModeReport, TrustReport } from '../../src/main/trust-probe.ts';
import { VAULT_TOKEN } from '../../trust-probe/contracts.ts';

const electron = createRequire(import.meta.url)('electron') as string;
const repo = fileURLToPath(new URL('../../..', import.meta.url));
/** Запускатель Linux, собранный `npm run build:confiner`; на macOS ограничитель - sandbox-exec из системы. */
const confineBinary = path.join(repo, 'electron', 'native', 'build', `${process.platform}-${process.arch}`, 'cyborg-confine');
/** Закрывает ли ограничитель ОС сеть на этой машине: Seatbelt на macOS, собранный запускатель на Linux. */
const confined = process.platform === 'darwin' || (process.platform === 'linux' && existsSync(confineBinary));

/** Запуск пробы: Electron с `--trust-probe=<файл>` (playground/src/main/trust-probe.ts); отчёт - JSON. Отдельный Node хоста стороннего плагина - Node, под которым идёт этот тест. */
async function runProbe(): Promise<TrustReport> {
  const dir = mkdtempSync(path.join(tmpdir(), 'cyborg-trust-real-'));
  const out = path.join(dir, 'report.json');
  try {
    const flags = [`--node-host=${process.execPath}`, ...(process.platform === 'linux' && confined ? [`--confiner-bin=${confineBinary}`] : [])];
    const child = spawn(electron, [repo, `--trust-probe=${out}`, `--user-data-dir=${path.join(dir, 'data')}`, ...flags, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])], { stdio: ['ignore', 'inherit', 'inherit'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), 150_000);
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    clearTimeout(timer);
    assert.equal(code, 0, `проба доверия завершилась с кодом ${String(code)}`);
    return JSON.parse(readFileSync(out, 'utf8')) as TrustReport;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

type Violator = NonNullable<ModeReport['violator']>;
type Verdict = 'open' | 'closed';

interface Row {
  /** Ключ критерия приёмки, если строка закрывает его (docs/05-verification/acceptance.md). */
  readonly key?: string;
  readonly what: string;
  /** Строка таблицы 2.8 исследования (или пояснение, если строки в таблице нет). */
  readonly table: string;
  /** Нарушителю удалось (дыра открыта) на этих данных? */
  readonly open: (v: Violator, report: ModeReport) => boolean;
  /** Ожидание сегодня по способу запуска стороннего хоста: открыто или закрыто. */
  readonly expected: { readonly utility: Verdict; readonly node: Verdict };
  /** Для открытой строки - почему она открыта и какая задача её закроет; ожидание перевернётся вместе с ней. */
  readonly until?: { readonly utility?: string; readonly node?: string };
}

const BY_RETURN = 'возврат на utilityProcess настройкой: запреты Node там не действуют';
const ROWS: readonly Row[] = [
  { key: 'ST-3010/3', what: 'process.permission определён (запреты Node действуют)', table: '«process.permission»', open: (v) => v.permission === 'undefined', expected: { utility: 'open', node: 'closed' }, until: { utility: BY_RETURN } },
  { key: 'ST-3001/11', what: 'видит токен главного процесса в process.env', table: '«Видит токен главного процесса»', open: (v) => v.envToken !== null, expected: { utility: 'closed', node: 'closed' } },
  { key: 'ST-3010/3', what: 'читает файл «ядра» через node:fs', table: '«Читает файл секретов ядра»', open: (v) => v.coreFile.includes('secret-of-core'), expected: { utility: 'open', node: 'closed' }, until: { utility: BY_RETURN } },
  { key: 'ST-3010/3', what: 'запускает процесс через child_process', table: '«Запускает процесс»', open: (v) => v.spawn === 'spawned', expected: { utility: 'open', node: 'closed' }, until: { utility: BY_RETURN } },
  { key: 'ST-3010/3', what: 'создаёт поток (worker_threads)', table: 'TR-21, критерий 3', open: (v) => v.worker === 'выполнено', expected: { utility: 'open', node: 'closed' }, until: { utility: BY_RETURN } },
  { key: 'ST-3010/3', what: 'загружает нативный аддон (process.dlopen)', table: 'TR-21, критерий 3', open: (v) => v.addon === 'выполнено' || (v.addon !== 'ERR_ACCESS_DENIED' && v.addon !== 'ERR_DLOPEN_DISABLED' && v.addon !== 'ERR_DLOPEN_FAILED'), expected: { utility: 'closed', node: 'closed' } },
  {
    key: 'ST-3010/3, ST-3010/6',
    what: 'открывает TCP-соединение',
    table: '«Открывает TCP-соединение»',
    open: (v, r) => v.tcp === 'connected' && (r.tcpConnections ?? 0) > 0,
    expected: { utility: 'open', node: confined ? 'closed' : 'open' },
    until: { utility: BY_RETURN, node: 'ограничитель ОС не собран на этой машине (TR-22b: npm run build:confiner)' },
  },
  { what: 'слушает «сырой» канал своего хоста (parentPort / ipc) и получает сообщения ядра', table: '«Слушает сырой parentPort»', open: (v) => v.raw.messages > 0, expected: { utility: 'open', node: 'open' }, until: { utility: BY_RETURN, node: 'канал принадлежит хосту, а сторонний плагин в нём один (соседей нет); не закрывается' } },
  { key: 'ST-3001/11', what: 'читает в сыром канале данные контракта чужого поставщика', table: '«Слушает сырой parentPort» (рассылка contracts, находка 3)', open: (v) => v.raw.contractData.includes(VAULT_TOKEN), expected: { utility: 'closed', node: 'closed' } },
  { what: 'пишет в канал хоста от имени соседа и ядро исполняет', table: '«Пишет в parentPort от имени соседа»: ядро знает хост по каналу', open: (v) => v.forged === 'ok', expected: { utility: 'closed', node: 'closed' } },
  { what: 'видит манифесты плагинов в init (listener встаёт при загрузке плагина, после init)', table: '«видит init с чужими манифестами»: в загрузчике init приходит до кода плагина', open: (v) => v.raw.initManifests.length > 0, expected: { utility: 'closed', node: 'closed' } },
];

describe('TR-01, TR-21, TR-22: нарушитель в хосте стороннего плагина на настоящем Electron', () => {
  let report: TrustReport;
  before(async () => {
    report = await runProbe();
  });

  for (const mode of ['utility', 'node'] as const) {
    const modeReport = (): ModeReport => {
      const found = report.modes[mode];
      assert.ok(found, `проход «${mode}» выполнен`);
      return found;
    };

    describe(mode === 'utility' ? 'сторонний плагин в utilityProcess (возврат одной настройкой)' : 'сторонний плагин - процесс Node под --permission и ограничителем ОС', () => {
      test('ST-1003/2: сторонний плагин в своём процессе, не в главном и не с соседом из поставки; просьба сгруппировать - host-isolated', () => {
        const run = modeReport();
        assert.equal(run.error, undefined);
        const { bystander, friend, violator } = run.hosts;
        for (const host of [bystander, friend, violator]) {
          assert.ok(host?.pid !== undefined, 'у хоста есть pid');
          assert.equal(host.reported, host.pid, 'код плагина исполняется в процессе, который ядро знает как хост');
          assert.notEqual(host.pid, report.mainPid, 'код плагина не в главном процессе');
        }
        assert.equal(new Set([bystander?.pid, friend?.pid, violator?.pid]).size, 3, 'три разных процесса');
        assert.deepEqual([bystander?.hostId, friend?.hostId, violator?.hostId], ['shared', 'friend', 'violator']);
        assert.ok(run.journal.includes('violator:host-isolated'), `журнал: ${run.journal.join(', ')}`);
        assert.ok(run.journal.includes('violator:third-party'));
      });

      test('подделка от имени соседа: ядро отвечает Unavailable (хост соседа другой), а не исполняет', () => {
        assert.equal(modeReport().violator?.forged, 'Unavailable');
      });

      test('потребитель из поставки в своём хосте получает данные поставщика', () => {
        assert.equal(modeReport().friendRead, VAULT_TOKEN);
      });

      test(`ST-3010/8, ST-3010/6: TR-24: уровень изоляции в журнале: встроенные - 1 (utilityProcess), сторонний - ${mode === 'utility' ? '1' : confined ? '3 при закрытой сети' : '2 при открытой сети'}; заявленное доказано, sandbox-ineffective нет`, () => {
        const run = modeReport();
        assert.equal(run.ineffective, undefined, `хост не доказал запреты: ${run.ineffective?.join('; ') ?? ''}`);
        assert.equal(run.isolation.bystander?.level, 1);
        assert.equal(run.isolation.friend?.level, 1);
        const violator = run.isolation.violator;
        if (mode === 'utility') {
          assert.equal(violator?.level, 1);
          assert.equal(violator.network, 'open');
          assert.match(violator.reason, /сторонний плагин в хосте utilityProcess.*переключён на utilityProcess настройкой.*НЕ закрыты/);
        } else {
          assert.ok(violator);
          assert.equal(violator.level, confined ? 3 : 2, `уровень: ${violator.reason}`);
          assert.equal(violator.network, confined ? 'closed' : 'open');
          assert.match(violator.reason, confined ? /ограничитель ОС/ : /Сеть и сокеты НЕ закрыты/);
        }
      });

      for (const row of ROWS) {
        const expected = row.expected[mode];
        const label = expected === 'open' ? `ожидаемо открыто (${row.until?.[mode] ?? '?'})` : 'закрыто';
        test(`${row.key === undefined ? '' : `${row.key}: `}нарушитель: ${row.what} - ${label}`, () => {
          const run = modeReport();
          assert.ok(run.violator, 'нарушитель вернул отчёт');
          const open = row.open(run.violator, run);
          assert.equal(
            open ? 'открыто' : 'закрыто',
            expected === 'open' ? 'открыто' : 'закрыто',
            `строка ${row.table} изменилась: поправьте ожидание в ROWS и таблицу «Статус реализации» (06-work-plan.md)`,
          );
        });
      }
    });
  }

  test('ST-3010/3: нарушитель в процессе Node: чтение вне каталога, процесс, поток и аддон - отказ; TCP закрыт ограничителем ОС или назван открытым; в utilityProcess всё это удаётся', () => {
    const node = report.modes.node?.violator;
    assert.ok(node, 'проход «node» выполнен');
    assert.equal(node.permission, 'object');
    assert.equal(node.coreFile, 'error:ERR_ACCESS_DENIED');
    assert.match(node.spawn, /ERR_ACCESS_DENIED/);
    assert.equal(node.worker, 'ERR_ACCESS_DENIED');
    assert.match(node.addon, /^ERR_(ACCESS_DENIED|DLOPEN_DISABLED)$/);
    assert.equal(node.tcp === 'connected', !confined, confined ? `при ограничителе ОС соединение закрыто: ${node.tcp}` : 'без ограничителя TCP открыт и записан открытым (уровень 2)');
    const utility = report.modes.utility.violator;
    assert.ok(utility);
    assert.equal(utility.permission, 'undefined');
    assert.ok(utility.coreFile.includes('secret-of-core') && utility.spawn === 'spawned' && utility.worker === 'выполнено' && utility.tcp === 'connected');
  });

  test('нарушитель в процессе Node получает канал ipc (process.send), в utilityProcess - parentPort', () => {
    assert.equal(report.modes.utility.violator?.channel, 'parentPort');
    assert.equal(report.modes.node?.violator?.channel, 'ipc');
  });

  test('ST-3009/3: TR-11 на хосте стороннего плагина (процесс Node): файл подменён сразу после проверки - хост исполняет проверенные байты; изменённый до проверки пакет не запущен', () => {
    assert.ok(report.verified, 'сценарий проверенных байтов выполнен');
    assert.equal(report.verified.diskAfter, 'EVIL', 'на диске после проверки подмена');
    assert.equal(report.verified.answer, 'GOOD', 'в хосте исполнен проверенный код');
    assert.ok(report.verified.pid !== undefined && report.verified.pid !== report.mainPid, 'код исполнен в отдельном процессе');
    assert.deepEqual(report.verified.refused, ['modified/enforce']);
  });
});
