import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HOST_ENV_KEYS, hostEnv } from '../src/host-env.ts';

test('окружение хоста: только перечисленные переменные, токены и сокеты агента главного процесса не проходят', () => {
  const env = hostEnv({ PATH: '/usr/bin:/bin', GITHUB_TOKEN: 'ghp_secret', SSH_AUTH_SOCK: '/tmp/agent.sock', AWS_SECRET_ACCESS_KEY: 'aws', NODE_OPTIONS: '--require /tmp/x.js', HOME: '/Users/x' });
  assert.deepEqual(env, { PATH: '/usr/bin:/bin' });
  assert.deepEqual(Object.keys(env), HOST_ENV_KEYS.filter((key) => key === 'PATH'));
});

test('окружение хоста: переменной нет в источнике - её нет и в хосте (пустое значение не придумывается)', () => {
  assert.deepEqual(hostEnv({ GITHUB_TOKEN: 'ghp_secret' }), {});
  assert.deepEqual(hostEnv({ PATH: undefined }), {});
  assert.deepEqual(hostEnv({ PATH: '' }), { PATH: '' });
});

test('окружение хоста: по умолчанию берётся process.env, и чужих имён в результате нет', () => {
  const keys = Object.keys(hostEnv());
  assert.ok(keys.every((key) => HOST_ENV_KEYS.includes(key)), keys.join(', '));
});
