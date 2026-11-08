// Публичный вход ядра для процесса pty-хоста (Node, Electron `utilityProcess`): код хоста поверх любого порта сообщений. Перечень сверяет core/test/public-api.test.ts.
export { nodeViewPort, runPtyHost } from './pty-host.ts';

export type { PtyHost, PtyHostOptions, ViewPort } from './pty-host.ts';
export type { PtyBackend, PtyProcess } from './pty.ts';
export type { Port } from './rpc.ts';
