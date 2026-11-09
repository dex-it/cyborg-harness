import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { quietPipes } from './quiet-pipes.ts';

const error = (code: string) => Object.assign(new Error(`write ${code}`), { code });

test('quietPipes: EPIPE на потерянном читателе вывода не поднимается как неперехваченное исключение', () => {
  const out = new PassThrough();
  assert.throws(() => out.emit('error', error('EPIPE')), /EPIPE/, 'без обработчика ошибка канала падает наружу');
  quietPipes([out]);
  assert.doesNotThrow(() => out.emit('error', error('EPIPE')));
});

test('quietPipes: прочие ошибки канала не прячутся', () => {
  const out = new PassThrough();
  quietPipes([out]);
  assert.throws(() => out.emit('error', error('EIO')), /EIO/);
});
