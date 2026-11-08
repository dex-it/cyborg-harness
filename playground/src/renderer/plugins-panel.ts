// Окно playground: плагины с кнопками над ядром, сочетания клавиш, лента сообщений плагинов и журнал ядра (SAD §3.2, §3.5).

import { keyOfInput } from '@cyborg-harness/core/keys';
import type { FeedLine, KeptPtyRow, KeyRow, PluginRow, PluginsSnapshot, Reply } from '../shared/plugins.ts';
import type { DisablePreview } from '@cyborg-harness/core/window';
import { byId, el } from './dom.ts';
import { ViewsPanel } from './views-panel.ts';
import { moveFocus } from './focus.ts';
import { SideTabs } from './side-tabs.ts';
import { WindowLayerView } from './window-layer.ts';
import { actionsFor, clock, conflictText, journalFor, keyStatus, mergeFeed, sortedPlugins, STATE_LABEL, summary, type ActionButton } from './plugins-model.ts';

export interface PluginsPort {
  pluginsSnapshot(): Promise<PluginsSnapshot>;
  enablePlugin(id: string): Promise<Reply>;
  disablePlugin(id: string, keepPty?: boolean): Promise<Reply>;
  disablePreview(id: string): Promise<Reply>;
  endKeptPty(id: string): Promise<Reply>;
  crashHost(id: string): Promise<Reply>;
  hangHost(id: string): Promise<Reply>;
  runCommand(command: string): Promise<Reply>;
  onPluginsChanged(listener: () => void): void;
  setViewVisible(id: string, visible: boolean): Promise<void>;
  answerDialog(id: number, choice: string | undefined): Promise<Reply>;
  closeDocument(id: string): Promise<Reply>;
  /** Без файла - системный диалог выбора; смена воркспейса перезапускает приложение. */
  openWorkspace(file?: string): Promise<Reply>;
  /** Перезапуск приложения с флагом `--safe-mode` или без него. */
  setSafeMode(on: boolean): Promise<Reply>;
  onWindowCommand(listener: (command: string) => void): void;
}

const LOCAL_LIMIT = 50;

export class PluginsPanel {
  private readonly summaryEl = byId('plugins-summary', HTMLElement);
  private readonly problemsEl = byId('plugins-problems', HTMLElement);
  private readonly listEl = byId('plugins-list', HTMLElement);
  private readonly keysEl = byId('keys-list', HTMLElement);
  private readonly documentsEl = byId('documents-list', HTMLElement);
  private readonly workspaceEl = byId('workspace-current', HTMLElement);
  private readonly recentEl = byId('workspace-recent', HTMLElement);
  private readonly safeModeEl = byId('safe-mode', HTMLElement);
  private readonly safeModeEnter = byId('safe-mode-enter', HTMLButtonElement);
  private readonly feedEl = byId('feed', HTMLElement);
  private readonly journalTitle = byId('plugins-journal-title', HTMLElement);
  private readonly journalAll = byId('plugins-journal-all', HTMLButtonElement);
  private readonly journalEl = byId('plugins-journal', HTMLElement);
  private readonly views: ViewsPanel;
  private readonly tabs = new SideTabs(byId('side-tabs', HTMLElement));
  private snapshot: PluginsSnapshot | null = null;
  private focus: string | null = null;
  private readonly errors = new Map<string, string>();
  private readonly busy = new Set<string>();
  /** Нажатия, которые ядро не забрало: о них знает только страница. */
  private readonly local: FeedLine[] = [];
  private loading = false;
  private again = false;
  private readonly port: PluginsPort;
  private readonly layer: WindowLayerView;

  constructor(port: PluginsPort) {
    this.port = port;
    this.layer = new WindowLayerView(port, byId('playground', HTMLElement), byId('lock-layer', HTMLElement));
    this.views = new ViewsPanel(byId('views', HTMLElement), {
      setViewVisible: (id, visible) => port.setViewVisible(id, visible),
      actions: (row) => actionsFor(row, false).filter((b) => b.action === 'enable' || b.action === 'journal').map((b) => this.button(row.id, b)),
    }, { id: 'sessions', root: byId('main-view', HTMLElement) });
    this.journalAll.addEventListener('click', () => this.showJournal(null));
    byId('workspace-open', HTMLButtonElement).addEventListener('click', () => void port.openWorkspace());
    this.safeModeEnter.addEventListener('click', () => void port.setSafeMode(true));
    byId('safe-mode-exit', HTMLButtonElement).addEventListener('click', () => void port.setSafeMode(false));
    port.onPluginsChanged(() => void this.refresh());
    port.onWindowCommand((command) => {
      if (command === 'cyborg.window.focus-next') moveFocus(1);
      if (command === 'cyborg.window.focus-prev') moveFocus(-1);
    });
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
    this.safeModeEl.hidden = !snapshot.safeMode;
    this.safeModeEnter.hidden = snapshot.safeMode || snapshot.phase === 'no-workspace';
    this.listEl.replaceChildren(...sortedPlugins(snapshot.plugins).map((row) => this.row(row, snapshot.canHang)));
    this.keysEl.replaceChildren(...(snapshot.keys.length ? snapshot.keys.map((row) => this.keyRow(row)) : [this.emptyKeys()]));
    const { current, recent } = snapshot.workspace;
    this.workspaceEl.textContent = current === null ? 'Воркспейс не открыт' : `Воркспейс: ${current}`;
    this.recentEl.replaceChildren(...recent.map((file) => this.recentRow(file)));
    this.documentsEl.replaceChildren(...(snapshot.documents.length ? snapshot.documents.map((row) => this.documentRow(row)) : [el('li', 'empty', 'Документов нет')]));
    this.renderFeed();
    this.renderJournal();
    this.views.sync(snapshot.plugins);
    this.layer.sync(snapshot.window, snapshot.plugins);
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
    if (row.permissions.length > 0) {
      const list = el('ul', 'plugin-permissions');
      list.setAttribute('aria-label', `Права ${row.id}`);
      list.append(...row.permissions.map((p) => el('li', '', p)));
      item.append(list);
    }
    if (row.kept) item.append(this.keptList(row.id, row.kept));
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

  /** SAD 3.6: оставленный процесс ждёт без срока, поэтому человек видит его и может завершить сам. */
  private keptList(pluginId: string, kept: readonly KeptPtyRow[]): HTMLElement {
    const box = el('div', 'plugin-kept');
    box.append(el('p', '', 'Оставлены работать до возвращения плагина:'));
    const list = el('ul', 'pty-list');
    list.setAttribute('aria-label', `Оставленные процессы ${pluginId}`);
    for (const p of kept) {
      const item = el('li', 'kept-row');
      item.dataset.pty = p.id;
      const state = p.exitCode === undefined ? `pid ${String(p.pid)}, с ${clock(p.keptAt)}` : `завершился, код ${String(p.exitCode)}`;
      const end = el('button', '', p.exitCode === undefined ? 'Завершить' : 'Убрать') as HTMLButtonElement;
      end.type = 'button';
      end.setAttribute('aria-label', `${end.textContent} ${p.command} (${pluginId})`);
      end.disabled = this.busy.has(pluginId);
      end.addEventListener('click', () => void this.endKept(pluginId, p.id));
      item.append(el('span', '', `${p.command} - ${state} `), end);
      list.append(item);
    }
    box.append(list);
    return box;
  }

  private async endKept(pluginId: string, id: string): Promise<void> {
    this.busy.add(pluginId);
    this.errors.delete(pluginId);
    this.render();
    try {
      const reply = await this.port.endKeptPty(id);
      if (reply.error) this.errors.set(pluginId, reply.error);
    } finally {
      this.busy.delete(pluginId);
    }
    await this.refresh();
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
      disable: () => this.disable(id),
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

  /** SAD 3.6: выключение не завершает процессы в терминале молча - человек решает, оставить их или завершить. */
  private async disable(id: string): Promise<Reply> {
    const preview = await this.port.disablePreview(id);
    if (preview.error !== undefined) return preview;
    const { plugins, ptys } = preview.value as DisablePreview;
    if (ptys.length === 0) return this.port.disablePlugin(id);
    const choice = await askPty(id, plugins, ptys);
    return choice === 'cancel' ? {} : this.port.disablePlugin(id, choice === 'keep');
  }

  private recentRow(file: string): HTMLElement {
    const item = el('li');
    const open = el('button', 'workspace-recent-item', file.split(/[\\/]/).at(-1) ?? file) as HTMLButtonElement;
    open.type = 'button';
    open.title = file;
    open.setAttribute('aria-label', `Открыть воркспейс ${file}`);
    open.addEventListener('click', () => void this.port.openWorkspace(file));
    item.append(open);
    return item;
  }

  private documentRow(row: PluginsSnapshot['documents'][number]): HTMLElement {
    const item = el('li', 'document-row');
    item.dataset.document = row.id;
    item.dataset.available = String(row.available);
    item.append(el('span', 'document-title', row.title), el('span', 'document-owner', `${row.pluginId} · ${row.type}`));
    if (!row.available) item.append(el('span', 'document-off', 'недоступен: владелец не работает'));
    const close = el('button', '', 'Закрыть') as HTMLButtonElement;
    close.type = 'button';
    close.setAttribute('aria-label', `Закрыть ${row.title}`);
    close.addEventListener('click', () => void this.port.closeDocument(row.id).then(() => this.refresh()));
    item.append(close);
    return item;
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
    this.tabs.reveal(this.journalEl);
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

/** Модальный вопрос в окне, а не нативный: его видят и клавиатура окна, и дымовой тест. */
function askPty(id: string, plugins: readonly string[], ptys: DisablePreview['ptys']): Promise<'kill' | 'keep' | 'cancel'> {
  const dialog = el('dialog', 'pty-dialog') as HTMLDialogElement;
  dialog.setAttribute('aria-labelledby', 'pty-dialog-title');
  const title = el('h3', '', `Выключить ${id}?`);
  title.id = 'pty-dialog-title';
  const others = plugins.filter((p) => p !== id);
  const list = el('ul', 'pty-list');
  for (const p of ptys) list.append(el('li', '', `${[p.program, ...p.args].join(' ')} - pid ${String(p.pid)}${p.pluginId === id ? '' : `, плагин ${p.pluginId}`}`));
  const lead = others.length > 0 ? `Вместе с ним выгружаются ${others.join(', ')}. В терминале работают процессы:` : 'В терминале работают процессы:';
  const buttons = el('div', 'pty-actions');
  const button = (value: string, text: string) => {
    const b = el('button', '', text) as HTMLButtonElement;
    b.type = 'button';
    b.dataset.choice = value;
    b.addEventListener('click', () => dialog.close(value));
    return b;
  };
  const keep = button('keep', 'Оставить работать');
  buttons.append(button('kill', 'Завершить'), keep, button('cancel', 'Отмена'));
  dialog.append(title, el('p', '', lead), list, el('p', 'pty-hint', 'Оставленные процессы дождутся, пока плагин включат снова; при выходе из Cyborg они завершатся.'), buttons);
  document.body.append(dialog);
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => {
      dialog.remove();
      const v = dialog.returnValue;
      resolve(v === 'kill' || v === 'keep' ? v : 'cancel');
    });
    dialog.showModal();
    keep.focus();
  });
}
