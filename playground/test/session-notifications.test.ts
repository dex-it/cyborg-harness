import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitFor } from '../../core/test/wait-for.ts';
import { chainRig, forkedRig, type Heard, type Rig } from './chain-rig.ts';

// PL-02 (#18): хук claude -> agent-claude-code (fs.watch, readSlice) -> sessions (cyborg.sessions) -> session-notifications -> уведомление ядра.
// Хук - настоящая команда из --settings плагина; уведомление - подставная среда ядра; claude в PATH - заглушка.

const waiting = (reason: string) => ({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: reason });
const types = (heard: readonly Heard[]) => heard.map((h) => h.event.change.type);
/** Дождаться, пока вся цепочка событий дошла до независимого подписчика: после него сообщения уже ушли и в session-notifications (порядок доставки один). */
const heardCount = (s: Rig, n: number) => waitFor(`probe услышал ${String(n)} событий`, () => s.heard.length >= n);

test('sessions отдаёт cyborg.sessions: хуки claude становятся событиями cwd, activity, waiting и exit подписчика в другом плагине', async () => {
  await using s = await chainRig({ notifier: false });
  const session = await s.newSession();
  const base = s.heard.length;
  await s.hook(session, { hook_event_name: 'UserPromptSubmit', cwd: '/w' });
  await s.hook(session, { hook_event_name: 'PostToolUse', cwd: '/w', tool_name: 'Bash' });
  await s.hook(session, { hook_event_name: 'SessionStart', session_id: 'c-1' });
  await s.hook(session, { hook_event_name: 'Stop', cwd: '/w/sub', last_assistant_message: 'готово' });
  await s.hook(session, waiting('x'));
  await heardCount(s, base + 5);
  const title = s.heard[0]!.event.title;
  assert.match(title, /^Claude Code s/);
  assert.deepEqual(
    s.heard.slice(base).map((h) => h.event),
    [
      { sessionId: session.sessionId, title, change: { type: 'cwd', cwd: '/w' } },
      { sessionId: session.sessionId, title, change: { type: 'activity' } },
      { sessionId: session.sessionId, title, change: { type: 'activity', tool: 'Bash' } },
      { sessionId: session.sessionId, title, change: { type: 'cwd', cwd: '/w/sub' } },
      { sessionId: session.sessionId, title, change: { type: 'waiting', reason: 'Просит разрешение' } },
    ],
    'session и turnEnd контрактом пока не отдаются, смена каталога идёт перед событием, которое её принесло',
  );
  s.k.pty.procs.at(-1)!.exit(3);
  await heardCount(s, base + 6);
  assert.deepEqual(s.heard.at(-1)!.event.change, { type: 'exit', code: 3 });
});

test('«ждёт» от хука доходит до session-notifications и показывается один раз на событие, пока окно без фокуса', async () => {
  await using s = await chainRig();
  const session = await s.newSession();
  s.k.emit({ kind: 'focus', focused: false });
  const base = s.heard.length;
  await s.hook(session, waiting('x'));
  await waitFor('уведомление показано', () => s.notices.shown.length === 1);
  const [first] = s.notices.shown;
  assert.match(first!.title, /^Claude Code s/);
  assert.equal(first!.body, 'Просит разрешение', 'текст зависит только от рода ожидания, а не от текста сообщения хука');
  assert.deepEqual(types(s.heard.slice(base)), ['waiting']);
  await s.hook(session, { hook_event_name: 'Notification', notification_type: 'agent_needs_input' });
  await waitFor('второе событие - второе уведомление', () => s.notices.shown.length === 2);
  assert.deepEqual(s.notices.shown.map((n) => [n.body, n.closed]), [['Просит разрешение', true], ['Ждёт ответа', false]], 'у сессии живо одно уведомление: прежнее заменено');
});

test('окно в фокусе уведомления не получает; фокус, вернувшийся до события, тоже (гонка)', async () => {
  await using s = await chainRig();
  const session = await s.newSession();
  const skipped = (n: number) => waitFor(`пропущено событий: ${String(n)}`, () => s.logs.filter(([id, line]) => id === 'session-notifications' && line.includes('окно в фокусе')).length >= n);
  // По умолчанию окно в фокусе: onFocusChange сообщает только перемены, и до первой перемены плагин считает окно активным.
  await s.hook(session, waiting('в фокусе'));
  await skipped(1);
  // Фокус ушёл и вернулся, и только потом пришло событие: в среде приложения перемена доходит до плагина раньше, чем событие хука пройдёт файл и два хоста.
  s.k.emit({ kind: 'focus', focused: false });
  s.k.emit({ kind: 'focus', focused: true });
  await s.hook(session, waiting('фокус только что вернулся'));
  await skipped(2);
  s.k.emit({ kind: 'focus', focused: false });
  await s.hook(session, { hook_event_name: 'Notification', notification_type: 'elicitation_dialog' });
  await waitFor('уведомление про вопрос', () => s.notices.shown.length === 1);
  assert.deepEqual(s.notices.shown.map((n) => n.body), ['Задаёт вопрос']);
});

test('сессия снова занята или вышла - уведомление снимается из плагина (unnotify), чужие сессии не затронуты', async () => {
  await using s = await chainRig();
  const a = await s.newSession();
  const b = await s.newSession();
  s.k.emit({ kind: 'focus', focused: false });
  await s.hook(a, waiting('a'));
  await s.hook(b, waiting('b'));
  await waitFor('два уведомления', () => s.notices.shown.length === 2);
  // Два наблюдателя файлов независимы: порядок показа не гарантирован, уведомление сессии находим по заголовку.
  const of = (session: { sessionId: string }) => s.notices.shown.find((n) => n.title.endsWith(session.sessionId))!;
  await s.hook(a, { hook_event_name: 'UserPromptSubmit' });
  await waitFor('новый запрос человека снял уведомление сессии a', () => of(a).closed);
  assert.equal(of(b).closed, false);
  s.k.pty.procs.at(-1)!.exit(0);
  await waitFor('выход сессии b снял её уведомление', () => of(b).closed);
});

test('клик по уведомлению поднимает окно и запускает команду плагина с id сессии', async () => {
  await using s = await chainRig();
  const session = await s.newSession();
  s.k.emit({ kind: 'focus', focused: false });
  await s.hook(session, waiting('клик'));
  await waitFor('уведомление показано', () => s.notices.shown.length === 1);
  s.notices.shown[0]!.events.click();
  await waitFor('команда клика выполнена', () => s.logs.some(([id, line]) => id === 'session-notifications' && line.includes(session.sessionId) && line.includes('открыта')));
  assert.equal(s.notices.raised(), 1, 'клик просит приложение поднять и сфокусировать окно');
  assert.equal(s.notices.shown[0]!.closed, true, 'клик закрывает уведомление');
});

test('без права notify у плагина нет ctx.os.notify: он говорит об этом в журнале и ничего не показывает, цепочка событий работает', async () => {
  await using s = await chainRig({ notifier: (manifest) => Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== 'permissions')) });
  assert.ok(s.logs.some(([id, line]) => id === 'session-notifications' && line.includes('нет права notify')), 'плагин сообщил, что показывать нечем');
  const session = await s.newSession();
  s.k.emit({ kind: 'focus', focused: false });
  const base = s.heard.length;
  await s.hook(session, waiting('нет права'));
  await heardCount(s, base + 1);
  await waitFor('плагин разобрал событие', () => s.logs.some(([id, line]) => id === 'session-notifications' && line.includes('показывать нечем')));
  assert.equal(s.notices.shown.length, 0, 'до среды уведомление не дошло');
  assert.deepEqual(types(s.heard.slice(base)), ['waiting'], 'событие цепочки дошло, нет только уведомления');
});

test('те же плагины в разных процессах ОС (forkHosts): событие «ждёт» проходит границу хостов и приводит к уведомлению, клик возвращается командой', async () => {
  await using s = await forkedRig();
  s.k.emit({ kind: 'focus', focused: false });
  await s.hook(waiting('x'));
  await waitFor('уведомление показано', () => s.notices.shown.length === 1);
  assert.equal(s.notices.shown[0]!.body, 'Просит разрешение');
  s.notices.shown[0]!.events.click();
  await waitFor('команда клика выполнена в процессе плагина', () => s.logs.some(([id, line]) => id === 'session-notifications' && line.includes('открыта сессия')));
  assert.equal(s.notices.raised(), 1);
  assert.deepEqual(s.k.journal.filter((e) => e.kind === 'denied' || e.kind === 'failed' || e.kind === 'host-down'), []);
});
