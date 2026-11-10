import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PluginContext, SessionEvent, Subscription } from '@cyborg-harness/contracts';
import type { NoticeEvents, OsEnvironment } from '@cyborg-harness/core';
import { sandbox, startKernel, type InlinePlugin, type Sandbox, type TestKernel } from '@cyborg-harness/testing';
import { waitFor } from '../../core/test/wait-for.ts';

export const PLUGINS = path.join(import.meta.dirname, '..', 'plugins');

/** Среда поставщиков: подставной claude в PATH и оболочка входа без профиля (/etc/profile переписал бы PATH, и тест не нашёл бы свой claude). */
export async function agentEnv(box: Sandbox): Promise<{ home: string; env: Record<string, string> }> {
  const bin = box.path('bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'claude'), '#!/bin/sh\necho "2.1.7 (Claude Code)"\n');
  const shell = path.join(bin, 'login-shell');
  await writeFile(shell, '#!/bin/sh\nshift\nexec /bin/sh -c "$@"\n');
  await chmod(path.join(bin, 'claude'), 0o755);
  await chmod(shell, 0o755);
  return { home: box.root, env: { PATH: `${bin}:/usr/bin:/bin`, HOME: box.root, SHELL: shell } };
}

/** Уведомление, как его видит приложение: то, что показало ядро по просьбе плагина, и состояние на экране. */
export interface Shown {
  readonly title: string;
  readonly body: string | undefined;
  readonly events: NoticeEvents;
  /** Момент показа, мс по `performance.now()` процесса теста. */
  readonly at: number;
  closed: boolean;
}

/** Подставная среда уведомлений: `notify` запоминает показанное, `raiseWindow` считает подъёмы окна. */
export function fakeNotify(): { readonly shown: Shown[]; readonly raised: () => number; readonly os: Pick<OsEnvironment, 'notify' | 'raiseWindow'> } {
  const shown: Shown[] = [];
  let raised = 0;
  return {
    shown,
    raised: () => raised,
    os: {
      notify: (title, body, events) => {
        const n: Shown = { title, body, events, at: performance.now(), closed: false };
        shown.push(n);
        return {
          close: () => {
            n.closed = true;
          },
        };
      },
      raiseWindow: () => {
        raised++;
      },
    },
  };
}

/** Хук Claude Code как его запускает claude: команда из `--settings` плагина, JSON события на stdin, файл событий сессии в окружении. */
export async function runHook(settings: string, eventsFile: string, hook: { readonly hook_event_name: string } & Record<string, unknown>): Promise<void> {
  const cfg = JSON.parse(await readFile(settings, 'utf8')) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
  const command = cfg.hooks[hook.hook_event_name]?.[0]?.hooks[0]?.command;
  assert.ok(command, `в --settings нет хука ${hook.hook_event_name}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], { env: { PATH: '/usr/bin:/bin', CYBORG_EVENTS: eventsFile }, stdio: ['pipe', 'ignore', 'inherit'] });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`хук ${hook.hook_event_name} вышел с ${String(code)}`))));
    child.stdin.end(JSON.stringify(hook));
  });
}

/** Что `probe` услышал от `cyborg.sessions`: событие и момент прихода (мс по `performance.now()`). */
export interface Heard {
  readonly event: SessionEvent;
  readonly at: number;
}

export interface Rig {
  readonly k: TestKernel;
  readonly notices: ReturnType<typeof fakeNotify>;
  /** События `cyborg.sessions` в порядке прихода к независимому подписчику `probe` (третий плагин, чтобы наблюдать цепочку, не вмешиваясь в неё). */
  readonly heard: Heard[];
  /** Строки `ctx.log` всех плагинов: `[pluginId, сообщение]`. */
  readonly logs: (readonly [string, string])[];
  /** Запускает сессию `agent-claude-code`, ждёт, пока `watch` встанет на конец файла событий, и называет сессию. */
  newSession(): Promise<{ readonly sessionId: string; readonly file: string }>;
  /** Хук claude: `Notification` с `permission_prompt` и так далее. */
  hook(session: { readonly file: string }, hook: { readonly hook_event_name: string } & Record<string, unknown>): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface RigOptions {
  /** Манифест `session-notifications` с поправкой (например, без права `notify`); по умолчанию настоящий. */
  readonly notifier?: ((manifest: Record<string, unknown>) => Record<string, unknown>) | false;
}

/** Настоящие `sessions`, `agent-claude-code` и `session-notifications` на хостах-в-процессе; claude - скрипт в PATH, хуки - настоящая команда из `--settings`. */
export async function chainRig(options: RigOptions = {}): Promise<Rig> {
  const box = await sandbox('cyborg-chain-');
  const notices = fakeNotify();
  const heard: Heard[] = [];
  const logs: (readonly [string, string])[] = [];
  const probe: InlinePlugin = {
    manifest: { id: 'probe', version: '1.0.0', engines: { cyborg: '^1' }, optional: { 'cyborg.sessions': '^1' } },
    module: {
      activate(ctx: PluginContext) {
        let subscription: Subscription | undefined;
        const join = async () => {
          subscription?.dispose();
          subscription = await ctx.contracts.get('cyborg.sessions', 1)?.onChange((event) => void heard.push({ event, at: performance.now() }));
        };
        ctx.contracts.onChange('cyborg.sessions', () => void join());
        void join();
      },
    },
  };
  const notifierDir = path.join(PLUGINS, 'session-notifications');
  const notifier: readonly (string | InlinePlugin)[] =
    options.notifier === false
      ? []
      : options.notifier === undefined
        ? [notifierDir]
        : [{
          manifest: options.notifier(JSON.parse(await readFile(path.join(notifierDir, 'manifest.json'), 'utf8')) as Record<string, unknown>),
          module: ((await import(path.join(notifierDir, 'index.ts'))) as { default: InlinePlugin['module'] }).default,
        }];
  const os = await agentEnv(box);
  let k: TestKernel;
  try {
    k = await startKernel({
      plugins: [path.join(PLUGINS, 'agent-claude-code'), path.join(PLUGINS, 'sessions'), ...notifier, probe],
      os: { ...os, ...notices.os },
      load: { onLog: (pluginId, message) => void logs.push([pluginId, message]) },
    });
  } catch (error) {
    await box[Symbol.asyncDispose]();
    throw error;
  }
  const settings = path.join(k.dataDir('agent-claude-code'), 'claude-hooks.json');
  return {
    k,
    notices,
    heard,
    logs,
    async newSession() {
      const before = k.pty.procs.length;
      await k.run('sessions.new', 'agent-claude-code');
      const proc = k.pty.procs[before];
      assert.ok(proc, 'sessions не запустил pty');
      const file = proc.options.env.CYBORG_EVENTS;
      assert.ok(file);
      // Подписка `watch` встаёт на конец файла сама и не сообщает об этом: хук-проба повторяется, пока probe не услышит её (события до подписки теряются по контракту).
      const seen = heard.length;
      await waitFor('watch сессии встал', async () => {
        await runHook(settings, file, { hook_event_name: 'PostToolUse', tool_name: 'ReadyProbe' });
        return heard.length > seen;
      }, { interval: 50 });
      const event = heard[seen]?.event;
      assert.ok(event);
      // Пробы, ушедшие в файл раньше, чем встала подписка, потеряны, а позже - в пути: конечная проба идёт за ними в том же порядке.
      await runHook(settings, file, { hook_event_name: 'PostToolUse', tool_name: 'ReadyDone' });
      await waitFor('пробы дошли', () => heard.some((h, i) => i >= seen && h.event.change.type === 'activity' && h.event.change.tool === 'ReadyDone'));
      return { sessionId: event.sessionId, file };
    },
    hook: (session, hook) => runHook(settings, session.file, hook),
    [Symbol.asyncDispose]: async () => {
      await k[Symbol.asyncDispose]();
    },
  };
}
