import { test } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { runCommand, tryCommand } from './run-command.ts';

const node = (script: string) => ['-e', script];

test('runCommand: успех отдаёт stdout', () => {
  assert.equal(runCommand(process.execPath, node('process.stdout.write("готово")')), 'готово');
});

test('runCommand: ненулевой выход - ошибка с командой, каталогом, stdout и stderr, а не безымянное «Command failed»', () => {
  assert.throws(
    () => runCommand(process.execPath, node('process.stdout.write("из stdout");process.stderr.write("из stderr");process.exit(3)'), { cwd: import.meta.dirname }),
    (e: Error) => e.message.includes('-e') && e.message.includes(import.meta.dirname) && e.message.includes('из stdout') && e.message.includes('из stderr'),
  );
});

test('runCommand: зависшая команда убивается по пределу, вывод до зависания остаётся в сообщении', () => {
  const started = Date.now();
  assert.throws(
    () => runCommand(process.execPath, node('process.stdout.write("начали");setInterval(()=>{},1000)'), { timeout: 400 }),
    (e: Error) => e.message.includes('начали') && /ETIMEDOUT|timed out|SIGKILL/.test(e.message),
  );
  assert.ok(Date.now() - started < 10_000, 'предел не сработал');
});

test('tryCommand: ненулевой выход - код и склеенный вывод; зависание и отсутствие программы - всё равно ошибка', () => {
  assert.deepEqual(tryCommand(process.execPath, node('process.stdout.write("a");process.stderr.write("b");process.exit(4)')), { code: 4, out: 'ab' });
  assert.deepEqual(tryCommand(process.execPath, node('process.stdout.write("x")')), { code: 0, out: 'x' });
  assert.throws(() => tryCommand(process.execPath, node('setInterval(()=>{},1000)'), { timeout: 300 }), /ETIMEDOUT|timed out|SIGKILL/);
  assert.throws(() => tryCommand('cyborg-такой-программы-нет', []), /ENOENT/);
});

test('runCommand: cwd и env доходят до команды, окружение процесса теста сохраняется под добавленным', () => {
  const script = 'process.stdout.write(process.cwd()+"|"+process.env.CYBORG_T13+"|"+(process.env.PATH===undefined?"нет PATH":"есть PATH"))';
  const out = runCommand(process.execPath, node(script), { cwd: import.meta.dirname, env: { CYBORG_T13: 'x' } });
  assert.equal(out, `${realpathSync(import.meta.dirname)}|x|есть PATH`);
});

test('runCommand: без cwd сообщение об отказе не называет каталог; сигнал убитой команды попадает в сообщение', () => {
  assert.throws(() => runCommand(process.execPath, node('process.exit(2)')), (e: Error) => e.message.includes('код выхода 2') && !e.message.includes('cwd'));
  assert.throws(() => runCommand(process.execPath, node('process.kill(process.pid,"SIGTERM");setInterval(()=>{},1000)')), (e: Error) => /SIGTERM/.test(e.message));
});
