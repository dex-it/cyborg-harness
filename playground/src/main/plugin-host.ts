import { runHost } from '../../../core/src/host-runtime.ts';
import type { PluginModule } from '../../../core/src/plugin.ts';

const port = process.parentPort;
runHost(
  {
    post: (message) => port.postMessage(message),
    onMessage: (listener) => void port.on('message', (event) => listener(event.data)),
  },
  async (entry) => ((await import(entry)) as { default: PluginModule }).default,
);
