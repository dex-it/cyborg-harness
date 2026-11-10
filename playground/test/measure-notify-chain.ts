// Замер PL-02 (docs/05-verification/notify-chain.md): сколько проходит от записи хука claude в файл сессии до показа уведомления.
// Цепочка та же, что в окне: хук (настоящая команда из --settings) -> файл -> fs.watch и readSlice в agent-claude-code -> sessions -> cyborg.sessions -> session-notifications -> уведомление ядра;
// три плагина в трёх процессах ОС (forkHosts). Уведомление - подставная среда (в окне его показала бы ОС), claude - заглушка: замеряется цепочка плагинов, не рисование баннера.
// Запуск: `npm run spike:notify-chain` (`-- --samples=100 --json`). Нужны собранные пакеты (`npm run build:packages`).
import assert from 'node:assert/strict';
import { waitFor } from '../../core/test/wait-for.ts';
import { forkedRig } from './chain-rig.ts';

const option = (name: string, fallback: number): number => {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`--${name}: целое число больше нуля`);
  return value;
};
const samples = option('samples', 50);
const json = process.argv.includes('--json');

const quantile = (sorted: readonly number[], q: number): number => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? NaN;
const round = (n: number): number => Math.round(n * 10) / 10;
const stats = (values: readonly number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  return { min: round(sorted[0] ?? NaN), p50: round(quantile(sorted, 0.5)), p95: round(quantile(sorted, 0.95)), p99: round(quantile(sorted, 0.99)), max: round(quantile(sorted, 1)) };
};

await using s = await forkedRig();
s.k.emit({ kind: 'focus', focused: false });

// Что стоит один запуск хука без цепочки: процесс sh, cat, дозапись в файл. Он входит в «от старта хука», но не в «от записи».
const hookOnly: number[] = [];
// От конца хука (строка уже в файле) до показа: то, что вносят плагины и ядро.
const afterWrite: number[] = [];
// От старта хука: так видит ожидание человек, если считать от решения claude вызвать хук.
const fromStart: number[] = [];

for (let i = 0; i < samples + 5; i++) {
  const shown = s.notices.shown.length;
  const start = performance.now();
  await s.hook({ hook_event_name: 'Notification', notification_type: 'permission_prompt' });
  const written = performance.now();
  await waitFor('уведомление показано', () => s.notices.shown.length > shown, { interval: 1 });
  const notice = s.notices.shown[shown];
  assert.ok(notice);
  const at = notice.at;
  // Первые пять - прогрев (JIT, первые fs.watch); в итог не идут.
  if (i >= 5) {
    hookOnly.push(written - start);
    afterWrite.push(at - written);
    fromStart.push(at - start);
  }
  // Новая работа снимает уведомление, как в жизни; следующий образец идёт после снятия.
  await s.hook({ hook_event_name: 'UserPromptSubmit' });
  await waitFor('уведомление снято', () => notice.closed, { interval: 1 });
}

const out = (line: string) => process.stdout.write(`${line}\n`);
const result = { platform: `${process.platform} ${process.arch}`, node: process.version, samples, hookProcessMs: stats(hookOnly), writeToShownMs: stats(afterWrite), hookStartToShownMs: stats(fromStart) };
if (json) out(JSON.stringify({ ...result, raw: { writeToShownMs: afterWrite.map(round) } }));
else {
  out(`${result.platform}, Node ${result.node}, образцов: ${String(samples)} (после прогрева 5)`);
  out('мс             min    p50    p95    p99    max');
  for (const [name, v] of [['запуск хука', result.hookProcessMs], ['запись->показ', result.writeToShownMs], ['старт хука->показ', result.hookStartToShownMs]] as const) {
    out(`${name.padEnd(18)} ${[v.min, v.p50, v.p95, v.p99, v.max].map((n) => String(n).padStart(6)).join(' ')}`);
  }
}
