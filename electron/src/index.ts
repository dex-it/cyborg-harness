// Адаптер Electron, часть главного процесса. Явные именованные экспорты: имя в перечне - обещание совместимости.
export type { ServeViewsOptions } from './views.ts';
export type { ElectronOsOptions } from './os-env.ts';
export { discoverPlugins, PluginsService, startPlugins, USER_PLUGINS_FLAG } from './plugins.ts';
export type { Discovered, PluginsEvents, ServiceOptions, StartOptions } from './plugins.ts';
export { utilityHosts, utilityPtyHost } from './plugin-hosts.ts';
export type { UtilityHosts, UtilityPtyHost } from './plugin-hosts.ts';
export { electronOs } from './os-env.ts';
export { framesOf, registerViewScheme, serveViews } from './views.ts';
export { resolveStaticFile, resolveViewRequest, VIEW_CSP } from './view-files.ts';
export type { PluginUi, ViewCsp, ViewRequest } from './view-files.ts';
export { guardNavigation } from './navigation.ts';
export type { ViewGroups } from './view-frames.ts';
export type { PortPair } from './view-terminals.ts';
export { registerViewChannels, registerWindowChannels, viewChannel, windowChannel } from './channels.ts';
export type { ViewChannelsOptions, WindowChannelsOptions } from './channels.ts';
export { alertNotification, bindWindow, quitAfterPlugins, showWindow, singleInstance, watchPower, watchTheme, windowEvents } from './window.ts';
export { restarts, workspaceInfo } from './restarts.ts';
export type { RestartFlags, RestartOptions, Restarts } from './restarts.ts';
