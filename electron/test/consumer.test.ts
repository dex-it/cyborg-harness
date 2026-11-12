import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { tryCommand } from './run-command.ts';

// P-03: пустой проект вне репозитория ставит три пакета из архивов `npm pack` (реестр не нужен), и `npm ls --all` не находит
// неудовлетворённых peer-зависимостей на контракты и ядро - в том числе когда контракты вышли предрелизом (`1.0.0-dev`:
// диапазон `^1.0.0` его не покрывает и даёт ERESOLVE). Peer на `electron` и `node-pty` приложение ставит само: их в проекте нет.
const pkg = path.resolve(import.meta.dirname, '..');
const root = path.resolve(pkg, '..');

let work = '';

const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')) as { version: string; peerDependencies?: Record<string, string> };
const own = readJson(path.join(pkg, 'package.json'));
/** Предрелиз контрактов проверяем, когда ядро в этом стеке уже принимает его (чинит #103: `>=1.0.0-0 <2.0.0` вместо `^1.0.0`). */
const corePeer = readJson(path.join(root, 'core', 'package.json')).peerDependencies?.['@cyborg-harness/contracts'] ?? '';
const coreTakesPrerelease = !corePeer.startsWith('^');

/** Команда с пределом времени: зависшая npm не должна держать весь `npm test`; при отказе в сообщение идёт её вывод (core/test/run-command.ts). */
const run = (cmd: string, args: string[], cwd: string): { code: number; out: string } => tryCommand(cmd, args, { cwd });

function pack(dir: string, into: string): string {
  fs.mkdirSync(into, { recursive: true });
  const done = run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', into], dir);
  assert.equal(done.code, 0, done.out);
  const [out] = JSON.parse(done.out) as [{ filename: string }];
  return path.join(into, out.filename);
}

/** Копия пакета контрактов с другой версией: предрелиз, как в ветках с `1.0.0-dev`. */
function contractsAs(version: string): string {
  const copy = path.join(work, `contracts-${version}`);
  fs.cpSync(path.join(root, 'contracts'), copy, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(copy, 'package.json'), 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(path.join(copy, 'package.json'), JSON.stringify({ ...manifest, version }));
  return copy;
}

describe('потребитель вне репозитория: peer-зависимости адаптера Electron', { timeout: 180_000 }, () => {
  before(() => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'cyborg-electron-consumer-'));
  });

  after(() => {
    fs.rmSync(work, { recursive: true, force: true });
  });

  for (const contracts of ['own', '1.0.0-dev']) {
    const skip = contracts !== 'own' && !coreTakesPrerelease ? `peer ядра на контракты ${corePeer} не покрывает предрелиз (правка в #103)` : false;
    it(`ST-6001/1, ST-6001/8: контракты ${contracts === 'own' ? 'из репозитория' : contracts}: архивы ставятся, peer на контракты и ядро выполнены`, { skip }, () => {
      const project = path.join(work, `app-${contracts}`);
      fs.mkdirSync(project);
      fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
      const tarballs = [
        pack(contracts === 'own' ? path.join(root, 'contracts') : contractsAs(contracts), path.join(work, `tar-${contracts}`)),
        pack(path.join(root, 'core'), path.join(work, `tar-${contracts}`)),
        pack(pkg, path.join(work, `tar-${contracts}`)),
      ];
      // `--legacy-peer-deps`: electron и node-pty (тяжёлые, нужны сети) не подтягиваются; проверку peer делает `npm ls` ниже.
      const install = run('npm', ['install', '--offline', '--no-audit', '--no-fund', '--ignore-scripts', '--legacy-peer-deps', ...tarballs], project);
      assert.equal(install.code, 0, install.out);
      const ls = run('npm', ['ls', '--all', '--offline', '--loglevel=error'], project);
      const problems = ls.out.split('\n').filter((line) => /^npm error (missing|invalid|peer dep|extraneous)/.test(line));
      assert.deepEqual(
        problems.sort(),
        [`npm error missing: electron@>=45, required by @cyborg-harness/electron@${own.version}`, `npm error missing: node-pty@^1.1.0, required by @cyborg-harness/electron@${own.version}`],
        `npm ls:\n${ls.out}`,
      );
    });
  }
});
