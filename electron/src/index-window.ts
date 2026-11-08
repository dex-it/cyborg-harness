// Общее главного процесса и окна: протокол видов и снимок, который главный процесс отдаёт окну. Без `node:*` и без Electron.
export { PATH_MIME, VIEW_SCHEME, pluginOfOrigin, viewOrigin } from './view-protocol.ts';
export type { TerminalEvent, ViewBridge, ViewDrop } from './view-protocol.ts';
export type { FeedLine, KeptPtyRow, KeyRow, PluginJournalLine, PluginRow, PluginState, PluginsSnapshot, Reply, WorkspaceInfo } from './snapshot.ts';
