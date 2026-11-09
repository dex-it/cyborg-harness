// Публичный вход ядра для процесса хоста плагинов (Node, Electron `utilityProcess`): код хоста поверх любого порта сообщений. Перечень сверяет core/test/public-api.test.ts.
export { runHost } from './host-runtime.ts';

export type { HostOptions, Importer } from './host-runtime.ts';
export type { Port } from './rpc.ts';
