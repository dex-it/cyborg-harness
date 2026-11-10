// Общее главного процесса и окна: протокол видов и снимок, который главный процесс отдаёт окну. Без `node:*` и без Electron.
export { PATH_MIME, VIEW_SCHEME, groupOfOrigin, viewOrigin } from './view-protocol.ts';
export type { TerminalEvent, ViewBridge, ViewDrop } from './view-protocol.ts';
export { WindowLayerView } from './window-layer.ts';
export type { WindowPort } from './window-layer.ts';
export type { DiagnosticsExport, DiagnosticsStatus, FeedLine, KeptPtyRow, KeyRow, LayoutRow, PluginJournalLine, PluginOrigin, PluginRow, PluginState, PluginsSnapshot, Reply, WindowApi, WorkspaceInfo } from './snapshot.ts';
