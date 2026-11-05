import { contextBridge, ipcRenderer } from 'electron';
import type { FeedLine, PluginsSnapshot, Reply } from '../shared/plugins.ts';
import { VIEW_SCHEME, type SpikeBridge, type SpikePing, type SpikeReport, type ViewBridge } from '../shared/views.ts';

const api = {
  pluginsSnapshot: (): Promise<PluginsSnapshot> => ipcRenderer.invoke('plugins:snapshot'),
  enablePlugin: (id: string): Promise<Reply> => ipcRenderer.invoke('plugins:enable', id),
  disablePlugin: (id: string): Promise<Reply> => ipcRenderer.invoke('plugins:disable', id),
  crashHost: (id: string): Promise<Reply> => ipcRenderer.invoke('plugins:crash', id),
  hangHost: (id: string): Promise<Reply> => ipcRenderer.invoke('plugins:hang', id),
  runCommand: (command: string): Promise<Reply> => ipcRenderer.invoke('plugins:run', command),
  onPluginsChanged: (listener: () => void): void => void ipcRenderer.on('plugins:changed', () => listener()),
};

export type PlaygroundApi = typeof api;

const view: ViewBridge = {
  run: (command) => ipcRenderer.invoke('view:run', command),
  logs: () => ipcRenderer.invoke('view:logs'),
  onLog: (listener) => void ipcRenderer.on('view:log', (_event, line: FeedLine) => listener(line)),
  startDrag: (path) => ipcRenderer.send('view:drag', path),
  drop: () => ipcRenderer.invoke('view:drop'),
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
