// Слой окна (SAD §3.8): диалоги видов и модальные окна плагинов поверх всех фреймов и замок окна. Состояние держит ядро, рисует приложение.

import type { DialogChoice, DialogSpec, ModalInit, ModalSize } from '@cyborg-harness/contracts';
import { CoreError } from './errors.ts';
import { isRecord } from './wire.ts';

/** Владелец команд окна в таблице сочетаний: команды исполняет приложение, а не плагин. */
export const WINDOW_OWNER = 'cyborg.window';

/** Владелец акселераторов меню приложения в таблице сочетаний: нажатие обрабатывает меню ОС, ядро его не перехватывает. */
export const MENU_OWNER = 'cyborg.menu';

/** Переход между областями окна; сочетание ловится до страницы, поэтому выводит и из фрейма, который забирает Tab себе (терминал). */
export const WINDOW_COMMANDS: Readonly<Record<string, string>> = {
  'cyborg.window.focus-next': 'F6',
  'cyborg.window.focus-prev': 'Shift+F6',
};

/** Владелец команд ядра в таблице клавиш: сочетание пользователя на них работает, как на команду плагина. */
export const KERNEL_OWNER = 'cyborg.kernel';

/** Команды, которые исполняет само ядро: им нужна среда, закрытая плагинам. Зовёт их приложение, не плагин. */
export const KERNEL_COMMANDS = {
  /** Показать файл воркспейса в файловом менеджере: сам файл плагинам закрыт как защищённый путь. */
  revealWorkspace: 'cyborg.workspace.reveal',
} as const;

const MAX_PENDING = 8;
const MAX_CHOICES = 12;
const MAX_LABEL = 80;
const MAX_TITLE = 200;
const MAX_MESSAGE = 4000;
const MAX_SEGMENT = 80;
// Перевод строки, табуляция и невидимые знаки направления текста ломают строку заголовка в панели задач.
const INVISIBLE = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

/** Диалог, который приложение показывает сейчас; `at` у меню - в координатах фрейма вида. */
export interface ShownDialog {
  readonly id: number;
  readonly pluginId: string;
  readonly view: string;
  readonly spec: DialogSpec;
}

/** Модальное окно плагина на экране (K-13): вид `view` с `area: "modal"`; данные владельца в снимок не идут, их забирает сам вид (`Kernel.modalFor`). */
export interface ShownModal {
  readonly id: number;
  readonly pluginId: string;
  readonly view: string;
  readonly title: string;
  /** Размер, который попросил автор; чего нет, то решает приложение. */
  readonly size?: ModalSize;
  /** `"view"` - Escape принадлежит виду окна; поля нет - Escape закрывает окно. */
  readonly escape?: 'view';
  /** Высота области вида (без шапки окна), о которой попросил сам вид (`ctx.modal.resize`); заменяет `size.height`. Пока вид не просил - поля нет. */
  readonly contentHeight?: number;
}

export interface WindowLock {
  readonly pluginId: string;
  readonly hideNotifications: boolean;
}

/** Края заголовка окна вокруг фрагментов плагинов. */
export interface WindowTitle {
  readonly workspace?: string | undefined;
  readonly app: string;
}

export interface WindowSnapshot {
  readonly dialog?: ShownDialog;
  /** Модальное окно под диалогом: диалог из его вида встаёт поверх, а не ждёт закрытия окна. */
  readonly modal?: ShownModal;
  /** Заголовок окна: воркспейс, фрагменты плагинов по их id, приложение - через « - ». */
  readonly title: string;
  /** Ждут своей очереди, включая отложенные замком. */
  readonly queued: number;
  readonly locks: readonly WindowLock[];
}

interface Pending extends ShownDialog {
  readonly resolve: (choice: string | undefined) => void;
}

interface PendingModal extends ShownModal {
  readonly data: unknown;
  readonly resolve: (result: unknown) => void;
}

function text(field: string, raw: unknown, max: number, optional = false): string | undefined {
  if (raw === undefined && optional) return undefined;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > max) throw new CoreError('Invalid', `диалог: ${field} - строка от 1 до ${String(max)} символов`);
  return raw;
}

function choices(field: string, raw: unknown): DialogChoice[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_CHOICES) throw new CoreError('Invalid', `диалог: ${field} - список от 1 до ${String(MAX_CHOICES)} пунктов`);
  const out = raw.map((item, i): DialogChoice => {
    if (!isRecord(item)) throw new CoreError('Invalid', `диалог: ${field}[${String(i)}] - { id, label }`);
    return { id: text(`${field}[${String(i)}].id`, item.id, MAX_LABEL) ?? '', label: text(`${field}[${String(i)}].label`, item.label, MAX_LABEL) ?? '' };
  });
  if (new Set(out.map((c) => c.id)).size !== out.length) throw new CoreError('Invalid', `диалог: id в ${field} повторяются`);
  return out;
}

/** Описание от вида - недоверенные данные: в окно уходит только разобранная копия. */
/** Плагин с таким id мог бы объявить команду окна в своём пространстве имён. */
export function reservedId(id: string): boolean {
  return [...Object.keys(WINDOW_COMMANDS), ...Object.values(KERNEL_COMMANDS)].some((c) => c.startsWith(`${id}.`));
}

export function parseDialog(raw: unknown): DialogSpec {
  if (!isRecord(raw)) throw new CoreError('Invalid', 'диалог: ожидается { kind: "ask" | "menu", ... }');
  if (raw.kind === 'ask') {
    const message = text('message', raw.message, MAX_MESSAGE, true);
    return { kind: 'ask', title: text('title', raw.title, MAX_TITLE) ?? '', ...(message !== undefined && { message }), buttons: choices('buttons', raw.buttons) };
  }
  if (raw.kind === 'menu') {
    const at = raw.at;
    if (!isRecord(at) || !Number.isFinite(at.x) || !Number.isFinite(at.y)) throw new CoreError('Invalid', 'диалог: menu.at - { x, y } в координатах вида');
    return { kind: 'menu', items: choices('items', raw.items), at: { x: at.x as number, y: at.y as number } };
  }
  throw new CoreError('Invalid', `диалог: вид ${JSON.stringify(raw.kind)} не известен, есть ask и menu`);
}

/** Очередь диалогов: один на окно, по порядку; под замком чужие ждут, свои у владельца замка идут первыми. */
export class WindowLayer {
  readonly #changed: (snapshot: WindowSnapshot) => void;
  readonly #queue: Pending[] = [];
  readonly #modals: PendingModal[] = [];
  readonly #locks = new Map<string, WindowLock>();
  readonly #titles = new Map<string, string>();
  readonly #frame: WindowTitle;
  #shown: Pending | undefined;
  #modal: PendingModal | undefined;
  #seq = 0;

  constructor(changed: (snapshot: WindowSnapshot) => void, frame: WindowTitle = { app: 'Cyborg' }) {
    this.#changed = changed;
    this.#frame = frame;
  }

  /** Под замком в заголовке только фрагменты владельцев замка, с `hideNotifications` - и без имени воркспейса: заголовок виден в панели задач и на экране замка. */
  get title(): string {
    const segments = [...this.#titles].filter(([id]) => this.allows(id)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return [this.hideNotifications ? undefined : this.#frame.workspace, ...segments.map(([, s]) => s), this.#frame.app].filter((s) => s !== undefined && s !== '').join(' - ');
  }

  /** `undefined` или пустая после чистки строка снимает фрагмент. */
  setTitle(pluginId: string, raw: unknown): void {
    if (raw !== undefined && typeof raw !== 'string') throw new CoreError('Invalid', 'window.setTitle: фрагмент - строка или undefined');
    const segment = raw?.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
    if (segment !== undefined && segment.length > MAX_SEGMENT) throw new CoreError('Invalid', `window.setTitle: фрагмент длиннее ${String(MAX_SEGMENT)} символов`);
    const before = this.title;
    if (segment) this.#titles.set(pluginId, segment);
    else this.#titles.delete(pluginId);
    if (this.title !== before) this.#changed(this.snapshot);
  }

  get snapshot(): WindowSnapshot {
    const shown = this.#shown;
    const modal = this.#modal;
    return {
      ...(shown && { dialog: { id: shown.id, pluginId: shown.pluginId, view: shown.view, spec: shown.spec } }),
      ...(modal && { modal: { id: modal.id, pluginId: modal.pluginId, view: modal.view, title: modal.title, ...(modal.size && { size: modal.size }), ...(modal.escape && { escape: modal.escape }), ...(modal.contentHeight !== undefined && { contentHeight: modal.contentHeight }) } }),
      title: this.title,
      queued: this.#queue.length + this.#modals.length,
      locks: [...this.#locks.values()],
    };
  }

  get locked(): boolean {
    return this.#locks.size > 0;
  }

  get hideNotifications(): boolean {
    return [...this.#locks.values()].some((l) => l.hideNotifications);
  }

  /** Сочетания и диалоги этого плагина работают сейчас: окно открыто или замок его. */
  allows(pluginId: string): boolean {
    return !this.locked || this.#locks.has(pluginId);
  }

  isOwner(pluginId: string): boolean {
    return this.#locks.has(pluginId);
  }

  /** Ответ - id выбранного пункта; Escape, клик мимо меню или выгрузка плагина - undefined. */
  show(pluginId: string, view: string, raw: unknown): Promise<string | undefined> {
    const spec = parseDialog(raw);
    if ([this.#shown, ...this.#queue].filter((d) => d?.pluginId === pluginId).length >= MAX_PENDING) throw new CoreError('Invalid', `${pluginId}: больше ${String(MAX_PENDING)} диалогов в очереди`);
    return new Promise((resolve) => {
      this.#queue.push({ id: ++this.#seq, pluginId, view, spec, resolve });
      this.#next();
    });
  }

  /** Ответ человека из окна; чужой id или пункт не из диалога - отказ, диалог остаётся. */
  answer(id: number, choice: string | undefined): void {
    const shown = this.#shown;
    if (shown?.id !== id) throw new CoreError('NotFound', `диалога ${String(id)} нет на экране`);
    const ids = shown.spec.kind === 'ask' ? shown.spec.buttons : shown.spec.items;
    if (choice !== undefined && !ids.some((c) => c.id === choice)) throw new CoreError('Invalid', `в диалоге ${String(id)} нет пункта ${JSON.stringify(choice)}`);
    this.#shown = undefined;
    shown.resolve(choice);
    this.#next(true);
  }

  /** Окна идут по одному в порядке просьб; `result` - то, что вид отдал в `closeModal`, а Escape, закрытие окна и выгрузка плагина дают undefined. */
  showModal(pluginId: string, view: string, title: string, data: unknown, options: Pick<ModalInit, 'size' | 'escape'> = {}): { readonly id: number; readonly result: Promise<unknown> } {
    if ([this.#modal, ...this.#modals].filter((m) => m?.pluginId === pluginId).length >= MAX_PENDING) throw new CoreError('Invalid', `${pluginId}: больше ${String(MAX_PENDING)} модальных окон в очереди`);
    const id = ++this.#seq;
    const result = new Promise<unknown>((resolve) => {
      this.#modals.push({ id, pluginId, view, title, data, ...(options.size && { size: options.size }), ...(options.escape === 'view' && { escape: 'view' as const }), resolve });
    });
    this.#next();
    return { id, result };
  }

  /** Данные окна, показанного именно этому виду этого плагина: чужой вид их не получит. */
  modalData(pluginId: string, view: string): { readonly data: unknown } | undefined {
    const modal = this.#modal;
    return modal?.pluginId === pluginId && modal.view === view ? { data: structuredClone(modal.data) } : undefined;
  }

  /** Окно закрывает вид, которому оно показано; чужой плагин, другой вид или окно, которого уже нет, - отказ. */
  closeModal(pluginId: string, view: string, result: unknown): void {
    const modal = this.#modal;
    if (modal?.pluginId !== pluginId || modal.view !== view) throw new CoreError('NotFound', `${pluginId}: модального окна вида ${JSON.stringify(view)} нет на экране`);
    this.#modal = undefined;
    modal.resolve(result);
    this.#next(true);
  }

  /** Вид просит высоту своей области; чужой плагин, другой вид или окно, которого нет на экране, - отказ. Высоту проверяет ядро до слоя (`view-channels.ts`). Та же высота окно не тревожит. */
  resizeModal(pluginId: string, view: string, height: number): void {
    const modal = this.#modal;
    if (modal?.pluginId !== pluginId || modal.view !== view) throw new CoreError('NotFound', `${pluginId}: модального окна вида ${JSON.stringify(view)} нет на экране`);
    if (modal.contentHeight === height) return;
    this.#modal = { ...modal, contentHeight: height };
    this.#changed(this.snapshot);
  }

  /** Человек закрыл окно в самом окне; id не того окна, что на экране, - отказ. */
  cancelModal(id: number): void {
    const modal = this.#modal;
    if (modal?.id !== id) throw new CoreError('NotFound', `модального окна ${String(id)} нет на экране`);
    this.#modal = undefined;
    modal.resolve(undefined);
    this.#next(true);
  }

  /** Escape: закрывает модальное окно, если поверх него нет диалога (Escape тогда принадлежит диалогу) и автор не оставил Escape виду; `false` - закрывать нечего или нажатие не наше. */
  dismissModal(): boolean {
    const modal = this.#modal;
    if (!modal || this.#shown || modal.escape === 'view') return false;
    this.cancelModal(modal.id);
    return true;
  }

  /** Плагин выгружен: его диалоги и окна закрываются с undefined. Замок остаётся - его снимает только владелец. */
  forget(pluginId: string): void {
    const titled = this.#titles.delete(pluginId);
    const gone = this.#queue.filter((d) => d.pluginId === pluginId);
    for (const d of gone) this.#queue.splice(this.#queue.indexOf(d), 1);
    const shown = this.#shown?.pluginId === pluginId ? this.#shown : undefined;
    if (shown) this.#shown = undefined;
    for (const d of [...gone, ...(shown ? [shown] : [])]) d.resolve(undefined);
    const goneModals = this.#modals.filter((m) => m.pluginId === pluginId);
    for (const m of goneModals) this.#modals.splice(this.#modals.indexOf(m), 1);
    const modal = this.#modal?.pluginId === pluginId ? this.#modal : undefined;
    if (modal) this.#modal = undefined;
    for (const m of [...goneModals, ...(modal ? [modal] : [])]) m.resolve(undefined);
    if (gone.length > 0 || shown || titled || goneModals.length > 0 || modal) this.#next(true);
  }

  lock(pluginId: string, hideNotifications: boolean): void {
    this.#locks.set(pluginId, { pluginId, hideNotifications });
    // Чужой диалог на экране уходит обратно в очередь: под замком его не видно, а ответить на него человек не должен.
    const shown = this.#shown;
    if (shown && !this.allows(shown.pluginId)) {
      this.#shown = undefined;
      this.#queue.unshift(shown);
    }
    const modal = this.#modal;
    if (modal && !this.allows(modal.pluginId)) {
      this.#modal = undefined;
      this.#modals.unshift(modal);
    }
    this.#next(true);
  }

  release(pluginId: string): void {
    if (!this.#locks.delete(pluginId)) return;
    this.#next(true);
  }

  /** Выгрузка ядра: замки снимаются, диалоги закрываются. */
  clear(): void {
    this.#locks.clear();
    const all = [...(this.#shown ? [this.#shown] : []), ...this.#queue.splice(0)];
    this.#shown = undefined;
    for (const d of all) d.resolve(undefined);
    const modals = [...(this.#modal ? [this.#modal] : []), ...this.#modals.splice(0)];
    this.#modal = undefined;
    for (const m of modals) m.resolve(undefined);
    this.#changed(this.snapshot);
  }

  #next(changed = false): void {
    if (!this.#shown) {
      const i = this.#queue.findIndex((d) => this.allows(d.pluginId));
      if (i >= 0) {
        this.#shown = this.#queue.splice(i, 1)[0];
        changed = true;
      }
    }
    if (!this.#modal) {
      const j = this.#modals.findIndex((m) => this.allows(m.pluginId));
      if (j >= 0) {
        this.#modal = this.#modals.splice(j, 1)[0];
        changed = true;
      }
    }
    if (changed || this.#queue.length > 0 || this.#modals.length > 0) this.#changed(this.snapshot);
  }
}
