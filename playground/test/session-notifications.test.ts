import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitFor } from '../../core/test/wait-for.ts';
import { chainRig, type Heard, type Rig } from './chain-rig.ts';

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
