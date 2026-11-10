import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InputBudget } from '../src/pty-budget.ts';

// #167: потолок невычитанного ввода одного pty поверх ведра байт (#134). node-pty очередь записи не отдаёт, признак жизни программы - её вывод.

test('потолок: без вывода процесса ввод сверх ptyQueue отклоняется Invalid, отказанный ввод в счёт не идёт', () => {
  const budget = new InputBudget(10_000, 10_000, 300);
  budget.take(100);
  budget.take(100);
  budget.take(100);
  assert.throws(() => budget.take(1), { code: 'Invalid', message: /не читает ввод.*300/ });
  assert.throws(() => budget.take(100), { code: 'Invalid' }, 'отказ повторяется, пока программа молчит');
});

test('потолок: вывод процесса обнуляет счёт - программа жива и читает', () => {
  const budget = new InputBudget(10_000, 10_000, 300);
  budget.take(300);
  assert.throws(() => budget.take(1), { code: 'Invalid' });
  budget.heard();
  budget.take(300);
  assert.throws(() => budget.take(1), { code: 'Invalid' });
});

test('потолок: ввод целиком или Invalid - не принятая часть счёта и ведра не меняет', () => {
  let now = 0;
  const budget = new InputBudget(1000, 1000, 500, () => now);
  budget.take(400);
  assert.throws(() => budget.take(200), { code: 'Invalid', message: /не читает ввод/ }, 'потолок 500, принято 400');
  budget.take(100);
  now += 10_000;
  assert.throws(() => budget.take(1), { code: 'Invalid', message: /не читает ввод/ }, 'ведро пополнилось, потолок остался');
  // Ведро отказывает раньше потолка: запас 1000 исчерпан вводом, а потолок выше.
  const bucket = new InputBudget(100, 1, 10_000, () => now);
  bucket.take(100);
  assert.throws(() => bucket.take(1), { code: 'Invalid', message: /ввод быстрее/ });
});

test('потолок не задан - ведро работает как прежде', () => {
  const budget = new InputBudget(1000, 1, undefined, () => 0);
  budget.take(1000);
  assert.throws(() => budget.take(1), { code: 'Invalid', message: /ввод быстрее/ });
});
