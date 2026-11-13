import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

// TR-07/TR-20: чтение и переключение фьюзов Electron своим кодом (playground/scripts/fuses.mjs), без пакета @electron/fuses.
type Fuses = Record<string, 'on' | 'off' | 'removed'>;
const fuses = (await import(pathToFileURL(path.resolve(import.meta.dirname, '..', 'scripts', 'fuses.mjs')).href)) as {
  SENTINEL: string;
  FUSE_NAMES: string[];
  fuseFile: (dist: string) => string;
  readFuses: (file: string) => Fuses;
  flipFuses: (file: string, changes: Record<string, boolean>) => void;
};

const wire = (state: string) => Buffer.concat([Buffer.from('MZ-мусор'), Buffer.from(fuses.SENTINEL), Buffer.from([1, state.length]), Buffer.from(state), Buffer.from('хвост')]);

function withFile<T>(content: Buffer, body: (file: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), 'cyborg-fuses-'));
  const file = path.join(dir, 'binary');
  writeFileSync(file, content);
  try {
    return body(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('фьюзы: состояние читается по sentinel и версии, переключается точечно; остальное в файле не меняется', () => {
  withFile(wire('101r00011'), (file) => {
    assert.deepEqual(fuses.readFuses(file), { RunAsNode: 'on', EnableCookieEncryption: 'off', EnableNodeOptionsEnvironmentVariable: 'on', EnableNodeCliInspectArguments: 'removed', EnableEmbeddedAsarIntegrityValidation: 'off', OnlyLoadAppFromAsar: 'off', LoadBrowserProcessSpecificV8Snapshot: 'off', GrantFileProtocolExtraPrivileges: 'on', WasmTrapHandlers: 'on' });
    const before = readFileSync(file);
    fuses.flipFuses(file, { RunAsNode: false, EnableCookieEncryption: true });
    const after = readFileSync(file);
    assert.equal(fuses.readFuses(file).RunAsNode, 'off');
    assert.equal(fuses.readFuses(file).EnableCookieEncryption, 'on');
    assert.equal(after.length, before.length);
    assert.equal(after.filter((byte, i) => byte !== before[i]).length, 2, 'изменились ровно два байта');
    assert.throws(() => fuses.flipFuses(file, { EnableNodeCliInspectArguments: false }), /удалён/);
    assert.throws(() => fuses.flipFuses(file, { НетТакого: true }), /нет фьюза/);
  });
});

test('фьюзы: нет провода, два провода и чужая версия - ошибка, а не молчаливое чтение', () => {
  withFile(Buffer.from('просто файл'), (file) => assert.throws(() => fuses.readFuses(file), /sentinel не найден/));
  withFile(Buffer.concat([wire('1'), wire('1')]), (file) => assert.throws(() => fuses.readFuses(file), /дважды/));
  withFile(Buffer.concat([Buffer.from(fuses.SENTINEL), Buffer.from([2, 1]), Buffer.from('1')]), (file) => assert.throws(() => fuses.readFuses(file), /версия провода/));
});

test('фьюзы: настоящий Electron из node_modules - 9 фьюзов в известном порядке и состояние по умолчанию, как в документации Electron', { skip: !existsSync(path.join(path.dirname(createRequire(import.meta.url).resolve('electron')), 'path.txt')) && 'бинарник Electron не скачан' }, () => {
  const dist = path.join(path.dirname(createRequire(import.meta.url).resolve('electron')), 'dist');
  const state = fuses.readFuses(fuses.fuseFile(dist));
  assert.deepEqual(Object.keys(state), fuses.FUSE_NAMES, 'имена и порядок фьюзов Electron 45 совпали с FuseV1Options @electron/fuses 2.1.3');
  // https://www.electronjs.org/docs/latest/tutorial/fuses: по умолчанию включены RunAsNode, NODE_OPTIONS, --inspect, права file://, ловушки Wasm; выключены шифрование cookie, проверка asar, только-asar, снимок V8.
  assert.deepEqual(Object.values(state), ['on', 'off', 'on', 'on', 'off', 'off', 'off', 'on', 'on']);
});
