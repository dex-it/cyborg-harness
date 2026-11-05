import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowsMajor, satisfies, isValidRange } from '../src/semver.ts';
import { checkArgs, parseManifest, type CommandSpec } from '../src/manifest.ts';

test('диапазоны: каретка, тильда, префикс и звезда', () => {
  assert.ok(satisfies('1.4.0', '^1'));
  assert.ok(satisfies('1.9.9', '^1.4'));
  assert.ok(!satisfies('1.3.9', '^1.4'));
  assert.ok(!satisfies('2.0.0', '^1'));
  assert.ok(satisfies('0.2.5', '^0.2'));
  assert.ok(!satisfies('0.3.0', '^0.2'));
  assert.ok(!satisfies('0.0.4', '^0.0.3'));
  assert.ok(satisfies('1.2.9', '~1.2'));
  assert.ok(!satisfies('1.3.0', '~1.2'));
  assert.ok(satisfies('1.4', '1.4'));
  assert.ok(!satisfies('1.5', '1.4'));
  assert.ok(satisfies('7.0.0', '*'));
  assert.ok(!isValidRange('>=1'));
  assert.ok(!satisfies('1.x', '^1'));
});

test('allowsMajor: есть ли в диапазоне версия этой мажорной', () => {
  assert.ok(allowsMajor('^1.4', 1));
  assert.ok(!allowsMajor('^1.4', 2));
  assert.ok(!allowsMajor('^1.4', 0));
  assert.ok(allowsMajor('~0.2', 0));
  assert.ok(allowsMajor('*', 7));
  assert.ok(allowsMajor('2', 2));
  assert.ok(!allowsMajor('^1', 1.5));
  assert.ok(!allowsMajor('^1', -1));
});

const base = { id: 'pin-lock', version: '1.0.0', engines: { cyborg: '^1' } };

test('манифест: незнакомое поле верхнего уровня - отказ с именем поля, $schema разрешён', () => {
  const typo = parseManifest({ ...base, keybinding: [], lok: { onStart: true } });
  assert.deepEqual(typo, { ok: false, id: 'pin-lock', errors: ['keybinding: незнакомое поле манифеста', 'lok: незнакомое поле манифеста'] });
  assert.ok(parseManifest({ $schema: './manifest.schema.json', ...base }).ok);
});

test('манифест под другой API: при ошибках разбора одна причина - версия API', () => {
  const newer = { ...base, engines: { cyborg: '^1.3' }, layout: { kind: 'side' } };
  assert.deepEqual(parseManifest(newer, '1.2.0'), { ok: false, id: 'pin-lock', errors: ['engines.cyborg: нужен API Cyborg ^1.3, есть 1.2.0'] });
  assert.deepEqual(parseManifest(newer, '1.3.0'), { ok: false, id: 'pin-lock', errors: ['layout: незнакомое поле манифеста'] });
  assert.deepEqual(parseManifest(newer), { ok: false, id: 'pin-lock', errors: ['layout: незнакомое поле манифеста'] });
  assert.ok(parseManifest({ ...base, engines: { cyborg: '^2' } }, '1.2.0').ok, 'без ошибок разбора версию судит граф');
});

test('манифест: минимальный приводится к полной форме', () => {
  const r = parseManifest({ ...base, provides: { 'cyborg.lock': '1.0' } });
  assert.ok(r.ok);
  assert.deepEqual(r.manifest.provides, { 'cyborg.lock': ['1.0'] });
  assert.deepEqual(r.manifest.requires, {});
  assert.deepEqual(r.manifest.commands, {});
});

test('манифест: ошибки собираются все сразу и id сохраняется для журнала', () => {
  const r = parseManifest({
    ...base,
    version: 'one',
    engines: { cyborg: '>=1' },
    provides: { 'cyborg.lock': ['1.0', '1.2'] },
    requires: { 'cyborg.files': '^1' },
    optional: { 'cyborg.files': '^1' },
    commands: ['other.lock'],
    config: { version: 0 },
  });
  assert.ok(!r.ok);
  assert.equal(r.id, 'pin-lock');
  assert.equal(r.errors.length, 6);
});

test('манифест: контракт many не может быть одновременно one', () => {
  const r = parseManifest({ ...base, requires: { 'cyborg.tab': '^1' }, consumes: { 'cyborg.tab': '^1' } });
  assert.ok(!r.ok);
});

test('команды: список имён - без аргументов, объект - со схемой аргументов', () => {
  const short = parseManifest({ ...base, commands: ['pin-lock.lock'] });
  assert.ok(short.ok);
  assert.deepEqual(short.manifest.commands, { 'pin-lock.lock': { args: [] } });

  const full = parseManifest({ ...base, commands: { 'pin-lock.unlock': { args: ['string', 'number?'] }, 'pin-lock.log': { args: ['string'], rest: 'any' } } });
  assert.ok(full.ok);
  assert.deepEqual(full.manifest.commands['pin-lock.unlock'], {
    args: [
      { kind: 'string', optional: false },
      { kind: 'number', optional: true },
    ],
  });
  assert.equal(full.manifest.commands['pin-lock.log']?.rest, 'any');
});

test('команды: схема с ошибкой не проходит разбор', () => {
  const errors = (commands: unknown) => {
    const r = parseManifest({ ...base, commands });
    return r.ok ? '' : r.errors.join('\n');
  };
  assert.match(errors({ 'pin-lock.a': { args: ['date'] } }), /неизвестный вид "date"/);
  assert.match(errors({ 'pin-lock.a': { args: ['string?', 'number'] } }), /обязательный аргумент после необязательного/);
  assert.match(errors({ 'pin-lock.a': { args: ['string?'], rest: 'any' } }), /rest вместе с необязательными/);
  assert.match(errors({ 'pin-lock.a': { rest: 'thing' } }), /rest: неизвестный вид/);
  assert.match(errors({ 'pin-lock.a': 'string' }), /ожидается объект/);
  assert.match(errors({ 'other.a': {} }), /пространстве имён "pin-lock\."/);
  assert.match(errors(['pin-lock.a', 'pin-lock.a']), /имя повторяется/);
  assert.match(errors(5), /ожидается список имён или объект/);
});

test('команды: аргументы сверяются по числу и виду', () => {
  const spec: CommandSpec = {
    args: [
      { kind: 'string', optional: false },
      { kind: 'number', optional: true },
    ],
  };
  checkArgs('c', spec, ['a']);
  checkArgs('c', spec, ['a', 2]);
  assert.throws(() => checkArgs('c', spec, []), { code: 'Invalid', message: 'c: аргументов 0, ожидается 1-2' });
  assert.throws(() => checkArgs('c', spec, ['a', 2, 3]), { code: 'Invalid' });
  assert.throws(() => checkArgs('c', spec, [1]), { code: 'Invalid', message: 'c: аргумент 1 не string' });
  assert.throws(() => checkArgs('c', spec, ['a', Number.NaN]), { message: 'c: аргумент 2 не number' });

  const rest: CommandSpec = { args: [{ kind: 'string', optional: false }], rest: 'record' };
  checkArgs('r', rest, ['a', {}, {}]);
  assert.throws(() => checkArgs('r', rest, ['a', {}, []]), { message: 'r: аргумент 3 не record' });
  assert.throws(() => checkArgs('r', { args: [{ kind: 'any', optional: false }] }, [undefined]), { message: 'r: аргумент 1 не any' });
});
