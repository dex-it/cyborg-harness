// TR-21 (ADR-CH-0019, п. 3): кодек типов поверх канала `json`. Процесс Node с другим V8, чем у ядра в Electron, `advanced`-сериализацию не читает (docs/05-verification/spike-node-host.md),
// поэтому значения, которые переживает structuredClone, идут тегированным JSON; то, что structuredClone отвергает, отвергает и кодек.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeWire, encodeWire, jsonPort } from '../src/wire-codec.ts';
import type { Port } from '../src/rpc.ts';

/** Через настоящий JSON, как канал `fork` с `serialization: 'json'`. */
const roundTrip = (value: unknown): unknown => decodeWire(JSON.parse(JSON.stringify(encodeWire(value))) as unknown);

test('ST-3010/1: TR-21: Map, Set, Date, BigInt, Uint8Array, ArrayBuffer, типизированные массивы переживают канал json как после structuredClone', () => {
  const value = {
    map: new Map<string, unknown>([['a', { n: 1n }]]),
    set: new Set([1, 2]),
    date: new Date(1_700_000_000_000),
    badDate: new Date(Number.NaN),
    big: -(2n ** 70n),
    bytes: new Uint8Array([1, 2, 3]),
    buffer: Buffer.from([4, 5]),
    ab: new Uint8Array([9, 8, 7]).buffer,
    floats: new Float64Array([1.5, -0]),
    words: new Uint16Array([65_535, 2]),
    nested: { list: [[1], [2]] },
  };
  const back = roundTrip(value) as typeof value;
  assert.deepEqual(back.map, value.map);
  assert.deepEqual(back.set, value.set);
  assert.ok(back.date instanceof Date && back.date.getTime() === 1_700_000_000_000);
  assert.ok(Number.isNaN(back.badDate.getTime()));
  assert.equal(back.big, value.big);
  assert.ok(back.bytes instanceof Uint8Array);
  assert.deepEqual([...back.bytes], [1, 2, 3]);
  assert.ok(back.buffer instanceof Uint8Array);
  assert.deepEqual([...back.buffer], [4, 5]);
  assert.ok(back.ab instanceof ArrayBuffer);
  assert.deepEqual([...new Uint8Array(back.ab)], [9, 8, 7]);
  assert.ok(back.floats instanceof Float64Array && Object.is(back.floats[1], -0));
  assert.ok(back.words instanceof Uint16Array && back.words[0] === 65_535);
  assert.deepEqual(back.nested, value.nested);
});

test('ST-3010/1: TR-21: числа и пустоты, которые JSON теряет: NaN, Infinity, -0, undefined в массиве и в объекте, разреженный массив', () => {
  const sparse: number[] = [1];
  sparse[2] = 3;
  const back = roundTrip({ n: Number.NaN, inf: Number.POSITIVE_INFINITY, ninf: Number.NEGATIVE_INFINITY, zero: -0, list: [1, undefined, 3], obj: { a: undefined, b: 1 }, sparse }) as {
    n: number;
    inf: number;
    ninf: number;
    zero: number;
    list: unknown[];
    obj: Record<string, unknown>;
    sparse: unknown[];
  };
  assert.ok(Number.isNaN(back.n));
  assert.equal(back.inf, Infinity);
  assert.equal(back.ninf, -Infinity);
  assert.ok(Object.is(back.zero, -0));
  assert.deepEqual(back.list, [1, undefined, 3]);
  assert.equal(back.list.length, 3);
  assert.ok('a' in back.obj && back.obj.a === undefined && back.obj.b === 1);
  assert.equal(back.sparse.length, 3);
  assert.ok(!(1 in back.sparse));
});

test('ST-3010/1: TR-21: Error с причиной и RegExp сохраняют тип и поля', () => {
  const error = new RangeError('мимо', { cause: new TypeError('причина') });
  const back = roundTrip({ error, re: /a+/gi }) as { error: RangeError; re: RegExp };
  assert.ok(back.error instanceof RangeError);
  assert.equal(back.error.message, 'мимо');
  assert.ok(back.error.cause instanceof TypeError);
  assert.equal(back.error.cause.message, 'причина');
  assert.equal(back.error.stack, error.stack);
  assert.ok(back.re instanceof RegExp);
  assert.equal(String(back.re), '/a+/gi');
});

test('ST-3010/1: TR-21: ключи, совпадающие с тегами кодека и «__proto__», остаются данными и не меняют прототип', () => {
  const evil = JSON.parse('{"$t":"Map","v":[["x",1]],"__proto__":{"polluted":true}}') as unknown;
  const back = roundTrip(evil) as Record<string, unknown>;
  assert.deepEqual(Object.keys(back).sort(), ['$t', '__proto__', 'v']);
  assert.equal(back.$t, 'Map');
  assert.equal(Object.getPrototypeOf(back), Object.prototype);
  assert.equal(({} as { polluted?: unknown }).polluted, undefined);
});

test('ST-3010/1: TR-21: то, что structuredClone отвергает, отвергает и кодек: функция, Symbol, Promise, WeakMap, циклическая ссылка', () => {
  const loop: Record<string, unknown> = {};
  loop.self = loop;
  for (const [what, value] of [['функция', { cb: () => 0 }], ['Symbol', { s: Symbol('x') }], ['Promise', { p: Promise.resolve(1) }], ['WeakMap', { w: new WeakMap() }], ['цикл', loop]] as const) {
    assert.throws(() => encodeWire(value), /DataCloneError|не переживёт/, what);
  }
});

test('ST-3010/1: TR-21: экземпляр класса идёт как простой объект с собственными полями, как после structuredClone', () => {
  class Point {
    x = 1;
    get y(): number {
      return this.x + 1;
    }
  }
  const back = roundTrip(new Point()) as object;
  assert.deepEqual(back, { x: 1 });
  assert.equal(Object.getPrototypeOf(back), Object.prototype);
});

test('ST-3010/1: TR-21: недоверенный вход: тег с неверной формой даёт ошибку разбора, а не исключение из недр; неизвестный тег - ошибка', () => {
  for (const raw of [{ $t: 'Map', v: 5 }, { $t: 'BigInt', v: 'не число' }, { $t: 'nope' }, { $t: 'ta', n: 'Function', v: '' }, { $t: 'Date', v: 'x' }, { $t: 'Error', n: 'Error' }]) {
    assert.throws(() => decodeWire(raw), /кодек|канал/i, JSON.stringify(raw));
  }
});

test('ST-3010/1: TR-21: jsonPort кодирует исходящее и разбирает входящее, не трогая порт под ним', () => {
  const sent: unknown[] = [];
  const listeners: ((m: unknown) => void)[] = [];
  const raw: Port = { post: (m) => void sent.push(JSON.parse(JSON.stringify(m))), onMessage: (l) => void listeners.push(l) };
  const port = jsonPort(raw);
  port.post({ t: 'req', p: new Map([[1, 2]]) });
  assert.deepEqual(sent, [{ t: 'req', p: { $t: 'Map', v: [[1, 2]] } }]);
  const got: unknown[] = [];
  port.onMessage((m) => void got.push(m));
  listeners[0]?.({ t: 'res', v: { $t: 'Set', v: [1] } });
  assert.deepEqual(got, [{ t: 'res', v: new Set([1]) }]);
  // Недоверенное сообщение, которое не разобралось, до обработчика не доходит.
  listeners[0]?.({ t: 'res', v: { $t: 'nope' } });
  assert.equal(got.length, 1);
});

test('ST-3010/1: TR-21: значение, которое JSON переживает без потерь, идёт как есть, без копии с тегами (горячий путь: pty.data, ответы ctx.os); любое исключение уходит полным путём', () => {
  const plain = { t: 'note', m: 'pty.data', p: { pluginId: 'x', data: 'abc', list: [1, 'a', null, { n: 2.5 }] } };
  assert.equal(encodeWire(plain), plain, 'простое дерево не копируется');
  assert.equal(decodeWire(plain), plain, 'разобранный JSON без тегов не копируется');
  const sparse: number[] = [1];
  sparse[2] = 3;
  for (const odd of [{ a: undefined }, { n: -0 }, { n: Number.NaN }, sparse, { d: new Date(0) }, { $t: 'x' }, Object.create({ inherited: 1 }) as object]) {
    assert.notEqual(encodeWire(odd), odd, `${JSON.stringify(odd)} требует тегов`);
  }
  assert.equal(JSON.stringify(encodeWire({ a: [1, { b: 'c' }] })), '{"a":[1,{"b":"c"}]}');
});
