// Уведомления плагинов (SAD §3.7, право `notify`): живые уведомления, их пределы и клик. Показывает приложение, учёт ведёт ядро.

import type { NotifyClick } from '@cyborg-harness/contracts';
import { CoreError } from './errors.ts';
import { isRecord } from './wire.ts';

/** Что приложение возвращает на показ: без дескриптора уведомление нельзя закрыть, но учёт и клик работают. */
export interface NoticeHandle {
  close(): void;
}

/** События уведомления от приложения: клик человека и закрытие самой ОС или человеком. */
export interface NoticeEvents {
  click(): void;
  closed(): void;
}

export type ShowNotice = (title: string, body: string | undefined, events: NoticeEvents) => NoticeHandle | undefined | Promise<NoticeHandle | undefined>;

export interface NotifyLimits {
  /** Символов в заголовке. */
  readonly title?: number;
  /** Символов в тексте. */
  readonly body?: number;
  /** Живых уведомлений у одного плагина. */
  readonly live?: number;
}

// Больше системный центр уведомлений всё равно обрежет, а десяток живых - уже шум, а не сигнал.
export const NOTIFY_LIMITS: Required<NotifyLimits> = { title: 120, body: 1000, live: 10 };

interface Live {
  readonly pluginId: string;
  readonly onClick: NotifyClick | undefined;
  handle?: NoticeHandle | undefined;
  closed: boolean;
}

export interface NoticeRequest {
  readonly title: string;
  readonly body: string | undefined;
  readonly onClick: NotifyClick | undefined;
}

/** Разбор аргументов `show`; команду клика сверяет вызывающий - у него манифест. */
export function parseNotice(args: readonly unknown[], limits: NotifyLimits = {}): NoticeRequest {
  const max = { ...NOTIFY_LIMITS, ...limits };
  const [title, body, options] = args;
  if (typeof title !== 'string' || title.length === 0 || title.length > max.title) throw new CoreError('Invalid', `notify.show: заголовок - строка от 1 до ${String(max.title)} символов`);
  if (body !== undefined && (typeof body !== 'string' || body.length > max.body)) throw new CoreError('Invalid', `notify.show: текст - строка до ${String(max.body)} символов`);
  if (options !== undefined && !isRecord(options)) throw new CoreError('Invalid', 'notify.show: параметры - объект { onClick }');
  const click = options?.onClick;
  if (click === undefined) return { title, body, onClick: undefined };
  if (!isRecord(click) || typeof click.command !== 'string' || (click.args !== undefined && !Array.isArray(click.args))) throw new CoreError('Invalid', 'notify.show: onClick - { command, args? }');
  return { title, body, onClick: { command: click.command, args: (click.args as unknown[] | undefined) ?? [] } };
}

export class Notices {
  readonly #show: () => ShowNotice | undefined;
  readonly #clicked: (pluginId: string, click: NotifyClick) => void;
  readonly #live = new Map<string, Live>();
  readonly #max: Required<NotifyLimits>;
  #seq = 0;

  constructor(show: () => ShowNotice | undefined, clicked: (pluginId: string, click: NotifyClick) => void, limits: NotifyLimits = {}) {
    this.#show = show;
    this.#clicked = clicked;
    this.#max = { ...NOTIFY_LIMITS, ...limits };
  }

  get limits(): Required<NotifyLimits> {
    return this.#max;
  }

  /** Живые уведомления плагина - для тестов и окна. */
  liveOf(pluginId: string): number {
    return [...this.#live.values()].filter((n) => n.pluginId === pluginId).length;
  }

  async show(pluginId: string, request: NoticeRequest): Promise<string> {
    const show = this.#show();
    if (!show) throw new CoreError('Unavailable', 'уведомлений нет в этой среде');
    // Electron не обещает `close` для истёкшего баннера: отказ на пределе навсегда заглушил бы плагин, поэтому уходит старейшее.
    if (this.liveOf(pluginId) >= this.#max.live) {
      const oldest = [...this.#live].find(([, n]) => n.pluginId === pluginId);
      if (oldest) this.#drop(oldest[0]);
    }
    const id = `n${String(++this.#seq)}`;
    // Место занято до ответа приложения: параллельные show не обойдут предел.
    const live: Live = { pluginId, onClick: request.onClick, closed: false };
    this.#live.set(id, live);
    const events: NoticeEvents = {
      click: () => {
        if (this.#live.get(id) !== live) return;
        this.#drop(id);
        if (live.onClick) this.#clicked(pluginId, live.onClick);
      },
      closed: () => {
        if (this.#live.get(id) === live) this.#live.delete(id);
      },
    };
    try {
      const handle = await show(request.title, request.body, events);
      if (handle) live.handle = handle;
    } catch (error) {
      this.#live.delete(id);
      throw error;
    }
    // Закрыли, пока приложение показывало: дескриптор пришёл позже.
    if (live.closed) live.handle?.close();
    return id;
  }

  close(pluginId: string, id: unknown): void {
    if (typeof id !== 'string') throw new CoreError('Invalid', 'notify.close: id - строка');
    if (this.#live.get(id)?.pluginId === pluginId) this.#drop(id);
  }

  /** Плагин выгружен: его уведомления закрываются, клик по ним уже некому принять. */
  forget(pluginId: string): void {
    for (const [id, n] of [...this.#live]) if (n.pluginId === pluginId) this.#drop(id);
  }

  #drop(id: string): void {
    const live = this.#live.get(id);
    if (!live) return;
    this.#live.delete(id);
    live.closed = true;
    try {
      live.handle?.close();
    } catch {
      // Уведомление уже снято ОС: закрывать нечего.
    }
  }
}
