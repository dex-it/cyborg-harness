// Preload окна и видов: мосты к каналам главного процесса. Имена каналов те же, что в channels.ts; их соответствие держит test/channels.test.ts.
import { contextBridge, ipcRenderer } from 'electron';
import type { ThemeTokens } from '@cyborg-harness/contracts';
import type { FeedLine, PluginsSnapshot, Reply, WindowApi } from './snapshot.ts';
import { VIEW_SCHEME, type TerminalEvent, type ViewBridge } from './view-protocol.ts';

/** Мост окна к службе плагинов: приложение кладёт его в окно под своим именем (`contextBridge.exposeInMainWorld`). */
export function windowApi(): WindowApi {
  return {
    pluginsSnapshot: (): Promise<PluginsSnapshot> => ipcRenderer.invoke('plugins:snapshot'),
    enablePlugin: (id: string): Promise<Reply> => ipcRenderer.invoke('plugins:enable', id),
    disablePlugin: (id: string, keepPty = false): Promise<Reply> => ipcRenderer.invoke('plugins:disable', { id, keepPty }),
    disablePreview: (id: string): Promise<Reply> => ipcRenderer.invoke('plugins:disable-preview', id),
    endKeptPty: (id: string): Promise<Reply> => ipcRenderer.invoke('plugins:end-kept-pty', id),
    crashHost: (id: string): Promise<Reply> => ipcRenderer.invoke('plugins:crash', id),
    hangHost: (id: string): Promise<Reply> => ipcRenderer.invoke('plugins:hang', id),
    runCommand: (command: string): Promise<Reply> => ipcRenderer.invoke('plugins:run', command),
    onPluginsChanged: (listener: () => void): void => void ipcRenderer.on('plugins:changed', () => listener()),
    onWindowCommand: (listener: (command: string) => void): void => void ipcRenderer.on('window:command', (_event, command: string) => listener(command)),
    setViewVisible: (id: string, visible: boolean): Promise<void> => ipcRenderer.invoke('views:visibility', { id, visible }),
    answerDialog: (id: number, choice: string | undefined): Promise<Reply> => ipcRenderer.invoke('window:answer', { id, choice }),
    closeDocument: (id: string): Promise<Reply> => ipcRenderer.invoke('documents:close', id),
    openWorkspace: (file?: string): Promise<Reply> => ipcRenderer.invoke('workspace:open', file),
    setSafeMode: (on: boolean): Promise<Reply> => ipcRenderer.invoke('app:safe-mode', on),
  };
}

/** Мост вида к главному процессу (`window.cyborgView`). */
export function viewBridge(): ViewBridge {
  return {
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
    dialog: (viewName, spec) => ipcRenderer.invoke('view:dialog', viewName, spec),
    keys: () => ipcRenderer.invoke('view:keys'),
    onTerminal: (listener) => void ipcRenderer.on('view:terminal', (_event, event: TerminalEvent) => listener(event)),
  };
}

// nodeIntegrationInSubFrames: тот же preload идёт в каждый фрейм, включая чужие страницы внутри вида, - мост получает только свой документ.
/** Документ вида плагина: схема cyborg-plugin. */
export function inViewFrame(): boolean {
  return location.protocol === `${VIEW_SCHEME}:`;
}

/** Верхний документ окна: файл, а не фрейм. */
export function inWindowDocument(): boolean {
  return location.protocol === 'file:' && window.top === window;
}

/** Кладёт `window.cyborgView` во фрейм вида плагина; в остальных документах ничего не делает. */
export function exposeViewBridge(): void {
  if (inViewFrame()) contextBridge.exposeInMainWorld('cyborgView', viewBridge());
}
