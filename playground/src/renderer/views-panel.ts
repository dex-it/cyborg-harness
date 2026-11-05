// Виды плагинов во фреймах (SAD2 §3.8): фрейм живёт, пока плагин включён и не снят, и переживает перезапуск хоста.

import type { PluginRow } from '../shared/plugins.ts';
import { el } from './dom.ts';

export interface ViewsPort {
  setViewVisible(id: string, visible: boolean): Promise<void>;
  /** Кнопки заглушки снятого плагина - те же, что в его строке списка. */
  actions(row: PluginRow): HTMLElement[];
}

interface Box {
  readonly figure: HTMLElement;
  readonly live: boolean;
  readonly update: (row: PluginRow) => void;
}

/** Что показать на месте вида: фрейм, фрейм под плашкой или заглушку. */
export function viewMode(row: PluginRow): 'frame' | 'restarting' | 'placeholder' | undefined {
  if (row.view === undefined) return undefined;
  if (row.state === 'stopped') return 'placeholder';
  return row.state === 'restarting' ? 'restarting' : 'frame';
}

export class ViewsPanel {
  private readonly boxes = new Map<string, Box>();
  private readonly root: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly port: ViewsPort;

  constructor(root: HTMLElement, port: ViewsPort) {
    this.root = root;
    this.port = port;
    this.empty = el('p', 'empty', 'Включённых плагинов с видом нет');
    root.append(this.empty);
  }

  sync(plugins: readonly PluginRow[]): void {
    const wanted = new Map(plugins.flatMap((p) => (viewMode(p) === undefined ? [] : [[p.id, p] as const])));
    for (const [id, box] of this.boxes) {
      const row = wanted.get(id);
      if (row && (viewMode(row) !== 'placeholder') === box.live) continue;
      box.figure.remove();
      this.boxes.delete(id);
    }
    // Перенос <iframe> в DOM перезагружает его документ: новый вид встаёт на своё место, старые не двигаются.
    let previous: HTMLElement | undefined;
    for (const [id, row] of wanted) {
      let box = this.boxes.get(id);
      if (!box) {
        box = viewMode(row) === 'placeholder' ? this.placeholder(row) : this.frame(row);
        this.boxes.set(id, box);
        if (previous) previous.after(box.figure);
        else this.root.prepend(box.figure);
      }
      box.update(row);
      previous = box.figure;
    }
    this.empty.hidden = this.boxes.size > 0;
  }

  private frame(row: PluginRow): Box {
    const figure = el('figure', 'view');
    figure.dataset.plugin = row.id;
    const toggle = el('button', 'view-toggle', 'Свернуть') as HTMLButtonElement;
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'true');
    const caption = el('figcaption', 'view-caption');
    caption.append(el('span', 'view-origin', row.view ?? ''), toggle);
    const body = el('div', 'view-body');
    const frame = document.createElement('iframe');
    frame.src = row.view ?? '';
    frame.title = `Вид ${row.id}`;
    const plaque = el('div', 'view-plaque', 'Перезапуск…');
    plaque.setAttribute('role', 'status');
    body.append(frame, plaque);
    figure.append(caption, body);
    toggle.addEventListener('click', () => {
      // Свёрнутый вид остаётся в DOM: display:none у обёртки, а не снятие фрейма - так документ плагина не теряет состояние.
      const visible = body.hidden === true;
      body.hidden = !visible;
      toggle.textContent = visible ? 'Свернуть' : 'Развернуть';
      toggle.setAttribute('aria-expanded', String(visible));
      void this.port.setViewVisible(row.id, visible);
    });
    return {
      figure,
      live: true,
      update: (next) => {
        const restarting = viewMode(next) === 'restarting';
        figure.dataset.state = next.state;
        plaque.hidden = !restarting;
        frame.inert = restarting;
      },
    };
  }

  private placeholder(row: PluginRow): Box {
    const figure = el('figure', 'view view-placeholder');
    figure.dataset.plugin = row.id;
    const reason = el('p', 'view-reason');
    const actions = el('div', 'view-actions');
    figure.append(el('figcaption', 'view-caption', row.id), reason, actions);
    return {
      figure,
      live: false,
      update: (next) => {
        figure.dataset.state = next.state;
        reason.textContent = next.reason ?? 'Плагин снят';
        actions.replaceChildren(...this.port.actions(next));
      },
    };
  }
}
