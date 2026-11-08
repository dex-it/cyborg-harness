// Адаптер Electron, часть главного процесса. Явные именованные экспорты: имя в перечне - обещание совместимости.
export { themeTokens } from './theme.ts';
export { resolveStaticFile, resolveViewRequest, VIEW_CSP } from './view-files.ts';
export type { PluginUi, ViewRequest } from './view-files.ts';
