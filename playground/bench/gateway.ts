import type { PluginModule } from '@cyborg-harness/contracts';
import { measure, PTY_SCRIPT, type ProbeOs, type ProbePath } from './gateway-probe.ts';

/** Замерщик шлюза (T-07): те же циклы, что в главном процессе, но каждое действие идёт через `ctx.os` и хост. */
const gateway: PluginModule = {
  activate(ctx) {
    const { fs, pty, net, secrets } = ctx.os;
    if (!pty || !net) throw new Error('bench-gateway: в манифесте нет прав pty и net');
    const os: ProbeOs = {
      readText: (file) => fs.readText(file),
      watch: async (dir, listener) => {
        const watch = await fs.watch(dir, listener);
        return async () => watch.dispose();
      },
      pty: async () => {
        const handle = await pty.spawn({ program: '/bin/sh', args: ['-c', PTY_SCRIPT] });
        return { write: (data) => handle.write(data), onData: (listener) => void handle.onData(listener), kill: () => handle.kill('SIGKILL') };
      },
      setSecret: (key, value) => secrets.set(key, value),
      secret: (key) => secrets.get(key),
      fetch: async (url) => (await net.fetch(url)).body,
    };
    ctx.commands.register('bench-gateway.measure', (probe, target, size) => measure(os, probe as ProbePath, String(target), Number(size)));
    return undefined;
  },
};

export default gateway;
