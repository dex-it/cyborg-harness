// Шаг smoke «сессия под нагрузкой» (PL-01, #17): идущая сессия агента в окне переживает предел ввода, размеры 0..1001, быструю смену размера,
// перезагрузку окна и перезапуск хоста sessions. Идёт с живым claude (`CYBORG_SMOKE_CLAUDE=1`) и с подставным (`CYBORG_SMOKE_LOAD=1`); в CI его нет.
// Живой claude на этом шаге стоит на вопросе о доверии каталогу или на своём экране: проверяется, что экран и процесс целы, а не поведение агента.
const MIB = 1024 * 1024;

/**
 * @param {object} t
 * @param {RegExp} t.expect что должно быть видно на экране сессии (экран claude или приветствие подставного)
 */
export async function sessionUnderLoad({ assert, ev, main, inView, waitFor, log, screen, expect }) {
  const bridge = (expression) => inView('sessions', expression);
  const alive = async (pid) => main(`(() => { try { process.kill(${pid}, 0); return true; } catch { return false; } })()`);
  const pidOf = async () => Number(/pid (\d+)/.exec(await inView('sessions', "document.getElementById('session-state').textContent"))?.[1] ?? 0);
  const pid = await waitFor('pid процесса сессии в строке состояния', pidOf);

  // Второй вид на тот же pty - тем же путём, каким окно берёт идущую сессию после перезагрузки (sessions.running, sessions.reopen, терминал по билету).
  const opened = await bridge(`(async () => {
    const b = window.cyborgView;
    const running = (await b.run('sessions.running', [])).value;
    const ticket = running.length > 0 ? (await b.run('sessions.reopen', [running[0].id])).value : undefined;
    const term = ticket ? (await b.terminalOpen(ticket)).value : undefined;
    return { running: running.length, tid: term?.tid, backlog: term?.backlog ?? '' };
  })()`);
  assert.equal(opened.running, 1, 'sessions.running не назвал идущую сессию');
  assert.ok(opened.tid !== undefined, 'терминал по билету sessions.reopen не открылся');
  assert.match(opened.backlog, expect, 'хвост при повторном подключении не содержит экрана сессии');

  // Предел ввода: 1 МиБ + 1 отклонён до порта, меньший проходит; процесс жив.
  const write = (size) => bridge(`window.cyborgView.terminalWrite(${opened.tid}, 'x'.repeat(${size}))`);
  assert.match((await write(MIB + 1))?.error ?? '', /больше 1048576/, 'ввод 1 МиБ + 1 принят');
  assert.equal((await write(256 * 1024))?.error, undefined, 'вставка 256 КиБ отклонена');
  // Размеры: вне 1..1000 отказ, на краях принято, быстрая серия не роняет сессию.
  const resize = (cols, rows) => bridge(`window.cyborgView.terminalResize(${opened.tid}, ${cols}, ${rows})`);
  for (const [cols, rows] of [[0, 24], [1001, 24], [80, 0], [80, 1001]]) assert.match((await resize(cols, rows))?.error ?? '', /1\.\.1000/, `размер ${cols}x${rows} принят`);
  assert.equal((await resize(1000, 1000))?.error, undefined);
  const burst = await bridge(`Promise.all(Array.from({ length: 200 }, (_, i) => window.cyborgView.terminalResize(${opened.tid}, [1, 1000, 80, 300][i % 4], [1, 1000, 24, 5][i % 4]))).then((r) => r.filter((x) => x?.error).length)`);
  assert.equal(burst, 0, 'быстрая серия размеров дала отказы');
  assert.equal((await resize(120, 32))?.error, undefined);
  await bridge(`window.cyborgView.terminalClose(${opened.tid})`);
  assert.ok(await alive(pid), 'процесс сессии не пережил предел ввода и смену размеров');
  log('сессия под нагрузкой: ввод 1 МиБ + 1 отклонён, 256 КиБ принят; размеры 0 и 1001 отклонены, серия из 200 смен принята; процесс жив');

  // Перезагрузка окна: идущая сессия видна в списке «идёт», открывается заново и показывает экран из хвоста.
  await ev.send('Page.reload');
  await waitFor('вид sessions после перезагрузки окна', async () => (await inView('sessions', "document.querySelector('#agents cy-button')?.disabled")) !== null);
  const row = await waitFor('строка «идёт» в списке сессий', () => inView('sessions', "(() => { const l = document.getElementById('previous'); return l && !l.hidden ? (l.items ?? []).map((r) => r.detail).join(',') : ''; })()"), 15_000);
  assert.match(row, /идёт/, 'идущая сессия не видна после перезагрузки окна');
  await inView('sessions', "(() => { const l = document.getElementById('previous'); l.dispatchEvent(new CustomEvent('cy-activate', { detail: { id: l.items[0].id } })); })()");
  await waitFor('экран сессии после перезагрузки окна', async () => expect.test(await screen()), 20_000);
  log('сессия под нагрузкой: перезагрузка окна - сессия в списке «идёт», по клику экран восстановлен из хвоста');

  // Перезапуск хоста sessions: процесс сессии жив, плагин подхватывает его при активации (иначе ядро завершит его через 60 с).
  const hostPid = () => ev("/pid (\\d+)/.exec(document.querySelector('#plugins-list [data-plugin=\"sessions\"] .plugin-host')?.textContent ?? '')?.[1] ?? ''");
  const before = await hostPid();
  assert.ok(before, 'нет pid хоста sessions');
  await main(`process.kill(${before}, 'SIGKILL')`);
  await waitFor('хост sessions перезапущен', async () => {
    const now = await hostPid();
    return now !== '' && now !== before && (await ev("document.querySelector('#plugins-list [data-plugin=\"sessions\"]').dataset.state")) === 'active';
  }, 30_000);
  assert.ok(await alive(pid), 'процесс сессии погиб вместе с хостом sessions');
  const adopted = await bridge("window.cyborgView.run('sessions.running', []).then((r) => r.value.length)");
  assert.equal(adopted, 1, 'вернувшийся sessions не подхватил оставленную сессию (attach при активации)');
  log('сессия под нагрузкой: хост sessions убит - процесс жив, вернувшийся плагин подхватил сессию');

  // Notification: какие типы хуков приходили за сессию (для вывода по agent_needs_input, #92). Файл события живёт, пока жива сессия.
  const types = await main(`(() => {
    const fs = process.mainModule.require('fs');
    const path = process.mainModule.require('path');
    const { app } = process.mainModule.require('electron');
    const dir = path.join(app.getPath('userData'), 'plugin-data', 'agent-claude-code', 'sessions');
    const seen = {};
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (!f.endsWith('.jsonl')) continue;
      for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\\n')) {
        try {
          const e = JSON.parse(line);
          const key = e.hook_event_name === 'Notification' ? 'Notification:' + e.notification_type : e.hook_event_name;
          seen[key] = (seen[key] ?? 0) + 1;
        } catch {}
      }
    }
    return seen;
  })()`);
  log(`хуки сессии за шаг: ${JSON.stringify(types)}`);
}
