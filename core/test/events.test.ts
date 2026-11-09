import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PluginContext } from '@cyborg-harness/contracts';
import { load, type LoadOptions } from '../src/loader.ts';
import { parseManifest } from '../src/manifest.ts';
import type { PluginModule } from '../src/plugin.ts';
import { pluginStatuses } from '../src/status.ts';
import type { NoticeEvents } from '../src/notices.ts';
import { inlineHosts, type HostHandle } from '../src/transports.ts';
import { PLUGIN_API_VERSION } from '../src/api-version.ts';

const manifest = (id: string, fields: Record<string, unknown> = {}) => ({ id, version: '1.0.0', engines: { cyborg: '^1' }, ...fields });
const settle = () => sleep(20);

async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (cond()) return;
    await sleep(20);
  }
  assert.fail(`${what}: не дождались за ${String(ms)} мс`);
}

function start(table: Record<string, PluginModule>, options: Omit<LoadOptions, 'apiVersion' | 'spawnHost' | 'enabled'> & { enabled?: string[] }) {
  const logs: string[] = [];
  return load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: options.enabled ?? Object.keys(table),
    spawnHost: inlineHosts(async (entry) => {
      const mod = table[entry];
      if (!mod) throw new Error(`нет модуля ${entry}`);
      return mod;
    }),
    onLog: (id, m) => logs.push(`${id}: ${m}`),
    ...options,
  }).then((k) => Object.assign(k, { logs }));
}

test('события окна и ОС: доходят до плагинов всех хостов, упавший слушатель не мешает соседу, снятый плагин их не получает', async () => {
  const seen: string[] = [];
  const listen = (id: string, fail = false): PluginModule => ({
    activate(ctx) {
      ctx.window.onFocusChange((f) => seen.push(`${id}:focus:${String(f)}`));
      ctx.system.onSuspend(() => {
        if (fail) throw new Error('сломан');
        seen.push(`${id}:suspend`);
      });
      ctx.system.onResume(() => seen.push(`${id}:resume`));
      ctx.system.onScreenLock(() => seen.push(`${id}:lock`));
      return undefined;
    },
  });
  const k = await start({ a: listen('a', true), b: listen('b') }, { manifests: [manifest('a'), manifest('b')] });
  assert.notEqual(k.hostOf('a'), k.hostOf('b'));
  k.emit({ kind: 'focus', focused: false });
  k.emit({ kind: 'suspend' });
  k.emit({ kind: 'resume' });
  k.emit({ kind: 'screen-lock' });
  // На занятом раннере CI 20 мс не хватало журналу упавшего слушателя: ждём факта, а не срока.
  await until(() => seen.length >= 7 && k.logs.some((l) => l.startsWith('a: слушатель suspend упал')), 2000, 'события и запись об упавшем слушателе');
  assert.deepEqual(seen.sort(), ['a:focus:false', 'a:lock', 'a:resume', 'b:focus:false', 'b:lock', 'b:resume', 'b:suspend']);
  assert.ok(k.logs.some((l) => l.startsWith('a: слушатель suspend упал: сломан')), k.logs.join('\n'));
  assert.throws(() => k.emit({ kind: 'reboot' } as never), { code: 'Invalid' });

  await k.disable('a');
  seen.length = 0;
  k.emit({ kind: 'focus', focused: true });
  await until(() => seen.includes('b:focus:true'), 2000, 'фокус у оставшегося плагина');
  await settle();
  assert.deepEqual(seen, ['b:focus:true']);
  await k.unload();
});

test('onIdle: один раз на простой, снова - после активности; отписка останавливает опрос ОС', async () => {
  let idle = 0;
  let asked = 0;
  const fired: number[] = [];
  let ctx: PluginContext | undefined;
  const k = await start(
    {
      lock: {
        activate(c) {
          ctx = c;
          return undefined;
        },
      },
    },
    { manifests: [manifest('lock')], idlePoll: 5, idleSeconds: () => (asked++, idle) },
  );
  await settle();
  assert.equal(asked, 0, 'ядро спрашивает ОС о простое без подписчиков');
  const sub = ctx!.system.onIdle(60, () => fired.push(idle));
  // Значение простоя держится, пока ядро не спросит ОС дважды: медленный раннер за 20 мс может не успеть ни разу.
  const polled = async () => {
    for (const from = asked; asked < from + 2; ) await sleep(5);
  };
  assert.throws(() => ctx!.system.onIdle(0, () => undefined), { code: 'Invalid' });
  idle = 30;
  await polled();
  idle = 61;
  await polled();
  idle = 90;
  await polled();
  assert.deepEqual(fired, [61], 'второй раз за тот же простой');
  idle = 0;
  await polled();
  idle = 70;
  await polled();
  assert.deepEqual(fired, [61, 70]);
  sub.dispose();
  await settle();
  const after = asked;
  await settle();
  assert.equal(asked, after, 'опрос идёт без подписчиков');
  await k.unload();
});

test('beforeQuit: ждёт асинхронных слушателей всех хостов, зависший обрезается бюджетом', async () => {
  const done: string[] = [];
  const k = await start(
    {
      saver: {
        activate(ctx) {
          ctx.system.onBeforeQuit(async () => {
            await sleep(30);
            done.push('saver');
          });
          return undefined;
        },
      },
      stuck: {
        activate(ctx) {
          ctx.system.onBeforeQuit(() => new Promise(() => undefined));
          return undefined;
        },
      },
    },
    { manifests: [manifest('saver'), manifest('stuck')] },
  );
  const t = performance.now();
  await k.beforeQuit(200);
  const ms = performance.now() - t;
  assert.deepEqual(done, ['saver']);
  assert.ok(ms >= 150 && ms < 1000, `бюджет не соблюдён: ${String(ms)} мс`);
  await k.unload();
});

test('activation lazy: ждёт; будит команда, сочетание, wake и потребитель контракта; встречные consumes не виснут', async () => {
  const activated: string[] = [];
  const mod = (id: string, body?: (ctx: PluginContext) => void): PluginModule => ({
    activate(ctx) {
      activated.push(id);
      body?.(ctx);
      return undefined;
    },
  });
  const k = await start(
    {
      pad: mod('pad', (ctx) => void ctx.commands.register('pad.open', () => 'открыт')),
      files: mod('files', (ctx) => void ctx.contracts.provide('test.files', '1.0', { read: (p: string) => p })),
      editor: mod('editor'),
      view: mod('view'),
      ping: mod('ping', (ctx) => void ctx.contracts.provide('test.tab', '1.0', { kind: 'ping' })),
      pong: mod('pong', (ctx) => void ctx.contracts.provide('test.flaky', '1.0', {})),
      off: mod('off', (ctx) => void ctx.commands.register('off.go', () => 1)),
    },
    {
      manifests: [
        manifest('pad', { activation: 'lazy', commands: ['pad.open'], keybindings: [{ key: 'F2', command: 'pad.open' }] }),
        manifest('files', { activation: 'lazy', provides: { 'test.files': ['1.0'] } }),
        manifest('editor', { requires: { 'test.files': '^1' } }),
        manifest('view', { activation: 'lazy' }),
        manifest('ping', { activation: 'lazy', provides: { 'test.tab': ['1.0'] }, consumes: { 'test.flaky': '^1' } }),
        manifest('pong', { activation: 'lazy', provides: { 'test.flaky': ['1.0'] }, consumes: { 'test.tab': '^1' } }),
        manifest('off', { activation: 'lazy', commands: ['off.go'] }),
      ],
    },
  );
  assert.deepEqual(activated, ['files', 'editor'], 'ленивый поднят при старте или поставщик не поднят ради requires');
  assert.deepEqual(
    pluginStatuses(k.journal).filter((s) => s.state === 'waiting').map((s) => s.id).sort(),
    ['off', 'pad', 'ping', 'pong', 'view'],
  );

  assert.equal(k.keybinding('F2')?.command, 'pad.open', 'сочетание спящего ушло бы в окно');
  assert.equal(await k.run('pad.open'), 'открыт');
  assert.ok(k.active.includes('pad'));

  await k.wake('view');
  await k.wake('view');
  assert.equal(activated.filter((id) => id === 'view').length, 1);

  await k.wake('ping');
  await k.idle();
  assert.ok(k.active.includes('ping') && k.active.includes('pong'), 'встречные consumes');

  await k.disable('off');
  await assert.rejects(k.run('off.go'), { code: 'CommandNotFound' });
  assert.equal(k.keybinding('F2')?.pluginId, 'pad');
  assert.ok(!activated.includes('off'), 'выключенный человеком ленивый поднят командой');

  const bad = parseManifest(manifest('x', { activation: 'eager' }));
  assert.ok(!bad.ok && bad.errors.some((e) => e.startsWith('activation:')));
  await k.unload();
});

test('activation lazy: enable ждущего поднимает его один раз, wake после enable не активирует повторно', async () => {
  let activated = 0;
  const k = await start(
    {
      late: {
        activate(ctx) {
          activated++;
          ctx.commands.register('late.go', () => 'ok');
          return undefined;
        },
      },
    },
    { manifests: [manifest('late', { activation: 'lazy', commands: ['late.go'] })] },
  );
  assert.equal(activated, 0);
  await k.enable('late');
  assert.equal(activated, 1);
  await k.wake('late');
  assert.equal(await k.run('late.go'), 'ok');
  await k.idle();
  assert.equal(activated, 1, 'enable оставил плагин ждущим: wake поднял его второй раз');
  assert.equal(k.active.filter((id) => id === 'late').length, 1);
  await k.unload();
});

test('предел слушателей onIdle: сверх предела ядро отказывает с причиной в журнале, снятый слушатель освобождает место', async () => {
  let idle = 0;
  let ctx: PluginContext | undefined;
  const k = await start({ lock: { activate: (c) => void (ctx = c) } }, { manifests: [manifest('lock')], idlePoll: 5, idleSeconds: () => idle, limits: { idleWatchers: 2 } });
  const fired: string[] = [];
  const first = ctx!.system.onIdle(10, () => fired.push('a'));
  ctx!.system.onIdle(10, () => fired.push('b'));
  ctx!.system.onIdle(10, () => fired.push('c'));
  await settle();
  assert.ok(k.logs.some((l) => l.includes('слушателей onIdle больше 2')), k.logs.join('\n'));
  idle = 20;
  await settle();
  assert.deepEqual(fired.toSorted(), ['a', 'b']);
  first.dispose();
  ctx!.system.onIdle(10, () => fired.push('d'));
  idle = 0;
  await settle();
  idle = 20;
  await settle();
  assert.deepEqual(fired.toSorted(), ['a', 'b', 'b', 'd']);
  await k.unload();
});

test('клик по уведомлению, пока хост перезапускается, доходит до команды вернувшегося плагина; падение хоста уведомление не закрывает', async () => {
  const clicks: NoticeEvents[] = [];
  const ran: unknown[] = [];
  let closed = 0;
  const handles = new Map<string, HostHandle>();
  let ctx: PluginContext | undefined;
  const base = inlineHosts(async () => ({
    activate(c: PluginContext) {
      ctx = c;
      c.commands.register('bell.open', (session) => void ran.push(session));
      return undefined;
    },
  }));
  const dir = mkdtempSync(path.join(tmpdir(), 'cyborg-notify-'));
  const k = await load({
    apiVersion: PLUGIN_API_VERSION,
    enabled: ['bell'],
    manifests: [manifest('bell', { commands: { 'bell.open': { args: ['string'] } }, permissions: { notify: true } })],
    spawnHost: (id) => {
      const h = base(id);
      handles.set(id, h);
      return h;
    },
    os: {
      dataDir: dir,
      tempDir: dir,
      notify: (_title, _body, events) => {
        clicks.push(events);
        return {
          close: () => {
            closed++;
          },
        };
      },
    },
    watchdog: { interval: 20, timeout: 1000, strikes: 3 },
  });
  await ctx!.os.notify!.show('Сессия ждёт', undefined, { onClick: { command: 'bell.open', args: ['s1'] } });
  const before = ctx;
  handles.get(k.hostOf('bell')!)!.kill();
  assert.equal(closed, 0, 'падение хоста уведомление не закрывает');
  clicks[0]!.click();
  for (let i = 0; i < 200 && ran.length === 0; i++) await sleep(5);
  assert.notEqual(ctx, before, 'плагин поднят заново');
  assert.deepEqual(ran, ['s1']);
  assert.equal(closed, 1);
  await k.unload();
});
