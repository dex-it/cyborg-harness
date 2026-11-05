import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pluginOfOrigin, viewOrigin } from '../shared/views.ts';
import { resolveViewFile } from './view-files.ts';

const root = path.resolve('/plugins/alice/view');
const dirOf = (id: string) => (id === 'alice' ? root : undefined);

test('вид: origin называет плагин, чужая схема и мусор - не вид', () => {
  assert.equal(viewOrigin('cyborg.files'), 'cyborg-plugin://cyborg.files');
  assert.equal(pluginOfOrigin('cyborg-plugin://cyborg.files'), 'cyborg.files');
  assert.equal(pluginOfOrigin('file://'), undefined);
  assert.equal(pluginOfOrigin('cyborg-plugin://Alice:80'), undefined);
});

test('вид: файлы только из каталога своего плагина', () => {
  assert.deepEqual(resolveViewFile('cyborg-plugin://alice/', dirOf), { file: path.join(root, 'index.html'), type: 'text/html; charset=utf-8' });
  assert.equal(resolveViewFile('cyborg-plugin://alice/view.js?x=1', dirOf)?.file, path.join(root, 'view.js'));
  assert.equal(resolveViewFile('cyborg-plugin://alice/%2e%2e/index.mjs', dirOf), undefined, 'выход за каталог вида закодированными точками');
  assert.equal(resolveViewFile('cyborg-plugin://alice/..%2fmanifest.json', dirOf), undefined);
  assert.equal(resolveViewFile('cyborg-plugin://bob/index.html', dirOf), undefined, 'у плагина нет вида');
  assert.equal(resolveViewFile('cyborg-plugin://alice/secret.txt', dirOf), undefined, 'неизвестный тип не отдаётся');
  assert.equal(resolveViewFile('cyborg-plugin://alice/%E0%A4%A', dirOf), undefined);
});
