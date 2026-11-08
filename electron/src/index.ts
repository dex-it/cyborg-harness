// Адаптер Electron, часть главного процесса. Явные именованные экспорты: имя в перечне - обещание совместимости.
export { themeTokens } from './theme.ts';
export { guardNavigation, navigationAllowed } from './navigation.ts';
export { resolveDragFile, ViewDrags } from './view-drag.ts';
export { ViewTerminals } from './view-terminals.ts';
export type { TerminalFrame } from './view-terminals.ts';
export { resolveStaticFile, resolveViewRequest, VIEW_CSP } from './view-files.ts';
export type { PluginUi, ViewRequest } from './view-files.ts';
