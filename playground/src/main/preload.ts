import { contextBridge, ipcRenderer } from 'electron';
import type { PluginsSnapshot, Reply } from '../shared/plugins.ts';

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

contextBridge.exposeInMainWorld('playground', api);
