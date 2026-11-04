// Окно «Плагины Cyborg» (SAD2 §3.2, §3.5): состояние плагинов, заглушка выключенного с причиной и «Включить снова», журнал ядра.

import type { PluginRow, PluginsSnapshot } from '../shared/plugins.ts';
import { byId, el } from './dom.ts';
import { clock, journalFor, sortedPlugins, STATE_LABEL, summary } from './plugins-model.ts';

export interface PluginsPort {
  pluginsSnapshot(): Promise<PluginsSnapshot>;
  revivePlugin(id: string): Promise<{ error?: string }>;
  onPluginsChanged(listener: () => void): void;
}

export class PluginsPanel {
  private readonly summaryEl = byId('plugins-summary');
  private readonly problemsEl = byId('plugins-problems');
  private readonly listEl = byId('plugins-list');
  private readonly journalTitle = byId('plugins-journal-title');
  private readonly journalAll = byId<HTMLButtonElement>('plugins-journal-all');
  private readonly journalEl = byId('plugins-journal');
  private snapshot: PluginsSnapshot | null = null;
  private focus: string | null = null;
  private readonly errors = new Map<string, string>();
  private readonly reviving = new Set<string>();
  private loading = false;
  private again = false;
  private readonly port: PluginsPort;

  constructor(port: PluginsPort) {
    this.port = port;
    this.journalAll.addEventListener('click', () => this.showJournal(null));
    port.onPluginsChanged(() => void this.refresh());
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
      } while (this.again);
    } finally {
      this.loading = false;
    }
  }

  private render(): void {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    this.summaryEl.textContent = summary(snapshot);
    this.problemsEl.textContent = snapshot.problems.length ? `Не дошло до ядра:\n${snapshot.problems.join('\n')}` : '';
    this.problemsEl.hidden = snapshot.problems.length === 0;
    this.listEl.replaceChildren(...sortedPlugins(snapshot.plugins).map((row) => this.row(row)));
    this.renderJournal();
  }

  private row(row: PluginRow): HTMLElement {
    const item = el('li', 'plugin-row');
    item.dataset.state = row.state;
    item.dataset.plugin = row.id;
    const head = el('div', 'plugin-head');
    head.append(el('span', 'plugin-name', row.id));
    if (row.version) head.append(el('span', 'plugin-version', row.version));
    if (row.host) head.append(el('span', 'plugin-host', `хост ${row.host}`));
    head.append(el('span', 'spacer'));
    if (row.state === 'active') head.append(this.actions(row));
    head.append(el('span', 'plugin-state', STATE_LABEL[row.state]));
    item.append(head);
    if (row.state === 'active') return item;
    // Заглушка на месте плагина: имя, причина из журнала, «Включить снова» и «Журнал» (SAD2 §3.5).
    const stub = el('div', 'plugin-stub');
    if (row.reason) stub.append(el('p', 'plugin-reason', row.reason));
    const error = this.errors.get(row.id);
    if (error) {
      const line = el('p', 'plugin-error', error);
      line.setAttribute('role', 'alert');
      stub.append(line);
    }
    stub.append(this.actions(row));
    item.append(stub);
    return item;
  }

  private actions(row: PluginRow): HTMLElement {
    const bar = el('div', 'plugin-actions');
    if (row.revivable) {
      const busy = this.reviving.has(row.id);
      const revive = el('button', 'primary', busy ? 'Включаю…' : 'Включить снова') as HTMLButtonElement;
      revive.type = 'button';
      revive.disabled = busy;
      revive.addEventListener('click', () => void this.revive(row.id));
      bar.append(revive);
    }
    const journal = el('button', '', 'Журнал') as HTMLButtonElement;
    journal.type = 'button';
    journal.setAttribute('aria-label', `Журнал ${row.id}`);
    journal.addEventListener('click', () => this.showJournal(row.id));
    bar.append(journal);
    return bar;
  }

  private async revive(id: string): Promise<void> {
    this.reviving.add(id);
    this.errors.delete(id);
    this.render();
    try {
      const reply = await this.port.revivePlugin(id);
      if (reply.error) this.errors.set(id, reply.error);
    } catch (error) {
      this.errors.set(id, (error as Error).message);
    } finally {
      this.reviving.delete(id);
    }
    await this.refresh();
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
      const item = el('li', `plugin-journal-line level-${line.level}`);
      item.append(el('time', 'plugin-journal-time', clock(line.at)), el('span', 'plugin-journal-subject', line.subject), el('span', 'plugin-journal-text', line.text));
      return item;
    });
    this.journalEl.replaceChildren(...(items.length ? items : [el('li', 'plugin-journal-empty', 'Записей нет')]));
    this.journalEl.scrollTop = this.journalEl.scrollHeight;
  }
}
