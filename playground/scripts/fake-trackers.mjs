// Подставные gh, glab и jira: общая фикстура пилота трекеров (PL-07) и проверок, которым нужны «программы трекеров» без входа в аккаунт и сети.
// Запускается обёрткой из playground/test/trackers-kit.ts: `fake-trackers.mjs <gh|glab|jira> <аргументы программы>`, каталог состояния - FAKE_TRACKERS_DIR.
// Ведёт журнал, независимый от плагина: `calls.log` (по строке JSON на запуск, с числом живых программ в момент старта), `children.log` (внуки), каталог `live/` (по файлу на живой pid).
// Поведение берётся из `scenario.json` при каждом запуске: { "default": {...}, "rules": [{ "match": "подстрока аргументов", ... }] }, первое подходящее правило.
// Поведение: mode = ok (ответ после ms), hang, deaf (глух к SIGTERM), big (JSON из bytes байт), badjson, login (отказ входа), exit (code и stderr); child: true - программа запускает внука.
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setInterval } from 'node:timers';
import { setTimeout as sleep } from 'node:timers/promises';

const [tool, ...args] = process.argv.slice(2);
const dir = process.env.FAKE_TRACKERS_DIR;
if (!dir || !['gh', 'glab', 'jira'].includes(tool)) {
  console.error('fake-trackers: нужен FAKE_TRACKERS_DIR и gh, glab или jira первым аргументом');
  process.exit(2);
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const scenario = (() => {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'scenario.json'), 'utf8'));
  } catch {
    return {};
  }
})();
const line = args.join(' ');
const behavior = { mode: 'ok', ...scenario.default, ...scenario.rules?.find((r) => line.includes(r.match)) };

const live = path.join(dir, 'live');
mkdirSync(live, { recursive: true });
const mine = path.join(live, String(process.pid));
writeFileSync(mine, '');
process.on('exit', () => rmSync(mine, { force: true }));
// Без обработчика SIGTERM убивает программу сигналом, как настоящий gh: в ответе `signal: 'SIGTERM'`, а не код выхода. Файл в live/ при этом остаётся, живых считают по kill(pid, 0).
if (behavior.mode === 'deaf') process.on('SIGTERM', () => undefined);

const living = readdirSync(live).filter((n) => alive(Number(n))).length;
appendFileSync(path.join(dir, 'calls.log'), `${JSON.stringify({ pid: process.pid, tool, args, live: living, cwd: process.cwd(), env: { GH_PROMPT_DISABLED: process.env.GH_PROMPT_DISABLED ?? null, NO_COLOR: process.env.NO_COLOR ?? null } })}\n`);

if (behavior.child) {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e3)'], { stdio: 'ignore' });
  appendFileSync(path.join(dir, 'children.log'), `${JSON.stringify({ parent: process.pid, pid: child.pid })}\n`);
}

const items = {
  gh: (n) => Array.from({ length: n }, (_, i) => ({ number: i + 1, title: `PR ${String(i + 1)}`, html_url: `https://github.com/acme/app/pull/${String(i + 1)}`, state: 'open' })),
  glab: (n) => Array.from({ length: n }, (_, i) => ({ iid: i + 1, title: `MR ${String(i + 1)}`, web_url: `https://gitlab.example/acme/app/-/merge_requests/${String(i + 1)}`, state: 'opened' })),
  jira: (n) => Array.from({ length: n }, (_, i) => ({ key: `ACME-${String(i + 1)}`, fields: { summary: `Задача ${String(i + 1)}`, status: { name: 'To Do' } } })),
}[tool];

const login = {
  gh: { code: 4, stderr: 'gh: To get started with GitHub CLI, please run:  gh auth login\n' },
  glab: { code: 1, stderr: 'glab: 401 Unauthorized\n' },
  jira: { code: 1, stderr: 'jira: authentication failed: please log in\n' },
}[tool];

switch (behavior.mode) {
  case 'ok':
    await sleep(behavior.ms ?? 0);
    process.stdout.write(JSON.stringify(items(behavior.count ?? 3)));
    break;
  case 'hang':
  case 'deaf':
    setInterval(() => undefined, 1000);
    await new Promise(() => undefined);
    break;
  case 'big': {
    // Правильный JSON нужного размера: обрезка посреди строки дала бы то, что плагин обязан отличить от целого ответа.
    const chunk = 'x'.repeat(1024 * 1024);
    const total = behavior.bytes ?? 1024 * 1024;
    process.stdout.write('[{"id":1,"title":"');
    for (let sent = 0; sent < total; sent += chunk.length) {
      const part = chunk.slice(0, Math.min(chunk.length, total - sent));
      if (!process.stdout.write(part)) await new Promise((resolve) => process.stdout.once('drain', resolve));
    }
    process.stdout.write('"}]');
    break;
  }
  case 'badjson':
    process.stdout.write('{"items": [1, 2');
    break;
  case 'login':
    process.stderr.write(login.stderr);
    process.exitCode = login.code;
    break;
  case 'exit':
    process.stderr.write(behavior.stderr ?? '');
    process.exitCode = behavior.code ?? 1;
    break;
  default:
    process.exitCode = 3;
}
