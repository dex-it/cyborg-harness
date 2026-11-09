import { runHost } from '@cyborg-harness/core/host';
import type { PluginModule } from '@cyborg-harness/core';

const port = process.parentPort;
runHost(
  {
    post: (message) => port.postMessage(message),
    onMessage: (listener) => void port.on('message', (event) => listener(event.data)),
  },
  async (entry) => ((await import(entry)) as { default: PluginModule }).default,
  { ownsProcess: true },
);
