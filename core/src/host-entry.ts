import { runHost } from './host-runtime.ts';
import type { PluginModule } from './plugin.ts';

if (!process.send) throw new Error('host-entry запускается только ядром через fork');

const send = process.send.bind(process);
runHost(
  {
    post: (message) => void send(message as object),
    onMessage: (listener) => void process.on('message', listener),
  },
  async (entry) => ((await import(entry)) as { default: PluginModule }).default,
);

process.on('disconnect', () => process.exit(0));
