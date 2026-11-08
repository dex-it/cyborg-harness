// Адаптер Electron, часть главного процесса. Явные именованные экспорты: имя в перечне - обещание совместимости.
export { discoverPlugins, PluginsService, readSchemaFile, startPlugins } from './plugins.ts';
export type { Discovered, PluginsEvents, ServiceOptions, StartOptions } from './plugins.ts';
export { utilityHosts } from './plugin-hosts.ts';
export type { UtilityHosts } from './plugin-hosts.ts';
export { electronOs, fileSecrets } from './os-env.ts';
export { framesOf, fromWindow, registerViewScheme, senderPlugin, serveViews, viewFrames } from './views.ts';
export { resolveStaticFile, resolveViewRequest, VIEW_CSP } from './view-files.ts';
export type { PluginUi, ViewRequest } from './view-files.ts';
export { guardNavigation, navigationAllowed } from './navigation.ts';
export { resolveDragFile, ViewDrags } from './view-drag.ts';
export { ViewTerminals } from './view-terminals.ts';
export type { TerminalFrame } from './view-terminals.ts';
export { themeTokens } from './theme.ts';
export { registerViewChannels, registerWindowChannels, windowChannel } from './channels.ts';
export type { ViewChannelsOptions, WindowChannelsOptions } from './channels.ts';
export { alertNotification, bindWindow, quitAfterPlugins, showWindow, singleInstance, watchPower, watchTheme, windowEvents } from './window.ts';
export { DEFAULT_RESTART_FLAGS, restarts, workspaceInfo } from './restarts.ts';
export type { RestartFlags, RestartOptions, Restarts } from './restarts.ts';
