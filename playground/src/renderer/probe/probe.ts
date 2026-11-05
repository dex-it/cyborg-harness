// Пробный вид замера: отвечает на ping обоими мостами, сообщает о клавишах и перетаскивании.

import { PATH_MIME, type SpikeBridge, type SpikePing, type ViewBridge } from '../../shared/views.ts';

const spike = (window as unknown as { spike: SpikeBridge }).spike;
const view = (window as unknown as { cyborgView: ViewBridge }).cyborgView;
const received = document.getElementById('received');
let bytes = 0;

const take = (ping: SpikePing) => {
  bytes += ping.data?.length ?? 0;
  if (ping.ack && received) received.textContent = String(bytes);
};

spike.onPing((ping) => {
  take(ping);
  if (ping.ack) spike.pong(ping.n);
});
window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return;
  const ping = event.data as SpikePing;
  take(ping);
  // У окна origin file://, его нельзя назвать в targetOrigin; ответ несёт только номер.
  if (ping.ack) window.parent.postMessage({ pong: ping.n }, '*');
});

window.addEventListener('keydown', (event) => spike.report({ kind: 'key', key: event.key, ctrl: event.ctrlKey, shift: event.shiftKey }));

document.getElementById('drag')?.addEventListener('dragstart', (event) => {
  event.dataTransfer?.setData(PATH_MIME, '/demo/notes.md');
  event.dataTransfer?.setData('text/plain', 'notes.md');
  spike.report({ kind: 'dragstart' });
});
document.getElementById('kdrag')?.addEventListener('dragstart', (event) => {
  event.preventDefault();
  view.startDrag('/demo/notes.md');
  spike.report({ kind: 'dragstart' });
});
const drop = document.getElementById('drop');
drop?.addEventListener('dragover', (event) => {
  const types = event.dataTransfer?.types ?? [];
  if (types.includes(PATH_MIME) || types.includes('Files')) event.preventDefault();
});
drop?.addEventListener('drop', (event) => {
  event.preventDefault();
  const types = [...(event.dataTransfer?.types ?? [])];
  if (types.includes(PATH_MIME)) spike.report({ kind: 'drop', types, path: event.dataTransfer?.getData(PATH_MIME) ?? '', from: null });
  else void view.drop().then((got) => spike.report({ kind: 'drop', types, path: got?.path ?? '', from: got?.from ?? null }));
});
