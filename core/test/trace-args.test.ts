import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SECRET_MARK } from '../src/log-text.ts';
import { describeArgs } from '../src/trace-args.ts';

// K-33 (#224): аргументы операции в записи трассы по флагу запуска `--trace-args`: текст, предел длины, вычёркивание секретов.

test('текст: строки, числа, булевы, вложенные объекты и массивы - JSON-подобная запись, ключи в кавычках', () => {
  assert.equal(describeArgs(['a', 1, true, null, undefined, { k: ['v', { n: 2 }] }], 4096, [], 0), '["a",1,true,null,undefined,{"k":["v",{"n":2}]}]');
  assert.equal(describeArgs([], 4096, [], 0), '[]');
});

test('текст: перевод строки и кавычка в строке экранируются, запись остаётся одной строкой', () => {
  assert.equal(describeArgs(['a"b\nc'], 4096, [], 0), '["a\\"b\\nc"]');
});

test('текст: буфер, карта, множество, функция и символ - метка вместо содержимого', () => {
  assert.equal(describeArgs([Buffer.alloc(7), new Uint16Array(3), new ArrayBuffer(5)], 4096, [], 0), '[[bytes 7],[bytes 6],[bytes 5]]');
  assert.equal(describeArgs([new Map([['a', 1]]), new Set([1, 2]), () => 1, Symbol('s'), 10n], 4096, [], 0), '[[Map 1],[Set 2],[function],[symbol],10n]');
});

test('предел: короче предела - как есть, без пометки; длиннее - голова и пометка с размером', () => {
  assert.equal(describeArgs(['abc'], 100, [], 0), '["abc"]');
  const text = describeArgs(['x'.repeat(1000)], 20, [], 1000);
  assert.ok(text.startsWith('["xxxxxxxxxxxxxxxxxx'), text);
  assert.match(text, /\[обрезано: всего \d+ Б\]$/);
  assert.ok(Buffer.byteLength(text.replace(/ \[обрезано.*$/, '')) <= 20, 'голова не длиннее предела');
});

test('предел: пометка называет размер аргументов из подсказки, когда обход остановился раньше конца', () => {
  assert.match(describeArgs(['x'.repeat(1_000_000)], 20, [], 1_000_000), /\[обрезано: всего 1000000 Б\]$/);
});

test('предел: многобайтовый символ на границе не разрезается', () => {
  const text = describeArgs(['я'.repeat(100)], 21, [], 200);
  const head = text.replace(/ \[обрезано.*$/, '');
  assert.ok(!head.includes('�'), 'разрезанный символ');
  assert.ok(Buffer.byteLength(head) <= 21);
});

test('секреты: значение вычёркивается в строке, в ключе и во вложенном объекте', () => {
  const secret = 'tok-1234-abcd';
  const text = describeArgs([secret, { [secret]: 1, deep: [`Bearer ${secret}`] }], 4096, [secret], 0);
  assert.ok(!text.includes(secret), text);
  assert.equal(text, `["${SECRET_MARK}",{"${SECRET_MARK}":1,"deep":["Bearer ${SECRET_MARK}"]}]`);
});

test('секреты: значение с кавычкой и переводом строки вычёркивается до экранирования', () => {
  const secret = 'ab"cd\nef';
  const text = describeArgs([`x ${secret} y`], 4096, [secret], 0);
  assert.equal(text, `["x ${SECRET_MARK} y"]`);
});

test('секреты: значение, которое разрезала бы граница предела, вычёркивается целиком', () => {
  const secret = 'S3CRET-VALUE-0123456789';
  // Предел 30: значение начинается на 25-м знаке строки и разрезалось бы границей, если вычёркивать после обрезки.
  const raw = `${'a'.repeat(25)}${secret}${'b'.repeat(500)}`;
  const text = describeArgs([raw], 30, [secret], 600);
  assert.ok(!text.includes('S3C'), text);
  assert.match(text, /\[обрезано/);
});

test('секреты: короче четырёх знаков не вычёркиваются (правило K-29), длинные раньше коротких', () => {
  assert.equal(describeArgs(['abc 12'], 4096, ['abc', '12'], 0), '["abc 12"]');
  assert.equal(describeArgs(['token-long'], 4096, ['token', 'token-long'], 0), `["${SECRET_MARK}"]`);
});

test('форма: цикл, глубина и число узлов ограничены - значение огромной формы не зацикливает обход и не стоит дороже предела', () => {
  const loop: Record<string, unknown> = { name: 'ab' };
  loop.self = loop;
  const text = describeArgs([loop], 4096, [], 10);
  assert.ok(text.length < 4096 + 100, `длина ${String(text.length)}`);
  const wide = describeArgs([Array.from({ length: 100_000 }, (_, i) => i)], 1_000_000, [], 800_000);
  assert.match(wide, /\[обрезано/, 'число узлов ограничено, запись помечена обрезанной');
  assert.ok(wide.length < 20_000, `длина ${String(wide.length)}`);
});

test('ST-4001/11: значение секрета: аргумент os:secrets.set с номером 1 пишется меткой без порога длины, прочие цели и номера не затронуты (K-33)', () => {
  assert.equal(describeArgs(['key', 'a'], 4096, [], 0, 'os:secrets.set'), `["key","${SECRET_MARK}"]`);
  assert.equal(describeArgs(['key', { v: 1 }], 4096, [], 0, 'os:secrets.set'), `["key","${SECRET_MARK}"]`);
  assert.equal(describeArgs(['key'], 4096, [], 0, 'os:secrets.set'), '["key"]', 'значения нет - нечего скрывать');
  assert.equal(describeArgs(['key', 'a'], 4096, [], 0, 'os:secrets.get'), '["key","a"]');
  assert.equal(describeArgs(['key', 'a'], 4096, [], 0), '["key","a"]');
  assert.equal(describeArgs('строка', 4096, [], 0, 'os:secrets.set'), '"строка"', 'не массив - форма не та, что у шлюза, не трогаем');
});
