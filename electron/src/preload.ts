// Preload окна и видов: мосты к каналам главного процесса. Имена каналов те же, что в channels.ts; их соответствие держит test/channels.test.ts.
import { contextBridge, ipcRenderer } from 'electron';
import type { ThemeTokens } from '@cyborg-harness/contracts';
import type { FeedLine, PluginsSnapshot, Reply, WindowApi } from './snapshot.ts';
import { VIEW_SCHEME, type TerminalEvent, type ViewBridge } from './view-protocol.ts';
import { terminalPorts } from './terminal-ports.ts';

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
    setViewVisible: (id: string, view: string, visible: boolean): Promise<void> => ipcRenderer.invoke('views:visibility', { id, view, visible }),
    answerDialog: (id: number, choice: string | undefined): Promise<Reply> => ipcRenderer.invoke('window:answer', { id, choice }),
    closeDocument: (id: string): Promise<Reply> => ipcRenderer.invoke('documents:close', id),
    openWorkspace: (file?: string): Promise<Reply> => ipcRenderer.invoke('workspace:open', file),
    openWorkspaceInNewWindow: (file: string): Promise<Reply> => ipcRenderer.invoke('workspace:open-new', file),
    setSafeMode: (on: boolean): Promise<Reply> => ipcRenderer.invoke('app:safe-mode', on),
  };
}

/** Мост вида к главному процессу (`window.cyborgView`). */
export function viewBridge(): ViewBridge {
  // Вывод терминала идёт из pty-хоста прямо в порт, ввод и размер - обратно по нему же; главный процесс отдаёт порт и в потоке не стоит.
  const terminals = terminalPorts();
  ipcRenderer.on('view:terminal:port', (event, message: { tid?: unknown }) => {
    if (typeof message.tid === 'number' && event.ports[0]) terminals.arrived(message.tid, event.ports[0]);
  });
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
    terminalOpen: async (ticket) => {
      const reply = (await ipcRenderer.invoke('view:terminal:open', ticket)) as Reply;
      const tid = (reply.value as { tid?: unknown } | undefined)?.tid;
      if (reply.error !== undefined || typeof tid !== 'number') return reply;
      const input = (reply.value as { input?: unknown }).input;
      if (await terminals.connect(tid, typeof input === 'number' ? input : undefined)) return reply;
      // Вид получает отказ и не позовёт `terminalClose`: запись терминала и зритель в pty-хосте закрываются здесь.
      ipcRenderer.send('view:terminal:close', tid);
      return { error: `терминал ${String(tid)}: порт от ядра не пришёл` };
    },
    terminalWrite: (tid, data) => terminals.request(tid, { op: 'write', data }),
    terminalResize: (tid, cols, rows) => terminals.request(tid, { op: 'resize', cols, rows }),
    terminalClose: (tid) => {
      terminals.close(tid);
      ipcRenderer.send('view:terminal:close', tid);
    },
    state: (viewName) => ipcRenderer.invoke('view:state', viewName),
    setState: (viewName, value) => ipcRenderer.invoke('view:state:set', viewName, value),
    dialog: (viewName, spec) => ipcRenderer.invoke('view:dialog', viewName, spec),
    keys: () => ipcRenderer.invoke('view:keys'),
    onTerminal: (listener) => {
      terminals.listen(listener);
      // Потеря pty-хоста: порт молчит, главный процесс сообщает о конце событием управления.
      ipcRenderer.on('view:terminal', (_event, event: TerminalEvent) => terminals.lost(event));
    },
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

/** Что в фокусе: поле ввода, терминал (xterm держит скрытый textarea) или остальное; ядро по этому решает судьбу сочетаний с `when.input`. */
function focusKind(target: EventTarget | null): 'text' | 'terminal' | 'other' {
  if (!(target instanceof HTMLElement)) return 'other';
  if (target.classList.contains('xterm-helper-textarea')) return 'terminal';
  if (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return 'text';
  if (target instanceof HTMLInputElement) return ['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'image', 'file'].includes(target.type) ? 'other' : 'text';
  return 'other';
}

/** Кладёт `window.cyborgView` во фрейм вида плагина и сообщает главному процессу, где фокус ввода (в виде и в документе окна); в остальных документах ничего не делает. */
export function exposeViewBridge(): void {
  if (inViewFrame() || inWindowDocument()) {
    window.addEventListener(
      'focusin',
      (event) => {
        const target = event.composedPath()[0] ?? event.target;
        // Фокус во вложенном фрейме сообщает сам фрейм: элемент <iframe> в родителе - не место ввода.
        if (!(target instanceof HTMLIFrameElement)) ipcRenderer.send('input:focus', focusKind(target));
      },
      true,
    );
    window.addEventListener('focusout', () => ipcRenderer.send('input:focus', 'blur'), true);
  }
  if (inViewFrame()) contextBridge.exposeInMainWorld('cyborgView', viewBridge());
}
