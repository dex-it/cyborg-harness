import { contextBridge, ipcRenderer } from 'electron';
import { exposeViewBridge, inViewFrame, inWindowDocument, windowApi } from '@cyborg-harness/electron/preload';
import type { SpikeBridge, SpikePing, SpikeReport } from '../shared/spike.ts';

const api = windowApi();

/** Мост окна под именем `window.playground`: имя выбирает приложение. */
export type PlaygroundApi = typeof api;

const spike: SpikeBridge = {
  onPing: (listener) => void ipcRenderer.on('spike:ping', (_event, ping: SpikePing) => listener(ping)),
  pong: (n) => ipcRenderer.send('spike:pong', n),
  onRelay: (listener) => void ipcRenderer.on('spike:relay', (_event, target: number, ping: SpikePing) => listener(target, ping)),
  report: (event: SpikeReport) => ipcRenderer.send('spike:report', event),
};

exposeViewBridge();
const inWindow = inWindowDocument();
if (inWindow && !location.pathname.endsWith('/spike.html')) contextBridge.exposeInMainWorld('playground', api);
if ((inViewFrame() && /^probe(?:-\d+)?$/.test(location.host)) || (inWindow && location.pathname.endsWith('/spike.html'))) contextBridge.exposeInMainWorld('spike', spike);
