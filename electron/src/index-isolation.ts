// Способ запуска хоста по происхождению плагина и ограничители ОС (TR-21, TR-22, TR-24; ADR-CH-0019) без импорта Electron: приложение собирает ими настройки для `isolatedHosts`,
// тесты и проверки гоняют те же запуски в обычном Node. Явные именованные экспорты: имя в перечне - обещание совместимости.
export { nodeIsolation, pickConfiner, pluginHosts, utilityIsolation } from './node-hosts.ts';
export type { IsolationSettings, NodeHostSettings } from './node-hosts.ts';
export { landlockConfiner } from './confiner-landlock.ts';
export { seatbeltConfiner, seatbeltProfile } from './confiner-seatbelt.ts';
export type { ConfinePolicy, ConfinerLauncher, ConfinerStatus } from './confiner.ts';
