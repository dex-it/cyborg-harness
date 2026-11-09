import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { checkSnapshot, compareWithBase, normalizeDeclarations, parseSnapshot, readSnapshot, renderSnapshot } from '../scripts/api.ts';
import { buildDeclarations } from '../scripts/build.ts';

// P-01, п. 6: изменение публичных деклараций без повышения версии пакета роняет CI. Снимок лежит в репозитории, база для сравнения - снимок в ветке, в которую идёт PR.
const contracts = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(contracts, 'package.json'), 'utf8')) as { version: string };

function built(): string {
  const out = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cyborg-contracts-api-'));
  buildDeclarations(out);
  return out;
}

describe('нормализация деклараций', () => {
  it('убирает комментарии и различия форматирования, порядок файлов фиксирован', () => {
    const a = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cyborg-contracts-norm-'));
    const b = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cyborg-contracts-norm-'));
    fs.writeFileSync(path.join(a, 'z.d.ts'), '/** doc */\nexport interface X {\n    /** m */\n    a: number; // tail\n}\n');
    fs.writeFileSync(path.join(a, 'a.d.ts'), 'export type Y = string;\n');
    fs.writeFileSync(path.join(b, 'a.d.ts'), 'export   type Y   =   string;');
    fs.writeFileSync(path.join(b, 'z.d.ts'), 'export interface X { a: number }');
    assert.equal(normalizeDeclarations(a), normalizeDeclarations(b));
    assert.doesNotMatch(normalizeDeclarations(a), /doc|tail/);
    assert.ok(normalizeDeclarations(a).indexOf('a.d.ts') < normalizeDeclarations(a).indexOf('z.d.ts'));
    fs.rmSync(a, { recursive: true });
    fs.rmSync(b, { recursive: true });
  });

  it('снимок читается обратно: версия и тело', () => {
    const text = renderSnapshot('1.2.3', 'body\n');
    assert.deepEqual(parseSnapshot(text), { version: '1.2.3', body: 'body\n' });
    assert.throws(() => parseSnapshot('нет заголовка'), /заголовка/);
  });
});

describe('сравнение с базой', () => {
  const base = { version: '1.0.0', body: 'A' };
  it('те же декларации и версия - без замечаний', () => {
    assert.deepEqual(compareWithBase(base, { version: '1.0.0', body: 'A' }), []);
  });
  it('декларации изменены, версия прежняя - ошибка', () => {
    const problems = compareWithBase(base, { version: '1.0.0', body: 'B' });
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /без повышения версии/);
  });
  it('декларации изменены, версия повышена - можно (минор, мажор, патч)', () => {
    for (const version of ['1.0.1', '1.1.0', '2.0.0']) assert.deepEqual(compareWithBase(base, { version, body: 'B' }), []);
  });
  it('версия повышена без правки деклараций - можно (выпуск документации)', () => {
    assert.deepEqual(compareWithBase(base, { version: '1.0.1', body: 'A' }), []);
  });
  it('версия понижена - ошибка, даже если декларации те же', () => {
    assert.match(compareWithBase({ version: '1.1.0', body: 'A' }, { version: '1.0.9', body: 'A' })[0]!, /понижена/);
  });
  it('линия разработки до первого выпуска (1.0.0-dev): декларации меняются без повышения версии', () => {
    const dev = { version: '1.0.0-dev', body: 'A' };
    assert.deepEqual(compareWithBase(dev, { version: '1.0.0-dev', body: 'B' }), []);
    assert.deepEqual(compareWithBase(dev, { version: '1.0.0', body: 'B' }), [], 'выпуск 1.0.0 из линии разработки');
  });
  it('после выпуска возврат на предрелиз тех же чисел - понижение', () => {
    assert.match(compareWithBase(base, { version: '1.0.0-dev', body: 'A' })[0]!, /понижена/);
  });
  it('базы нет (первый снимок) - без замечаний', () => {
    assert.deepEqual(compareWithBase(undefined, { version: '1.0.0', body: 'B' }), []);
  });
});

describe('снимок в репозитории', () => {
  it('совпадает с собранными декларациями и версией пакета', () => {
    const out = built();
    assert.deepEqual(checkSnapshot(out, pkg.version), []);
    fs.rmSync(out, { recursive: true });
  });

  it('устаревший снимок: на -dev просят только обновить снимок, у выпущенной версии - повысить версию', () => {
    const out = built();
    fs.appendFileSync(path.join(out, 'index.d.ts'), 'export type Extra = string;\n');
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cyborg-contracts-msg-'));
    const stale = path.join(dir, 'api-snapshot.txt');
    for (const [version, raise] of [['1.0.0-dev', false], ['1.2.0', true]] as const) {
      fs.writeFileSync(stale, renderSnapshot(version, 'устарело\n'));
      const problems = checkSnapshot(out, version, stale);
      assert.equal(problems.length, 1, problems.join('; '));
      assert.match(problems[0]!, /npm run snapshot:contracts/);
      assert.match(problems[0]!, /CHANGELOG\.md/);
      assert.equal(problems[0]!.includes('повысьте версию'), raise, `${version}: ${problems[0]}`);
    }
    fs.rmSync(out, { recursive: true });
    fs.rmSync(dir, { recursive: true });
  });

  it('правка карты Contracts или PluginContext без новой версии даёт ошибку, с новой версией и снимком - нет', () => {
    for (const [file, from, to] of [
      ['index.d.ts', "'cyborg.agent': {", "'cyborg.extra': {\n        1: unknown;\n    };\n    'cyborg.agent': {"],
      ['plugin.d.ts', 'export interface PluginContext {', 'export interface PluginContext {\n    extra(): void;'],
    ] as const) {
      const out = built();
      const text = fs.readFileSync(path.join(out, file), 'utf8');
      assert.ok(text.includes(from), `${file}: нет места правки`);
      fs.writeFileSync(path.join(out, file), text.replace(from, to));

      const problems = checkSnapshot(out, pkg.version);
      assert.equal(problems.length, 1, `${file}: ${problems.join('; ')}`);
      assert.match(problems[0]!, /изменены/);

      // Выпущенная версия (без суффикса -dev): автор повысил версию и обновил снимок - сравнение с базой проходит, без повышения - нет.
      const base = { version: '1.0.0', body: readSnapshot().body };
      const edited = { version: '1.0.0', body: parseSnapshot(renderSnapshot('1.0.0', normalizeDeclarations(out))).body };
      assert.match(compareWithBase(base, edited)[0]!, /без повышения версии/);
      assert.deepEqual(compareWithBase(base, { ...edited, version: '1.1.0' }), []);
      fs.rmSync(out, { recursive: true });
    }
  });
});
