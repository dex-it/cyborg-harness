// Проверяется компилятором в npm run typecheck: строка под @ts-expect-error обязана не компилироваться.
import type { PluginModule } from '../src/plugin.ts';
import type { CoreErrorCode, Remote } from '@cyborg-harness/contracts';
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
    // @ts-expect-error в пакете нет контракта cyborg.tab
    ctx.contracts.get('cyborg.tab', 1);
    // cyborg.sessions (PL-02): подписка идёт через границу хоста, поэтому ответ - Promise<Subscription>; вариантов изменения четыре.
    const sessions = ctx.contracts.get('cyborg.sessions', 1);
    void sessions?.onChange((e) => {
      if (e.change.type === 'waiting') ctx.log(`${e.title}: ${e.change.reason}`);
      // @ts-expect-error у варианта cwd нет reason
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- проверка компилятора: тип обращения к несуществующему полю - error
      if (e.change.type === 'cwd') ctx.log(e.change.reason);
    });
    // @ts-expect-error подписка возвращает Subscription асинхронно, у Promise нет dispose
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- проверка компилятора: dispose у Promise не существует
    void sessions?.onChange(() => undefined).dispose();
    // @ts-expect-error мажорной версии 2 у cyborg.sessions нет
    ctx.contracts.get('cyborg.sessions', 2);
    void v1?.read('/a');
    void v2?.readText('/a');
    const tabs = ctx.contracts.all('demo.tab', 1);
    // @ts-expect-error icon появился в 1.1 и может отсутствовать
    tabs.map((t) => t.impl.icon.length);
    // @ts-expect-error синхронный nowSync через границу хоста становится асинхронным
    const n: number | undefined = ctx.contracts.get('demo.clock', 1)?.nowSync();
    ctx.log(String(n));
    // Уровень строки (K-29): необязательный, из трёх значений.
    ctx.log('x', 'warn');
    // @ts-expect-error уровней три: info, warn, error
    ctx.log('x', 'debug');
    // @ts-expect-error обработчик команды принимает unknown, а не объявленный тип
    ctx.commands.register('x.open', (path: string) => path);
  },
};

// Отмена вызова (K-09): код отказа входит в публичный тип, сигнал в options у process.run допустим, а флаг вместо сигнала - нет.
export const cancelled: CoreErrorCode = 'Cancelled';
// @ts-expect-error такого кода отказа нет
export const unknownCode: CoreErrorCode = 'Aborted';
export const stoppable: PluginModule = {
  activate(ctx) {
    const abort = new AbortController();
    void ctx.os.process?.run('git', ['status'], { signal: abort.signal, timeoutMs: 1000 });
    // @ts-expect-error сигнал отмены у process.run - AbortSignal, а не флаг
    void ctx.os.process?.run('git', ['status'], { signal: true });
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

// Черновики PL-04: git отдаёт состояние и отметки дерева, дерево потребляет отметки с кратностью many.
export const treeAndGit: PluginModule = {
  async activate(ctx) {
    const git = ctx.contracts.get('cyborg.git', 1);
    const status = await git?.status('/repo');
    const branch: string | null | undefined = status?.branch;
    const first: string | undefined = status?.changes[0]?.path;
    ctx.log(`${branch ?? '-'} ${first ?? '-'}`);
    // @ts-expect-error репозиторий называется путём, а не объектом
    await git?.status({ path: '/repo' });
    for (const { impl } of ctx.contracts.all('cyborg.tree-decoration', 1)) {
      const marks = await impl.marks('/repo');
      const kind: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflict' | undefined = marks[0]?.kind;
      ctx.log(kind ?? '-');
      // @ts-expect-error вида отметки «ignored» в черновике нет
      const bad: typeof kind = 'ignored';
      ctx.log(String(bad));
    }
    ctx.contracts.provide('cyborg.tree-decoration', '1.0', { marks: async () => [], onChange: () => ({ dispose() {} }) });
    // @ts-expect-error мажорной версии 2 у черновика нет
    ctx.contracts.get('cyborg.git', 2);
  },
};
