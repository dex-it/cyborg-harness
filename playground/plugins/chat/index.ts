import type { PluginModule } from '@cyborg/contracts';
import type { ChatMessage } from '../contracts.ts';

// Подписчики живут в других процессах: listener здесь - заглушка ядра, вызов уходит в хост потребителя.
const chat: PluginModule = {
  activate(ctx) {
    const listeners = new Set<(message: ChatMessage) => void>();
    ctx.contracts.provide('demo.chat', '1.0', {
      async send(from, text) {
        for (const listener of listeners) listener({ from, text });
      },
      onMessage(listener) {
        listeners.add(listener);
        ctx.log(`подписчиков: ${listeners.size}`);
        return {
          dispose() {
            listeners.delete(listener);
            ctx.log(`подписчиков: ${listeners.size}`);
          },
        };
      },
    });
    return undefined;
  },
};

export default chat;
