// Вид alice: свой документ в <iframe> с origin cyborg-plugin://alice; до ядра - только через window.cyborgView.

import type { FeedLine, ViewBridge } from '@cyborg/contracts';

const cyborg = (window as unknown as { cyborgView: ViewBridge }).cyborgView;
const log = document.getElementById('log');

function show(line: FeedLine): void {
  const item = document.createElement('li');
  item.textContent = `${new Date(line.at).toLocaleTimeString()} ${line.text}`;
  log?.append(item);
  item.scrollIntoView({ block: 'nearest' });
}

document.getElementById('hello')?.addEventListener('click', () => {
  void cyborg.run('alice.hello').then((reply) => {
    if (reply.error) show({ at: Date.now(), kind: 'error', subject: 'alice', text: reply.error });
  });
});
document.getElementById('file')?.addEventListener('dragstart', (event) => {
  event.preventDefault();
  cyborg.startDrag('notes.md');
});

cyborg.onLog(show);
void cyborg.logs().then((lines) => lines.forEach(show));
