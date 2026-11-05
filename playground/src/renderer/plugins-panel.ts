// Окно playground: плагины с кнопками над ядром, сочетания клавиш, лента сообщений плагинов и журнал ядра (SAD2 §3.2, §3.5).

import { keyOfInput } from '../../../core/src/keys.ts';
import type { FeedLine, KeyRow, PluginRow, PluginsSnapshot, Reply } from '../shared/plugins.ts';
import { byId, el } from './dom.ts';
import { ViewsPanel } from './views-panel.ts';
import { actionsFor, clock, conflictText, journalFor, keyStatus, mergeFeed, sortedPlugins, STATE_LABEL, summary, type ActionButton } from './plugins-model.ts';

export interface PluginsPort {
  pluginsSnapshot(): Promise<PluginsSnapshot>;
  enablePlugin(id: string): Promise<Reply>;
  disablePlugin(id: string): Promise<Reply>;
  crashHost(id: string): Promise<Reply>;
  hangHost(id: string): Promise<Reply>;
  runCommand(command: string): Promise<Reply>;
  onPluginsChanged(listener: () => void): void;
}

const LOCAL_LIMIT = 50;

export class PluginsPanel {
  private readonly summaryEl = byId('plugins-summary', HTMLElement);
  private readonly problemsEl = byId('plugins-problems', HTMLElement);
  private readonly listEl = byId('plugins-list', HTMLElement);
  private readonly keysEl = byId('keys-list', HTMLElement);
  private readonly feedEl = byId('feed', HTMLElement);
  private readonly journalTitle = byId('plugins-journal-title', HTMLElement);
  private readonly journalAll = byId('plugins-journal-all', HTMLButtonElement);
  private readonly journalEl = byId('plugins-journal', HTMLElement);
  private readonly views = new ViewsPanel(byId('views', HTMLElement));
  private snapshot: PluginsSnapshot | null = null;
  private focus: string | null = null;
  private readonly errors = new Map<string, string>();
  private readonly busy = new Set<string>();
  /** Нажатия, которые ядро не забрало: о них знает только страница. */
  private readonly local: FeedLine[] = [];
  private loading = false;
  private again = false;
  private readonly port: PluginsPort;

  constructor(port: PluginsPort) {
    this.port = port;
    this.journalAll.addEventListener('click', () => this.showJournal(null));
    port.onPluginsChanged(() => void this.refresh());
    window.addEventListener('keydown', (event) => this.reached(event));
  }

  /** Записи журнала идут пачками: пока снимок в пути, следующие изменения сливаются в один повтор. */
  async refresh(): Promise<void> {
    if (this.loading) {
      this.again = true;
      return;
    }
    this.loading = true;
    try {
      do {
        this.again = false;
        this.snapshot = await this.port.pluginsSnapshot();
        this.render();
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- again взводит refresh, пришедший во время await
      } while (this.again);
    } finally {
      this.loading = false;
    }
  }

  private reached(event: KeyboardEvent): void {
    if (event.repeat) return;
    const key = keyOfInput({ key: event.key, code: event.code, control: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey });
    // Буквы без модификатора - обычный ввод, не сочетание.
    if (key === undefined || (!key.includes('+') && !/^F\d/.test(key))) return;
    this.local.push({ at: Date.now(), kind: 'window', subject: key, text: 'до окна дошло: ядро не забрало' });
    if (this.local.length > LOCAL_LIMIT) this.local.shift();
    this.renderFeed();
  }

  private render(): void {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    this.summaryEl.textContent = summary(snapshot);
    this.problemsEl.textContent = snapshot.problems.length ? `Не дошло до ядра:\n${snapshot.problems.join('\n')}` : '';
    this.problemsEl.hidden = snapshot.problems.length === 0;
    this.listEl.replaceChildren(...sortedPlugins(snapshot.plugins).map((row) => this.row(row, snapshot.canHang)));
    this.keysEl.replaceChildren(...(snapshot.keys.length ? snapshot.keys.map((row) => this.keyRow(row)) : [this.emptyKeys()]));
    this.renderFeed();
    this.renderJournal();
    this.views.sync(snapshot.plugins);
  }

  private row(row: PluginRow, canHang: boolean): HTMLElement {
    const item = el('li', 'plugin-row');
    item.dataset.state = row.state;
    item.dataset.plugin = row.id;
    const head = el('div', 'plugin-head');
    head.append(el('span', 'plugin-name', row.id));
    if (row.version) head.append(el('span', 'plugin-version', row.version));
    if (row.host) head.append(el('span', 'plugin-host', row.pid === undefined ? `хост ${row.host}` : `хост ${row.host} · pid ${row.pid}`));
    head.append(el('span', 'spacer'), el('span', 'plugin-state', STATE_LABEL[row.state]));
    item.append(head);
    if (row.reason) item.append(el('p', 'plugin-reason', row.reason));
    const error = this.errors.get(row.id);
    if (error) {
      const line = el('p', 'plugin-error', error);
      line.setAttribute('role', 'alert');
      item.append(line);
    }
    const bar = el('div', 'plugin-actions');
    bar.append(...actionsFor(row, canHang).map((button) => this.button(row.id, button)));
    item.append(bar);
    return item;
  }

  private button(id: string, spec: ActionButton): HTMLButtonElement {
    const button = el('button', [spec.primary ? 'primary' : '', spec.action === 'run' ? 'command' : ''].join(' ').trim(), spec.label) as HTMLButtonElement;
    button.type = 'button';
    button.dataset.action = spec.action;
    if (spec.action === 'journal') {
      button.setAttribute('aria-label', `Журнал ${id}`);
      button.addEventListener('click', () => this.showJournal(id));
      return button;
    }
    button.disabled = this.busy.has(id);
    button.addEventListener('click', () => void this.act(id, spec));
    return button;
  }

  private async act(id: string, spec: ActionButton): Promise<void> {
    if (spec.action === 'journal') return;
    const call: Record<Exclude<ActionButton['action'], 'journal'>, () => Promise<Reply>> = {
      run: () => this.port.runCommand(spec.command ?? ''),
      disable: () => this.port.disablePlugin(id),
      enable: () => this.port.enablePlugin(id),
      crash: () => this.port.crashHost(id),
      hang: () => this.port.hangHost(id),
    };
    this.busy.add(id);
    this.errors.delete(id);
    this.render();
    try {
      const reply = await call[spec.action]();
      if (reply.error) this.errors.set(id, reply.error);
    } catch (error) {
      this.errors.set(id, (error as Error).message);
    } finally {
      this.busy.delete(id);
    }
    await this.refresh();
  }

  private keyRow(row: KeyRow): HTMLElement {
    const tr = el('tr', 'key-row');
    tr.dataset.key = row.key;
    tr.dataset.live = String(row.live);
    const keyCell = el('td');
    keyCell.append(el('kbd', '', row.key));
    const command = el('td');
    command.append(el('span', 'key-command', row.command), el('span', 'key-owner', ` (${row.pluginId})`));
    const conflict = conflictText(row);
    if (conflict) command.append(el('div', 'key-conflict', conflict));
    tr.append(keyCell, command, el('td', 'key-status', keyStatus(row)));
    return tr;
  }

  private emptyKeys(): HTMLElement {
    const tr = el('tr');
    const td = el('td', 'empty', 'Плагины не объявили сочетаний');
    td.setAttribute('colspan', '3');
    tr.append(td);
    return tr;
  }

  private renderFeed(): void {
    const lines = mergeFeed(this.snapshot?.feed ?? [], this.local);
    const items = lines.map((line) => {
      const item = el('li', `log-line kind-${line.kind}`);
      item.append(el('time', 'log-time', clock(line.at)), el('span', 'log-subject', line.subject), el('span', 'log-text', line.text));
      return item;
    });
    this.feedEl.replaceChildren(...(items.length ? items : [el('li', 'empty', 'Сообщений нет: нажмите команду плагина или его сочетание')]));
    this.feedEl.scrollTop = this.feedEl.scrollHeight;
  }

  private showJournal(pluginId: string | null): void {
    this.focus = pluginId;
    this.renderJournal();
    this.journalEl.scrollIntoView({ block: 'nearest' });
  }

  private renderJournal(): void {
    const lines = journalFor(this.snapshot?.journal ?? [], this.focus);
    this.journalTitle.textContent = this.focus === null ? 'Журнал' : `Журнал: ${this.focus}`;
    this.journalAll.hidden = this.focus === null;
    const items = lines.map((line) => {
      const item = el('li', `log-line level-${line.level}`);
      item.append(el('time', 'log-time', clock(line.at)), el('span', 'log-subject', line.subject), el('span', 'log-text', line.text));
      return item;
    });
    this.journalEl.replaceChildren(...(items.length ? items : [el('li', 'empty', 'Записей нет')]));
    this.journalEl.scrollTop = this.journalEl.scrollHeight;
  }
}
