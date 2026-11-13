import { runHost } from './host-runtime.ts';
import type { PluginModule } from './plugin.ts';
import type { Port } from './rpc.ts';
import { jsonPort, WIRE_JSON } from './wire-codec.ts';

if (!process.send) throw new Error('host-entry запускается только ядром через fork');

const send = process.send.bind(process);
const raw: Port = {
  post: (message) => void send(message),
  onMessage: (listener) => void process.on('message', listener),
};
runHost(
  // Канал `json` (хост на отдельном Node): типы structuredClone едут тегированным JSON.
  process.argv.includes(WIRE_JSON) ? jsonPort(raw) : raw,
  async (entry) => ((await import(entry)) as { default: PluginModule }).default,
  { ownsProcess: true },
);

process.on('disconnect', () => process.exit(0));
