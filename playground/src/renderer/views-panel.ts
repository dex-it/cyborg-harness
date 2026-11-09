// Виды плагинов во фреймах (SAD §3.8): фрейм живёт, пока плагин включён и не снят, и переживает перезапуск хоста.
// Область вида и порядок задаёт раскладка ядра (`Kernel.layout`); окно только раскладывает виды по своим областям.

import type { Area } from '@cyborg-harness/core/window';
import type { PluginRow } from '@cyborg-harness/electron/window';
import { el } from './dom.ts';
import { viewMode, type ViewSlot } from './plugins-model.ts';

export interface ViewsPort {
  setViewVisible(id: string, view: string, visible: boolean): Promise<void>;
  /** Кнопки заглушки снятого плагина - те же, что в его строке списка. */
  actions(row: PluginRow): HTMLElement[];
}

interface Box {
  readonly figure: HTMLElement;
  readonly area: Area;
  readonly live: boolean;
  readonly update: (slot: ViewSlot) => void;
}

/** Куда окно кладёт виды каждой области; боковая колонка - общая сетка вкладки «Виды», остальные - свои места окна. */
export type AreaRoots = Readonly<Record<Area, HTMLElement>>;

export class ViewsPanel {
  private readonly boxes = new Map<string, Box>();
  private readonly roots: AreaRoots;
  private readonly empty: HTMLElement;
  private readonly port: ViewsPort;

  constructor(roots: AreaRoots, port: ViewsPort) {
    this.roots = roots;
    this.port = port;
    this.empty = el('p', 'empty', 'Включённых плагинов с видом нет');
    roots.sidebar.append(this.empty);
  }

  sync(slots: readonly ViewSlot[]): void {
    const wanted = new Map(slots.map((slot) => [slot.key, slot]));
    for (const [key, box] of this.boxes) {
      const slot = wanted.get(key);
      if (slot?.entry.area === box.area && (slot.mode !== 'placeholder') === box.live) continue;
      box.figure.remove();
      this.boxes.delete(key);
    }
    // Перенос <iframe> в DOM перезагружает его документ: новый вид встаёт на своё место, старые не двигаются.
    const previous = new Map<Area, HTMLElement>();
    for (const [key, slot] of wanted) {
      const area = slot.entry.area;
      let box = this.boxes.get(key);
      if (!box) {
        box = slot.mode === 'placeholder' ? this.placeholder(slot) : this.frame(slot);
        this.boxes.set(key, box);
        const before = previous.get(area);
        if (before) before.after(box.figure);
        else this.roots[area].prepend(box.figure);
      }
      box.update(slot);
      previous.set(area, box.figure);
    }
    this.empty.hidden = [...this.boxes.values()].some((box) => box.area === 'sidebar');
  }

  private frame({ row, entry }: ViewSlot): Box {
    const figure = el('figure', 'view');
    figure.dataset.plugin = row.id;
    figure.dataset.view = entry.name;
    figure.dataset.area = entry.area;
    const toggle = el('button', 'view-toggle', 'Свернуть') as HTMLButtonElement;
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'true');
    const caption = el('figcaption', 'view-caption');
    if (entry.title !== undefined) caption.append(el('strong', 'view-title', entry.title));
    caption.append(el('span', 'view-origin', entry.url ?? ''), toggle);
    const body = el('div', 'view-body');
    const frame = document.createElement('iframe');
    frame.src = entry.url ?? '';
    frame.title = `Вид ${row.id}/${entry.name}`;
    const plaque = el('div', 'view-plaque', 'Перезапуск…');
    plaque.setAttribute('role', 'status');
    body.append(frame, plaque);
    figure.append(caption, body);
    // Новый фрейм показан развёрнутым: без этого ядро считает вид скрытым, и сочетания с `when.visible` молчат до первого «Свернуть»/«Развернуть».
    void this.port.setViewVisible(row.id, entry.name, true);
    toggle.addEventListener('click', () => {
      // Свёрнутый вид остаётся в DOM: display:none у обёртки, а не снятие фрейма - так документ плагина не теряет состояние.
      const visible = body.hidden === true;
      body.hidden = !visible;
      toggle.textContent = visible ? 'Свернуть' : 'Развернуть';
      toggle.setAttribute('aria-expanded', String(visible));
      void this.port.setViewVisible(row.id, entry.name, visible);
    });
    return {
      figure,
      area: entry.area,
      live: true,
      update: (next) => {
        const restarting = viewMode(next.row, next.entry) === 'restarting';
        figure.dataset.state = next.row.state;
        plaque.hidden = !restarting;
        frame.inert = restarting;
      },
    };
  }

  private placeholder({ row, entry }: ViewSlot): Box {
    const figure = el('figure', 'view view-placeholder');
    figure.dataset.plugin = row.id;
    figure.dataset.view = entry.name;
    figure.dataset.area = entry.area;
    const reason = el('p', 'view-reason');
    const actions = el('div', 'view-actions');
    figure.append(el('figcaption', 'view-caption', entry.title ?? row.id), reason, actions);
    return {
      figure,
      area: entry.area,
      live: false,
      update: (next) => {
        figure.dataset.state = next.row.state;
        reason.textContent = next.row.reason ?? 'Плагин снят';
        actions.replaceChildren(...this.port.actions(next.row));
      },
    };
  }
}
