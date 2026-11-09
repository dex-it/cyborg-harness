// Проверяется компилятором в npm run typecheck: строка под @ts-expect-error обязана не компилироваться.
import type { PluginModule } from '../src/plugin.ts';
import type { Remote } from '@cyborg-harness/contracts';
import type { FilesV1, FilesV2 } from '../examples/contracts.ts';

export const provider: PluginModule = {
  activate(ctx) {
    ctx.contracts.provide('demo.files', '1.4', { read: async () => undefined, list: async () => [] });
    ctx.contracts.provide('demo.files', '2.0', { readText: async () => undefined });
    // @ts-expect-error мажорной версии 3 в карте нет
    ctx.contracts.provide('demo.files', '3.0', { readText: async () => undefined });
    // @ts-expect-error 1.x - это FilesV1, а дан FilesV2
    ctx.contracts.provide('demo.files', '1.5', { readText: async () => undefined });
    // @ts-expect-error контракта нет в карте
    ctx.contracts.provide('cyborg.nothing', '1.0', {});
    // @ts-expect-error демонстрационный контракт не входит в пакет: в карте он только как demo.files
    ctx.contracts.provide('cyborg.files', '1.0', { read: async () => undefined, list: async () => [] });
  },
};

// @ts-expect-error у второй мажорной версии нет read
export type NoRead = Remote<FilesV2>['read'];

export const consumer: PluginModule = {
  activate(ctx) {
    const v1: Remote<FilesV1> | undefined = ctx.contracts.get('demo.files', 1);
    const v2: Remote<FilesV2> | undefined = ctx.contracts.get('demo.files', 2);
    // @ts-expect-error мажор обязателен
    ctx.contracts.get('demo.files');
    // @ts-expect-error в пакете только cyborg.agent, cyborg.agent-tool и cyborg.session-prompt
    ctx.contracts.get('cyborg.tab', 1);
    void v1?.read('/a');
    void v2?.readText('/a');
    const tabs = ctx.contracts.all('demo.tab', 1);
    // @ts-expect-error icon появился в 1.1 и может отсутствовать
    tabs.map((t) => t.impl.icon.length);
    // @ts-expect-error синхронный nowSync через границу хоста становится асинхронным
    const n: number | undefined = ctx.contracts.get('demo.clock', 1)?.nowSync();
    ctx.log(String(n));
    // @ts-expect-error обработчик команды принимает unknown, а не объявленный тип
    ctx.commands.register('x.open', (path: string) => path);
  },
};

export const keyed: PluginModule = {
  async activate(ctx) {
    const reg = await ctx.keys.register({ key: 'F1', command: 'x.run', args: ['build'], when: { repeat: false, dialog: false, input: 'not-text', visible: true } });
    const active: boolean = reg.active;
    reg.dispose();
    ctx.log(`${String(active)} ${reg.winner ?? ''}`);
    // @ts-expect-error команда обязательна
    await ctx.keys.register({ key: 'F1' });
    // @ts-expect-error незнакомое условие
    await ctx.keys.register({ key: 'F1', command: 'x.run', when: { focus: true } });
    // @ts-expect-error input - 'any' или 'not-text'
    await ctx.keys.register({ key: 'F1', command: 'x.run', when: { input: 'text' } });
    // @ts-expect-error регистрация асинхронна: ядро может отказать
    const sync: { active: boolean } = ctx.keys.register({ key: 'F1', command: 'x.run' });
    ctx.log(String(sync.active));
    return undefined;
  },
};
