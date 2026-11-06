import type { Agent, PluginModule } from '@cyborg-harness/contracts';

// Второй поставщик cyborg.agent: агент без следов - только запуск и вывод, чтобы контракт не выточился под Claude Code.
const agent: Agent = {
  facts: async () => ({ id: 'shell', title: 'Оболочка', found: true, capabilities: { resume: false, history: false, events: false } }),
  launch: async (request) => ({ program: '/bin/sh', args: [], cwd: request.cwd, env: {} }),
  watch: () => ({ dispose: () => undefined }),
  ended: async (_sessionId, exit) => (exit.code === 127 ? { kind: 'notFound', message: '/bin/sh не найден' } : null),
  history: async () => [],
};

const plugin: PluginModule = {
  activate(ctx) {
    ctx.contracts.provide('cyborg.agent', '1.0', agent);
    return undefined;
  },
};

export default plugin;
