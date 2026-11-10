import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bytesOf } from '../src/trace-size.ts';

// K-28 (FR-CH-4004): запись трассы несёт размер аргументов и результата, а не их содержимое.

test('размер: строка - байты UTF-8, буфер и типизированный массив - их длина, число - 8, булево - 1, ничто - 0', () => {
  assert.equal(bytesOf('abc'), 3);
  assert.equal(bytesOf('привет'), 12);
  assert.equal(bytesOf(Buffer.alloc(100)), 100);
  assert.equal(bytesOf(new Uint16Array(4)), 8);
  assert.equal(bytesOf(new ArrayBuffer(16)), 16);
  assert.equal(bytesOf(1.5), 8);
  assert.equal(bytesOf(true), 1);
  for (const nothing of [undefined, null, () => 1, Symbol('s'), 10n]) assert.equal(bytesOf(nothing), 0);
});

test('размер: объект и массив - сумма частей, ключи объекта входят; карты и множества не считаются', () => {
  assert.equal(bytesOf(['ab', 'c']), 3);
  assert.equal(bytesOf({ name: 'x', n: 1 }), 4 + 1 + 1 + 8);
  assert.equal(bytesOf({ a: { b: ['xyz'] } }), 1 + 1 + 3);
  assert.equal(bytesOf(new Map([['a', 'b']])), 0);
  assert.equal(bytesOf([[]]), 0);
});

test('размер: цикл не зацикливает счёт, глубина и число узлов ограничены - значение огромной формы не стоит дороже ограничения', () => {
  const loop: Record<string, unknown> = { name: 'ab' };
  loop.self = loop;
  const loopSize = bytesOf(loop);
  assert.ok(loopSize >= 6 && loopSize < 10_000, `размер цикла ${String(loopSize)}`);
  const wide = Array.from({ length: 100_000 }, () => 'x');
  assert.equal(bytesOf(wide), 1000, 'после 1000 узлов счёт останавливается: оценка снизу');
  let deep: unknown = 'leaf';
  for (let i = 0; i < 50; i++) deep = [deep];
  assert.equal(bytesOf(deep), 0, 'глубже предела вложенности счёт не идёт');
});
