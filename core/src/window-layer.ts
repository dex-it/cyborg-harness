// Слой окна (SAD §3.8): диалоги видов поверх всех фреймов и замок окна. Состояние держит ядро, рисует приложение.

import type { DialogChoice, DialogSpec } from '@cyborg-harness/contracts';
import { CoreError } from './errors.ts';
import { isRecord } from './wire.ts';

/** Владелец команд окна в таблице сочетаний: команды исполняет приложение, а не плагин. */
export const WINDOW_OWNER = 'cyborg.window';

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
  /** Заголовок окна: воркспейс, фрагменты плагинов по их id, приложение - через « - ». */
  readonly title: string;
  /** Ждут своей очереди, включая отложенные замком. */
  readonly queued: number;
  readonly locks: readonly WindowLock[];
}

interface Pending extends ShownDialog {
  readonly resolve: (choice: string | undefined) => void;
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
  readonly #locks = new Map<string, WindowLock>();
  readonly #titles = new Map<string, string>();
  readonly #frame: WindowTitle;
  #shown: Pending | undefined;
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
    return {
      ...(shown && { dialog: { id: shown.id, pluginId: shown.pluginId, view: shown.view, spec: shown.spec } }),
      title: this.title,
      queued: this.#queue.length,
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

  /** Плагин выгружен: его диалоги закрываются с undefined. Замок остаётся - его снимает только владелец. */
  forget(pluginId: string): void {
    const titled = this.#titles.delete(pluginId);
    const gone = this.#queue.filter((d) => d.pluginId === pluginId);
    for (const d of gone) this.#queue.splice(this.#queue.indexOf(d), 1);
    const shown = this.#shown?.pluginId === pluginId ? this.#shown : undefined;
    if (shown) this.#shown = undefined;
    for (const d of [...gone, ...(shown ? [shown] : [])]) d.resolve(undefined);
    if (gone.length > 0 || shown || titled) this.#next(true);
  }

  lock(pluginId: string, hideNotifications: boolean): void {
    this.#locks.set(pluginId, { pluginId, hideNotifications });
    // Чужой диалог на экране уходит обратно в очередь: под замком его не видно, а ответить на него человек не должен.
    const shown = this.#shown;
    if (shown && !this.allows(shown.pluginId)) {
      this.#shown = undefined;
      this.#queue.unshift(shown);
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
    if (changed || this.#queue.length > 0) this.#changed(this.snapshot);
  }
}
