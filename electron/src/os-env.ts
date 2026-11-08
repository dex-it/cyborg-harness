import path from 'node:path';
import { BrowserWindow, clipboard, dialog, Notification, safeStorage, shell } from 'electron';
import * as nodePty from 'node-pty';
import { fileSecrets as sealedFileSecrets, type SecretCipher } from './secrets-file.ts';
import { groupKilled, type NoticeEvents, type NoticeHandle, type OsEnvironment, type SecretStore } from '@cyborg-harness/core';

const safeCipher: SecretCipher = {
  available: () => safeStorage.isAsyncEncryptionAvailable(),
  encrypt: (text) => safeStorage.encryptStringAsync(text),
  decrypt: (sealed) => safeStorage.decryptStringAsync(sealed),
};

/** Секреты в файле, каждое значение зашифровано safeStorage; без шифрования ОС хранилище недоступно, а не открыто. */
export const fileSecrets = (file: string): SecretStore => sealedFileSecrets(file, safeCipher);

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
  /** Откуда берутся pty: по умолчанию `node-pty` в главном процессе; отдельный pty-хост ядра (K-01) подставляется здесь. */
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
    secrets: fileSecrets(path.join(options.userData, 'secrets.json')),
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
    pty: options.pty ?? { spawn: (file, args, o) => groupKilled(nodePty.spawn(file, args, o)) },
  };
}
