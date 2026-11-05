// Вид bob: принимает путь файла из чужого фрейма по MIME контракта и показывает отказ на чужую команду.

import type { FeedLine, ViewBridge } from '@cyborg/contracts';

const cyborg = (window as unknown as { cyborgView: ViewBridge }).cyborgView;
const log = document.getElementById('log');
const drop = document.getElementById('drop');

function show(text: string, at = Date.now()): void {
  const item = document.createElement('li');
  item.textContent = `${new Date(at).toLocaleTimeString()} ${text}`;
  log?.append(item);
  item.scrollIntoView({ block: 'nearest' });
}

const run = (command: string) => () => {
  void cyborg.run(command).then((reply) => {
    if (reply.error) show(`отказ: ${reply.error}`);
  });
};
document.getElementById('hello')?.addEventListener('click', run('bob.hello'));
document.getElementById('status')?.addEventListener('click', run('bob.status'));
document.getElementById('foreign')?.addEventListener('click', run('alice.hello'));

drop?.addEventListener('dragover', (event) => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  drop.classList.add('over');
});
drop?.addEventListener('dragleave', () => drop.classList.remove('over'));
drop?.addEventListener('drop', (event) => {
  event.preventDefault();
  drop.classList.remove('over');
  void cyborg.drop().then((got) => show(got ? `получен путь: ${got.path} из вида ${got.from}` : 'сброшен файл не из вида'));
});

cyborg.onLog((line: FeedLine) => show(line.text, line.at));
void cyborg.logs().then((lines) => lines.forEach((line) => show(line.text, line.at)));
