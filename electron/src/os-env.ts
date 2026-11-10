import path from 'node:path';
import { BrowserWindow, clipboard, dialog, Notification, safeStorage, shell } from 'electron';
import type { NoticeEvents, NoticeHandle, OsEnvironment, SpawnPtyHost } from '@cyborg-harness/core';
import { nodePtyBackend } from './pty-backend.ts';
import { fileSecrets, type SecretCipher } from './secrets-file.ts';

const safeCipher: SecretCipher = {
  available: () => safeStorage.isAsyncEncryptionAvailable(),
  encrypt: (text) => safeStorage.encryptStringAsync(text),
  decrypt: (sealed) => safeStorage.decryptStringAsync(sealed),
};

// Без ссылки сборщик мусора забирает Notification, и клик по нему уже ничего не вызывает.
const shown = new Set<Notification>();

function showNotification(title: string, body: string | undefined, events: NoticeEvents): NoticeHandle | undefined {
  if (!Notification.isSupported()) return undefined;
  const notification = new Notification({ title, ...(body !== undefined && { body }) });
  const gone = () => {
    if (shown.delete(notification)) events.closed();
  };
  notification.on('click', () => {
    shown.delete(notification);
    events.click();
  });
  notification.on('close', gone);
  notification.on('failed', gone);
  shown.add(notification);
  notification.show();
  return {
    close: () => {
      shown.delete(notification);
      notification.close();
    },
  };
}

export interface ElectronOsOptions {
  readonly userData: string;
  readonly roots: () => readonly string[];
  readonly protectedPaths: readonly string[];
  readonly workspaceFile?: string;
  readonly raiseWindow: () => void;
  /** Отдельный процесс pty-хоста (`utilityPtyHost`, K-01): `node-pty` живёт в нём, ядро следит за ним сторожем. Сильнее `pty`. */
  readonly ptyHost?: SpawnPtyHost;
  /** Без `ptyHost` pty берутся из этого бэкенда в главном процессе (по умолчанию `node-pty`, загружается при первом pty): зависший нативный модуль заморозит окно. */
  readonly pty?: OsEnvironment['pty'];
}

export function electronOs(options: ElectronOsOptions): OsEnvironment {
  return {
    dataDir: path.join(options.userData, 'plugin-data'),
    tempDir: path.join(options.userData, 'plugin-temp'),
    appDir: options.userData,
    protectedPaths: options.protectedPaths,
    ...(options.workspaceFile !== undefined && { workspaceFile: options.workspaceFile }),
    roots: options.roots,
    secrets: fileSecrets(path.join(options.userData, 'secrets.json'), safeCipher),
    notify: showNotification,
    raiseWindow: options.raiseWindow,
    clipboard: { readText: () => clipboard.readText(), writeText: (text) => clipboard.writeText(text) },
    shell: {
      openPath: async (p) => {
        const error = await shell.openPath(p);
        if (error) throw new Error(error);
      },
      openExternal: (url) => shell.openExternal(url),
      showItemInFolder: (p) => shell.showItemInFolder(p),
    },
    dialog: {
      open: async (o) => {
        const properties: ('openFile' | 'openDirectory' | 'multiSelections')[] = [o.directory ? 'openDirectory' : 'openFile', ...(o.multiple ? (['multiSelections'] as const) : [])];
        const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
        const result = await (win ? dialog.showOpenDialog(win, { properties, ...(o.title !== undefined && { title: o.title }) }) : dialog.showOpenDialog({ properties, ...(o.title !== undefined && { title: o.title }) }));
        return result.canceled ? [] : result.filePaths;
      },
    },
    ...(options.ptyHost !== undefined && { ptyHost: options.ptyHost }),
    pty: options.pty ?? nodePtyBackend(),
  };
}
