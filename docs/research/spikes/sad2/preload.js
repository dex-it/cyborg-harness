const { contextBridge, ipcRenderer } = require('electron');
// Порт от главного процесса -> страница оболочки (единственный способ отдать MessagePort в основной мир).
ipcRenderer.on('port', (e, meta) => window.postMessage({ type: 'port', id: meta.id }, '*', e.ports));
let bytes = 0;
ipcRenderer.on('data', (_e, d) => { bytes += d.byteLength; });
contextBridge.exposeInMainWorld('cy', {
  echo: (x) => ipcRenderer.invoke('echo', x),
  bytes: () => bytes,
  resetBytes: () => { bytes = 0; },
});
