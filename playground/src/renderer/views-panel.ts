// Виды плагинов во фреймах (SAD §3.8): фрейм живёт, пока плагин включён и не снят, и переживает перезапуск хоста.
// Область вида и порядок задаёт раскладка ядра (`Kernel.layout`); окно только раскладывает виды по своим областям.

import type { Area } from '@cyborg-harness/core/window';
import type { PluginRow } from '@cyborg-harness/electron/window';
import { el } from './dom.ts';
import { viewMode, type ViewSlot } from './plugins-model.ts';
import type { SidePage } from './side-tabs.ts';
import type { WindowPlan } from './window-plan.ts';

export interface ViewsPort {
  setViewVisible(id: string, view: string, visible: boolean): Promise<void>;
  /** Кнопки заглушки снятого плагина - те же, что в его строке списка. */
  actions(row: PluginRow): HTMLElement[];
}

interface Box {
  readonly figure: HTMLElement;
  /** Где стоит вид: область окна или своя вкладка боковой колонки (`sidebar:tab`). */
  readonly place: string;
  readonly live: boolean;
  readonly update: (slot: ViewSlot) => void;
}

/** Куда окно кладёт виды каждой области; боковая колонка - общая сетка вкладки «Виды», остальные - свои места окна. У модального окна места в странице нет: его показывает слой окна (`WindowLayerView`) по просьбе главной части. */
export type AreaRoots = Readonly<Record<Exclude<Area, 'modal'>, HTMLElement>>;

/** Вкладки боковой колонки: окно отдаёт корень панели для каждого вида с подписью. */
export interface SidePages {
  syncPages(pages: readonly SidePage[]): ReadonlyMap<string, HTMLElement>;
}

export class ViewsPanel {
  private readonly boxes = new Map<string, Box>();
  private readonly roots: AreaRoots;
  private readonly empty: HTMLElement;
  private readonly port: ViewsPort;
  private readonly pages: SidePages;

  constructor(roots: AreaRoots, port: ViewsPort, pages: SidePages) {
    this.roots = roots;
    this.port = port;
    this.pages = pages;
    this.empty = el('p', 'empty', 'Включённых плагинов с видом нет');
    roots.sidebar.append(this.empty);
  }

  /**
   * Виды по плану окна. Порядок внутри области - `order` ядра: новый вид встаёт на своё место, существующие не двигаются
   * (перенос `<iframe>` в DOM перезагружает документ), а перестановка идёт стилем `order` и номером `data-slot` обёртки.
   */
  sync(plan: WindowPlan): void {
    const roots = this.pages.syncPages(plan.sideTabs.map((slot) => ({ key: slot.key, title: slot.entry.title ?? slot.row.id })));
    const wanted = new Map<string, { slot: ViewSlot; place: string; root: HTMLElement; index: number }>();
    const put = (list: readonly ViewSlot[], place: string, rootOf: (slot: ViewSlot) => HTMLElement | undefined) => {
      list.forEach((slot, index) => {
        const root = rootOf(slot);
        if (root) wanted.set(slot.key, { slot, place, root, index });
      });
    };
    put(plan.toolbar, 'toolbar', () => this.roots.toolbar);
    put(plan.main, 'main', () => this.roots.main);
    put(plan.popup, 'popup', () => this.roots.popup);
    put(plan.sidebar, 'sidebar', () => this.roots.sidebar);
    put(plan.sideTabs, 'sidebar:tab', (slot) => roots.get(slot.key));
    for (const [key, box] of this.boxes) {
      const next = wanted.get(key);
      if (next?.place === box.place && (next.slot.mode !== 'placeholder') === box.live) continue;
      box.figure.remove();
      this.boxes.delete(key);
    }
    const previous = new Map<HTMLElement, HTMLElement>();
    for (const [key, { slot, place, root, index }] of wanted) {
      let box = this.boxes.get(key);
      if (!box) {
        box = slot.mode === 'placeholder' ? this.placeholder(slot, place) : this.frame(slot, place);
        this.boxes.set(key, box);
        const before = previous.get(root);
        if (before) before.after(box.figure);
        else root.prepend(box.figure);
      }
      box.figure.style.order = String(index);
      box.figure.dataset.slot = String(index);
      box.update(slot);
      previous.set(root, box.figure);
    }
    this.empty.hidden = plan.sidebar.length > 0 || plan.sideTabs.length > 0;
  }

  private frame({ row, entry }: ViewSlot, place: string): Box {
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
      place,
      live: true,
      update: (next) => {
        const restarting = viewMode(next.row, next.entry) === 'restarting';
        figure.dataset.state = next.row.state;
        plaque.hidden = !restarting;
        frame.inert = restarting;
      },
    };
  }

  private placeholder({ row, entry }: ViewSlot, place: string): Box {
    const figure = el('figure', 'view view-placeholder');
    figure.dataset.plugin = row.id;
    figure.dataset.view = entry.name;
    figure.dataset.area = entry.area;
    const reason = el('p', 'view-reason');
    const actions = el('div', 'view-actions');
    figure.append(el('figcaption', 'view-caption', entry.title ?? row.id), reason, actions);
    return {
      figure,
      place,
      live: false,
      update: (next) => {
        figure.dataset.state = next.row.state;
        reason.textContent = next.row.reason ?? 'Плагин снят';
        actions.replaceChildren(...this.port.actions(next.row));
      },
    };
  }
}
