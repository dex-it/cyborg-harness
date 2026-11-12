import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileSchema } from '../src/json-schema.ts';

const check = (schema: unknown, value: unknown) => {
  const c = compileSchema(schema);
  if (!c.ok) throw new Error(c.errors.join('; '));
  return c.check(value);
};

test('схема раздела: типы, поля, границы и путь ошибки', () => {
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    required: ['minutes'],
    properties: {
      minutes: { type: 'integer', minimum: 1, maximum: 60 },
      sound: { type: 'boolean' },
      mode: { enum: ['pin', 'password'] },
      keys: { type: 'array', items: { type: 'string', pattern: '^[A-Z]', minLength: 1 }, maxItems: 2, uniqueItems: true },
      'a/b': { const: { x: 1, y: 2 } },
    },
    additionalProperties: false,
  };
  assert.deepEqual(check(schema, { minutes: 5, sound: true, mode: 'pin', keys: ['L'], 'a/b': { y: 2, x: 1 } }), []);
  assert.deepEqual(check(schema, { minutes: 1.5, mode: 'x', keys: ['l', 'l', 'M'], 'a/b': {}, extra: 1 }), [
    '/minutes: ожидается integer, получено number',
    '/mode: допустимо "pin", "password"',
    '/keys/0: не подходит под ^[A-Z]',
    '/keys/1: не подходит под ^[A-Z]',
    '/keys: элементов <= 2',
    '/keys: элементы повторяются',
    '/a~1b: допустимо только {"x":1,"y":2}',
    '/extra: значение запрещено схемой',
  ]);
  assert.deepEqual(check(schema, {}), ['/minutes: обязательное поле']);
  assert.deepEqual(check(schema, []), ['/: ожидается object, получено array']);
  assert.deepEqual(check({ type: ['number', 'null'], exclusiveMinimum: 0 }, 0), ['/: ожидается > 0']);
  assert.deepEqual(check({ type: 'string', maxLength: 2 }, '😀😀'), [], 'длина в символах');
});

test('ST-5004/3: схема раздела: ключ вне подмножества и неверный ключ - ошибка схемы, а не пропуск', () => {
  const bad = compileSchema({ type: 'object', properties: { a: { $ref: '#/x' }, b: { type: 'date' } }, oneOf: [], pattern: '(' });
  if (bad.ok) throw new Error('схема с $ref и oneOf принята');
  assert.deepEqual(bad.errors, [
    '#/properties/a: ключ $ref не поддерживается',
    '#/properties/b/type: ожидается тип из object, array, string, number, integer, boolean, null или их список',
    '#: ключ oneOf не поддерживается',
    '#/pattern: ожидается регулярное выражение',
  ]);
  assert.equal(compileSchema('object').ok, false);
  assert.equal(compileSchema(true).ok, true);
});
