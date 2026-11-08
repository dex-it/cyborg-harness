// Адаптер Electron, часть главного процесса. Явные именованные экспорты: имя в перечне - обещание совместимости.
export { themeTokens } from './theme.ts';
export { utilityHosts } from './plugin-hosts.ts';
export type { UtilityHosts } from './plugin-hosts.ts';
export { electronOs, fileSecrets } from './os-env.ts';
export { discoverPlugins, PluginsService, readSchemaFile, startPlugins } from './plugins.ts';
export type { Discovered, PluginsEvents, ServiceOptions, StartOptions } from './plugins.ts';
export { framesOf, fromWindow, registerViewScheme, senderPlugin, serveViews, viewFrames } from './views.ts';
export { guardNavigation, navigationAllowed } from './navigation.ts';
export { resolveDragFile, ViewDrags } from './view-drag.ts';
export { ViewTerminals } from './view-terminals.ts';
export type { TerminalFrame } from './view-terminals.ts';
export { resolveStaticFile, resolveViewRequest, VIEW_CSP } from './view-files.ts';
export type { PluginUi, ViewRequest } from './view-files.ts';
