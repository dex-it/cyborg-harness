// TR-01 (docs/research/trust-and-isolation/06-work-plan.md): тесты-подделки на НАСТОЯЩЕМ utilityProcess.
// Не `npm test`: нужен Electron с дисплеем (Linux - xvfb-run), запуск - `npm run test:trust`, в CI шаг «доверие: нарушитель на настоящем utilityProcess».
// Нарушитель (playground/trust-probe/violator.ts) делает в хосте стороннего плагина то, что записала таблица 2.8 исследования; здесь результат
// сверяется с ожиданием по каждой строке. Дыра записана как «ожидаемо открыто» со ссылкой на задачу, которая её закроет: когда задача
// закрывает строку, ожидание в `ROWS` переворачивается в том же коммите (иначе тест красный по правильной причине).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { TrustReport } from '../../src/main/trust-probe.ts';
import { VAULT_TOKEN } from '../../trust-probe/contracts.ts';

const electron = createRequire(import.meta.url)('electron') as string;
const repo = fileURLToPath(new URL('../../..', import.meta.url));

/** Запуск пробы: Electron с `--trust-probe=<файл>` (playground/src/main/trust-probe.ts); отчёт - JSON. */
async function runProbe(): Promise<TrustReport> {
  const dir = mkdtempSync(path.join(tmpdir(), 'cyborg-trust-real-'));
  const out = path.join(dir, 'report.json');
  try {
    const child = spawn(electron, [repo, `--trust-probe=${out}`, `--user-data-dir=${path.join(dir, 'data')}`, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])], { stdio: ['ignore', 'inherit', 'inherit'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    clearTimeout(timer);
    assert.equal(code, 0, `проба доверия завершилась с кодом ${String(code)}`);
    return JSON.parse(readFileSync(out, 'utf8')) as TrustReport;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

type Violator = NonNullable<TrustReport['violator']>;

interface Row {
  /** Ключ критерия приёмки, если строка закрывает его (docs/05-verification/acceptance.md). */
  readonly key?: string;
  readonly what: string;
  /** Строка таблицы 2.8 исследования (или пояснение, если строки в таблице нет). */
  readonly table: string;
  /** Нарушителю удалось (дыра открыта) на этих данных? */
  readonly open: (v: Violator, report: TrustReport) => boolean;
  /** Ожидание сегодня: открыто или закрыто. */
  readonly expected: 'open' | 'closed';
  /** Для открытой строки - задача, которая её закроет; ожидание перевернётся вместе с ней. */
  readonly until?: string;
}

const ROWS: readonly Row[] = [
  { what: 'process.permission определён (запреты Node действуют)', table: '«process.permission»', open: (v) => v.permission === 'undefined', expected: 'open', until: 'TR-21' },
  { key: 'ST-3001/11', what: 'видит токен главного процесса в process.env', table: '«Видит токен главного процесса»', open: (v) => v.envToken !== null, expected: 'closed' },
  { what: 'читает файл «ядра» через node:fs', table: '«Читает файл секретов ядра»', open: (v) => v.coreFile.includes('secret-of-core'), expected: 'open', until: 'TR-21' },
  { what: 'запускает процесс через child_process', table: '«Запускает процесс»', open: (v) => v.spawn === 'spawned', expected: 'open', until: 'TR-21' },
  { what: 'открывает TCP-соединение', table: '«Открывает TCP-соединение»', open: (v, r) => v.tcp === 'connected' && (r.tcpConnections ?? 0) > 0, expected: 'open', until: 'TR-22' },
  { what: 'слушает «сырой» process.parentPort и получает сообщения ядра', table: '«Слушает сырой parentPort»', open: (v) => v.raw.messages > 0, expected: 'open', until: 'TR-21' },
  { key: 'ST-3001/11', what: 'читает в сыром канале данные контракта чужого поставщика', table: '«Слушает сырой parentPort» (рассылка contracts, находка 3)', open: (v) => v.raw.contractData.includes(VAULT_TOKEN), expected: 'closed' },
  { what: 'пишет в parentPort от имени соседа и ядро исполняет', table: '«Пишет в parentPort от имени соседа»: ядро знает хост по каналу', open: (v) => v.forged === 'ok', expected: 'closed' },
  { what: 'видит манифесты плагинов в init (listener встаёт при загрузке плагина, после init)', table: '«видит init с чужими манифестами»: в загрузчике init приходит до кода плагина', open: (v) => v.raw.initManifests.length > 0, expected: 'closed' },
];

describe('TR-01: нарушитель в хосте стороннего плагина на настоящем utilityProcess', () => {
  let report: TrustReport;
  before(async () => {
    report = await runProbe();
  });

  test('ST-1003/2: сторонний плагин в своём процессе utilityProcess, не в главном и не с соседом из поставки; просьба сгруппировать - host-isolated', () => {
    assert.equal(report.error, undefined);
    const { bystander, friend, violator } = report.hosts;
    for (const host of [bystander, friend, violator]) {
      assert.ok(host?.pid !== undefined, 'у хоста есть pid utilityProcess');
      assert.equal(host.reported, host.pid, 'код плагина исполняется в процессе, который ядро знает как хост');
      assert.notEqual(host.pid, report.mainPid, 'код плагина не в главном процессе');
    }
    assert.equal(new Set([bystander?.pid, friend?.pid, violator?.pid]).size, 3, 'три разных процесса');
    assert.deepEqual([bystander?.hostId, friend?.hostId, violator?.hostId], ['shared', 'friend', 'violator']);
    assert.ok(report.journal.includes('violator:host-isolated'), `журнал: ${report.journal.join(', ')}`);
    assert.ok(report.journal.includes('violator:third-party'));
  });

  test('подделка от имени соседа: ядро отвечает Unavailable (хост соседа другой), а не исполняет', () => {
    assert.equal(report.violator?.forged, 'Unavailable');
  });

  test('потребитель из поставки в своём хосте получает данные поставщика', () => {
    assert.equal(report.friendRead, VAULT_TOKEN);
  });

  test('ST-3009/3: TR-11 на настоящем utilityProcess: файл подменён сразу после проверки - хост исполняет проверенные байты; изменённый до проверки пакет не запущен', () => {
    assert.ok(report.verified, 'сценарий проверенных байтов выполнен');
    assert.equal(report.verified.diskAfter, 'EVIL', 'на диске после проверки подмена');
    assert.equal(report.verified.answer, 'GOOD', 'в хосте исполнен проверенный код');
    assert.ok(report.verified.pid !== undefined && report.verified.pid !== report.mainPid, 'код исполнен в utilityProcess');
    assert.deepEqual(report.verified.refused, ['modified/enforce']);
  });

  for (const row of ROWS) {
    const label = row.expected === 'open' ? `ожидаемо открыто до ${row.until ?? '?'}` : 'закрыто';
    test(`${row.key === undefined ? '' : `${row.key}: `}нарушитель: ${row.what} - ${label}`, () => {
      assert.ok(report.violator, 'нарушитель вернул отчёт');
      const open = row.open(report.violator, report);
      assert.equal(
        open ? 'открыто' : 'закрыто',
        row.expected === 'open' ? 'открыто' : 'закрыто',
        `строка ${row.table} изменилась: поправьте ожидание в ROWS и таблицу «Статус реализации» (06-work-plan.md)`,
      );
    });
  }
});
