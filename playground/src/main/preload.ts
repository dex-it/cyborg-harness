import { contextBridge, ipcRenderer } from 'electron';
import type { PluginsSnapshot } from '../shared/plugins.ts';

const api = {
  pluginsSnapshot: (): Promise<PluginsSnapshot> => ipcRenderer.invoke('plugins:snapshot'),
  revivePlugin: (id: string): Promise<{ error?: string }> => ipcRenderer.invoke('plugins:revive', id),
  onPluginsChanged: (listener: () => void): void => void ipcRenderer.on('plugins:changed', () => listener()),
};

export type PlaygroundApi = typeof api;

contextBridge.exposeInMainWorld('playground', api);
