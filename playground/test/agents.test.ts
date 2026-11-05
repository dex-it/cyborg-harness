import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentEvent, PluginContext } from '@cyborg/contracts';
import { load } from '../../core/src/loader.ts';
import { inlineHosts } from '../../core/src/transports.ts';
import { fakePty } from '../../core/test/fake-pty.ts';
import { claudeArgs, LAUNCH_SCRIPT } from '../plugins/agent-claude-code/index.ts';

const PLUGINS = path.join(import.meta.dirname, '..', 'plugins');
const PROVIDERS = ['agent-claude-code', 'agent-shell'];
const manifestOf = (id: string): unknown => JSON.parse(readFileSync(path.join(PLUGINS, id, 'manifest.json'), 'utf8'));

async function waitFor<T>(what: string, probe: () => T | undefined | false | Promise<T | undefined | false>): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const v = await probe();
    if (v !== undefined && v !== false) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`не дождались: ${what}`);
}

/** Настоящие модули плагинов в ядре; probe - потребитель, через которого тест зовёт контракт; claude - скрипт в PATH. */
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'cyborg-agents-'));
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'claude'), '#!/bin/sh\necho "2.1.7 (Claude Code)"\n');
  // Оболочка входа без профиля: /etc/profile переписал бы PATH, и тест не нашёл бы свой claude.
  const shell = path.join(bin, 'login-shell');
  await writeFile(shell, '#!/bin/sh\nshift\nexec /bin/sh -c "$@"\n');
  await chmod(path.join(bin, 'claude'), 0o755);
  await chmod(shell, 0o755);
  const backend = fakePty();
  let probe: PluginContext | undefined;
  const k = await load({
    apiVersion: '1.0.0',
    enabled: [...PROVIDERS, 'sessions', 'probe'],
    manifests: [...PROVIDERS, 'sessions'].map(manifestOf).concat({ id: 'probe', version: '1.0.0', engines: { cyborg: '^1' }, consumes: { 'cyborg.agent': '^1' } }),
    entry: (m) => (m.id === 'probe' ? 'probe' : path.join(PLUGINS, m.id, 'index.ts')),
    spawnHost: inlineHosts(async (entry) => (entry === 'probe' ? { activate: (ctx: PluginContext) => void (probe = ctx) } : ((await import(entry)) as { default: never }).default)),
    os: { dataDir: path.join(root, 'data'), tempDir: path.join(root, 'temp'), env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, SHELL: shell }, pty: backend },
  });
  assert.deepEqual(k.active.toSorted(), [...PROVIDERS, 'probe', 'sessions'].toSorted(), JSON.stringify(k.journal.filter((e) => e.kind === 'failed')));
  assert.ok(probe);
  const ctx = probe;
  const agent = (id: string) => {
    const p = ctx.contracts.all('cyborg.agent', 1).find((x) => x.pluginId === id);
    assert.ok(p, `${id} не отдаёт cyborg.agent`);
    return p.impl;
  };
  return { k, backend, agent, root, shell, data: (id: string) => path.join(root, 'data', id), [Symbol.asyncDispose]: async () => {
      await k.unload();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('cyborg.agent, общий набор: факты, запуск через потребителя по его праву pty, причина выхода, история', async () => {
  await using s = await setup();
  for (const id of PROVIDERS) {
    const agent = s.agent(id);
    const facts = await agent.facts();
    assert.deepEqual(structuredClone(facts), facts, `${id}: факты не данные`);
    assert.equal(typeof facts.id, 'string');
    assert.equal(facts.found, true, `${id}: программа не найдена`);
    for (const flag of ['resume', 'history', 'events'] as const) assert.equal(typeof facts.capabilities[flag], 'boolean', `${id}: capabilities.${flag}`);
    const spec = await agent.launch({ sessionId: 'probe-1', cwd: s.root });
    assert.deepEqual(structuredClone(spec), spec, `${id}: запуск не данные`);
    assert.equal(spec.cwd, s.root);

    const before = s.backend.procs.length;
    assert.equal(typeof (await s.k.run('sessions.new', id)), 'string', `${id}: sessions.new не вернул билет`);
    const proc = s.backend.procs[before];
    assert.ok(proc, `${id}: потребитель не запустил pty`);
    assert.equal(proc.options.cwd, s.data('sessions'));
    assert.equal((await agent.ended('probe-1', { code: 127 }))?.kind, 'notFound', `${id}: 127 - не найдена программа`);
    assert.equal(await agent.ended('probe-1', { code: 0 }), null);
    assert.ok(Array.isArray(await agent.history(s.root)));
    if (!facts.capabilities.history) assert.deepEqual(await agent.history(s.root), []);
  }
  const shell = s.backend.procs.find((p) => p.file === '/bin/sh');
  assert.deepEqual(shell?.args, []);
});

test('agent-claude-code: запуск как в Cyborg - оболочка входа, --settings с хуками, порядок аргументов', async () => {
  await using s = await setup();
  const agent = s.agent('agent-claude-code');
  assert.deepEqual(await agent.facts(), { id: 'claude-code', title: 'Claude Code', found: true, version: '2.1.7', capabilities: { resume: true, history: false, events: true } });
  const spec = await agent.launch({ sessionId: 'a1', cwd: '/w', resumeId: 'r-1', promptFragments: ['изоляция', 'кнопки'], prompt: 'привет', extraDirs: ['/x', '/y'] });
  const data = s.data('agent-claude-code');
  assert.deepEqual(spec, {
    program: '$SHELL',
    args: ['-lc', LAUNCH_SCRIPT, 'cyborg', '--resume', 'r-1', '--append-system-prompt', 'изоляция\n\nкнопки', 'привет', '--add-dir', '/x', '/y'],
    cwd: '/w',
    env: { CYBORG_EVENTS: path.join(data, 'sessions', 'a1.jsonl'), CYBORG_SETTINGS: path.join(data, 'claude-hooks.json') },
  });
  assert.deepEqual(claudeArgs({ sessionId: 'b', cwd: '/w' }), [], 'без фрагментов --append-system-prompt не нужен');
  const settings = JSON.parse(await readFile(spec.env.CYBORG_SETTINGS, 'utf8')) as { hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]> };
  assert.deepEqual(Object.keys(settings.hooks), ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'Notification']);
  assert.equal(settings.hooks.PostToolUse?.[0]?.matcher, '*');
  assert.equal(settings.hooks.Stop?.[0]?.hooks[0]?.command, '{ cat; echo; } >> "$CYBORG_EVENTS"');
  await assert.rejects(agent.launch({ sessionId: '../x', cwd: '/w' }), /id сессии/);

  await s.k.run('sessions.new', 'agent-claude-code');
  const proc = s.backend.procs.at(-1)!;
  assert.deepEqual([proc.file, proc.args], [s.shell, ['-lc', LAUNCH_SCRIPT, 'cyborg']], '$SHELL не заменён оболочкой входа');
  assert.deepEqual(Object.keys(proc.options.env).filter((k) => k.startsWith('CYBORG_')).toSorted(), ['CYBORG_EVENTS', 'CYBORG_SETTINGS']);
  const events = proc.options.env.CYBORG_EVENTS!;
  proc.exit(0);
  await waitFor('ended убрал файл событий', () => stat(events).then(() => false, () => true));
});

test('agent-claude-code: хуки в события контракта; прошлое и недописанная строка не читаются', async () => {
  await using s = await setup();
  const agent = s.agent('agent-claude-code');
  const spec = await agent.launch({ sessionId: 'w1', cwd: '/w' });
  const file = spec.env.CYBORG_EVENTS!;
  const line = (o: object) => `${JSON.stringify(o)}\n`;
  await appendFile(file, line({ hook_event_name: 'SessionStart', cwd: '/old' }));
  const seen: AgentEvent[] = [];
  const sub = await agent.watch('w1', (e) => seen.push(e));
  await new Promise((r) => setTimeout(r, 300));
  await appendFile(
    file,
    [
      line({ hook_event_name: 'PostToolUse', cwd: '/w', tool_name: 'Bash' }),
      line({ hook_event_name: 'UserPromptSubmit', cwd: '/w' }),
      line({ hook_event_name: 'Stop', cwd: '/w/sub', last_assistant_message: 'готово', background_tasks: [] }),
      line({ hook_event_name: 'Stop', cwd: '/w/sub', session_crons: [{}] }),
      line({ hook_event_name: 'Notification', cwd: '/w/sub', notification_type: 'permission_prompt', message: 'секрет' }),
      line({ hook_event_name: 'Notification', cwd: '/w/sub', notification_type: 'idle_prompt' }),
      'не json\n',
      '{"hook_event_name":"Stop"',
    ].join(''),
  );
  await waitFor('события хуков', () => seen.length >= 8);
  assert.deepEqual(seen, [
    { type: 'cwd', cwd: '/w' },
    { type: 'activity', tool: 'Bash' },
    { type: 'prompt' },
    { type: 'cwd', cwd: '/w/sub' },
    { type: 'turnEnd', background: false, text: 'готово' },
    { type: 'turnEnd', background: true },
    { type: 'waiting', reason: 'Просит разрешение' },
    { type: 'activity' },
  ]);
  await appendFile(file, '}\n');
  await waitFor('дописанная строка', () => seen.length === 9);
  assert.deepEqual(seen.at(-1), { type: 'turnEnd', background: false });
  sub.dispose();
});
