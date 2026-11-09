import fs from 'node:fs';
import path from 'node:path';
import { BrowserWindow, clipboard, dialog, Notification, safeStorage, shell } from 'electron';
import * as nodePty from 'node-pty';
import { groupKilled, type NoticeEvents, type NoticeHandle, type OsEnvironment, type SecretStore } from '@cyborg-harness/core';

/** Секреты в файле, каждое значение зашифровано safeStorage; без шифрования ОС хранилище недоступно, а не открыто. */
export function fileSecrets(file: string): SecretStore {
  const read = (): Record<string, string> => {
    try {
      const data: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      return typeof data === 'object' && data !== null ? (data as Record<string, string>) : {};
    } catch {
      return {};
    }
  };
  const write = (data: Record<string, string>) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  };
  const set = async (key: string, value: string) => write({ ...read(), [key]: (await safeStorage.encryptStringAsync(value)).toString('base64') });
  return {
    available: () => safeStorage.isAsyncEncryptionAvailable(),
    get: async (key) => {
      const sealed = read()[key];
      if (sealed === undefined) return undefined;
      const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(sealed, 'base64'));
      // Ключ ОС сменился: старое шифрование ещё читается, но перезаписываем новым.
      if (shouldReEncrypt) await set(key, result);
      return result;
    },
    set,
    delete: async (key) => write(Object.fromEntries(Object.entries(read()).filter(([k]) => k !== key))),
  };
}

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

export function electronOs(options: { userData: string; roots: () => readonly string[]; protectedPaths: readonly string[]; workspaceFile?: string; raiseWindow: () => void }): OsEnvironment {
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
    pty: { spawn: (file, args, o) => groupKilled(nodePty.spawn(file, args, o)) },
  };
}
