import { contextBridge, ipcRenderer } from 'electron';
import type { ThemeTokens } from '@cyborg/contracts';
import type { FeedLine, PluginsSnapshot, Reply } from '../shared/plugins.ts';
import { VIEW_SCHEME, type SpikeBridge, type SpikePing, type SpikeReport, type TerminalEvent, type ViewBridge } from '../shared/views.ts';

const api = {
  pluginsSnapshot: (): Promise<PluginsSnapshot> => ipcRenderer.invoke('plugins:snapshot'),
  enablePlugin: (id: string): Promise<Reply> => ipcRenderer.invoke('plugins:enable', id),
  disablePlugin: (id: string, keepPty = false): Promise<Reply> => ipcRenderer.invoke('plugins:disable', { id, keepPty }),
  disablePreview: (id: string): Promise<Reply> => ipcRenderer.invoke('plugins:disable-preview', id),
  crashHost: (id: string): Promise<Reply> => ipcRenderer.invoke('plugins:crash', id),
  hangHost: (id: string): Promise<Reply> => ipcRenderer.invoke('plugins:hang', id),
  runCommand: (command: string): Promise<Reply> => ipcRenderer.invoke('plugins:run', command),
  onPluginsChanged: (listener: () => void): void => void ipcRenderer.on('plugins:changed', () => listener()),
  setViewVisible: (id: string, visible: boolean): Promise<void> => ipcRenderer.invoke('views:visibility', { id, visible }),
};

export type PlaygroundApi = typeof api;

const view: ViewBridge = {
  run: (command, args) => ipcRenderer.invoke('view:run', command, args),
  contract: (contract, major) => ipcRenderer.invoke('view:contract', contract, major),
  call: (contract, major, method, args) => ipcRenderer.invoke('view:call', contract, major, method, args),
  theme: () => ipcRenderer.invoke('view:theme'),
  onTheme: (listener) => void ipcRenderer.on('view:theme', (_event, tokens: ThemeTokens) => listener(tokens)),
  onVisibility: (listener) => void ipcRenderer.on('view:visibility', (_event, visible: boolean) => listener(visible)),
  logs: () => ipcRenderer.invoke('view:logs'),
  onLog: (listener) => void ipcRenderer.on('view:log', (_event, line: FeedLine) => listener(line)),
  startDrag: (path) => ipcRenderer.send('view:drag', path),
  drop: () => ipcRenderer.invoke('view:drop'),
  terminalOpen: (ticket) => ipcRenderer.invoke('view:terminal:open', ticket),
  terminalWrite: (tid, data) => ipcRenderer.invoke('view:terminal:write', tid, data),
  terminalResize: (tid, cols, rows) => ipcRenderer.invoke('view:terminal:resize', tid, cols, rows),
  terminalClose: (tid) => ipcRenderer.send('view:terminal:close', tid),
  state: (viewName) => ipcRenderer.invoke('view:state', viewName),
  setState: (viewName, value) => ipcRenderer.invoke('view:state:set', viewName, value),
  onTerminal: (listener) => void ipcRenderer.on('view:terminal', (_event, event: TerminalEvent) => listener(event)),
};

const spike: SpikeBridge = {
  onPing: (listener) => void ipcRenderer.on('spike:ping', (_event, ping: SpikePing) => listener(ping)),
  pong: (n) => ipcRenderer.send('spike:pong', n),
  onRelay: (listener) => void ipcRenderer.on('spike:relay', (_event, target: number, ping: SpikePing) => listener(target, ping)),
  report: (event: SpikeReport) => ipcRenderer.send('spike:report', event),
};

// nodeIntegrationInSubFrames: тот же preload идёт в каждый фрейм, включая чужие страницы внутри вида, - мост получает только свой документ.
const inView = location.protocol === `${VIEW_SCHEME}:`;
const inWindow = location.protocol === 'file:' && window.top === window;
if (inView) contextBridge.exposeInMainWorld('cyborgView', view);
if (inWindow && !location.pathname.endsWith('/spike.html')) contextBridge.exposeInMainWorld('playground', api);
if ((inView && /^probe(?:-\d+)?$/.test(location.host)) || (inWindow && location.pathname.endsWith('/spike.html'))) contextBridge.exposeInMainWorld('spike', spike);
