import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { waitFor } from './wait-for.ts';

test('waitFor: условие, ставшее истинным позже, возвращает значение пробы, а не ждёт предела', async () => {
  const started = Date.now();
  let calls = 0;
  const value = await waitFor('значение', () => (++calls >= 3 ? 'готово' : undefined), { timeout: 5000, interval: 5 });
  assert.equal(value, 'готово');
  assert.equal(calls, 3);
  assert.ok(Date.now() - started < 2000, 'ждал дольше, чем нужно условию');
});

test('waitFor: истинное с первой пробы не ждёт ни интервала', async () => {
  const started = Date.now();
  assert.equal(await waitFor('сразу', () => 'есть', { interval: 1000 }), 'есть');
  assert.ok(Date.now() - started < 500);
});

test('waitFor: false и undefined - ещё не готово; 0, пустая строка и null - готовое значение', async () => {
  const seq: unknown[] = [false, undefined, 0];
  const seen: unknown[] = [];
  assert.equal(await waitFor('значения', () => (seen.push(seq[seen.length]), seen.at(-1)), { interval: 1 }), 0);
  assert.equal(seen.length, 3);
  assert.equal(await waitFor('пустая строка', () => ''), '');
  assert.equal(await waitFor('null', () => null), null);
});

test('waitFor: асинхронная проба ждётся', async () => {
  let n = 0;
  assert.equal(await waitFor('асинхронная', async () => (await sleep(1), ++n === 2 ? n : false), { interval: 1 }), 2);
});

test('waitFor: по пределу падает с названием условия, сроком и числом проб; без пробы после предела', async () => {
  let calls = 0;
  const started = Date.now();
  await assert.rejects(
    waitFor('событие журнала', () => (calls++, false), { timeout: 100, interval: 10 }),
    (e: Error) => e.name === 'AssertionError' && e.message.includes('событие журнала: не дождались за 100 мс') && /проб: \d+/.test(e.message),
  );
  assert.ok(Date.now() - started < 1500, 'предел не соблюдён');
  assert.ok(calls >= 2);
});

test('waitFor: проба, бросающая исключение, повторяется; последнее исключение попадает в сообщение о пределе', async () => {
  let calls = 0;
  const flaky = () => {
    if (++calls < 3) throw new Error('ещё нет файла');
    return 'есть';
  };
  assert.equal(await waitFor('файл', flaky, { interval: 1 }), 'есть');
  await assert.rejects(
    waitFor('файл', () => {
      throw new Error('нет файла X');
    }, { timeout: 50, interval: 5 }),
    /файл: не дождались за 50 мс.*нет файла X/s,
  );
});

test('помощники тестов electron/test - побайтовые копии core/test: адаптер не импортирует из-за пределов electron/ (electron/test/boundary.test.ts), а расхождение копий сломало бы одинаковые правила ожидания и команд', () => {
  for (const name of ['wait-for.ts', 'run-command.ts']) {
    const original = readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
    const copy = readFileSync(new URL(`../../electron/test/${name}`, import.meta.url), 'utf8');
    assert.equal(copy, original, `electron/test/${name} разошёлся с core/test/${name}: скопируйте файл заново`);
  }
});
