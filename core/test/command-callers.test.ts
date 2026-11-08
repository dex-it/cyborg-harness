import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseManifest } from '../src/manifest.ts';

const base = { version: '1.0.0', engines: { cyborg: '^1' } };

test('манифест: callers у команды - user по умолчанию, plugins открывает чужим главным частям; guard только при plugins', () => {
  const ok = parseManifest({
    ...base,
    id: 'sessions',
    commands: {
      'sessions.new': { args: ['string'] },
      'sessions.mine': { callers: 'user' },
      'sessions.actions': { args: ['string', 'number'], callers: 'plugins' },
      'sessions.open': { args: ['string'], callers: 'plugins', guard: { 'fs.read': 0 } },
      'sessions.cwd': { args: ['record'], callers: 'plugins', guard: { 'fs.read': '0.cwd', 'secrets.ref': '0.ref' } },
    },
  });
  assert.ok(ok.ok, ok.ok ? '' : ok.errors.join('\n'));
  const { commands } = ok.manifest;
  assert.equal(commands['sessions.new']?.callers, undefined, 'не объявлено - user');
  assert.equal(commands['sessions.mine']?.callers, 'user');
  assert.equal(commands['sessions.actions']?.callers, 'plugins');
  assert.deepEqual(commands['sessions.open']?.guard, [{ right: 'fs.read', arg: 0 }]);
  assert.deepEqual(commands['sessions.cwd']?.guard, [
    { right: 'fs.read', arg: 0, field: 'cwd' },
    { right: 'secrets.ref', arg: 0, field: 'ref' },
  ]);
  const list = parseManifest({ ...base, id: 'plain', commands: ['plain.go'] });
  assert.ok(list.ok);
  assert.equal(list.manifest.commands['plain.go']?.callers, undefined);
});

test('манифест: неизвестное значение callers и guard не у plugins отклоняются, ошибки собираются', () => {
  const bad = parseManifest({
    ...base,
    id: 'bad',
    commands: {
      'bad.a': { callers: 'everyone' },
      'bad.b': { callers: ['plugins'] },
      'bad.c': { guard: { 'fs.read': 0 } },
      'bad.d': { callers: 'user', guard: { 'fs.read': 0 } },
      'bad.e': { callers: 'plugins', guard: { process: 0 } },
      'bad.f': { callers: 'plugins', guard: { 'fs.read': -1 } },
      'bad.g': { callers: 'plugins', guard: {} },
      'bad.h': { callers: 'plugins', guard: [] },
    },
  });
  assert.ok(!bad.ok);
  assert.deepEqual(bad.errors, [
    'commands.bad.a.callers: ожидается "user" или "plugins", получено "everyone"',
    'commands.bad.b.callers: ожидается "user" или "plugins", получено ["plugins"]',
    'commands.bad.c.guard: проверяет аргумент для чужих главных частей - нужен callers: "plugins"',
    'commands.bad.d.guard: проверяет аргумент для чужих главных частей - нужен callers: "plugins"',
    'commands.bad.e.guard.process: право не для аргумента - допустимы fs.read, fs.write, shell, secrets.ref',
    'commands.bad.f.guard.fs.read: ожидается номер аргумента или "номер.поле"',
    'commands.bad.g.guard: ожидается { право: номер аргумента или "номер.поле" }',
    'commands.bad.h.guard: ожидается { право: номер аргумента или "номер.поле" }',
  ]);
});
