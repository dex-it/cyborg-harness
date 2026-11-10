import type { Subscription } from '@cyborg-harness/contracts';

declare module '@cyborg-harness/contracts' {
  interface Contracts {
    'demo.echo': { 1: Echo };
    'demo.chat': { 1: Chat };
  }
}

export interface Echo {
  say(text: string): Promise<string>;
  /** Состояние для пункта меню «Echo: отметка» (`contributes.menus`, K-08). */
  marked(): Promise<boolean>;
}

export interface ChatMessage {
  readonly from: string;
  readonly text: string;
}

/** Общий канал плагинов: сообщение уходит всем подписчикам, своё получатель отсеивает по from. */
export interface Chat {
  send(from: string, text: string): Promise<void>;
  onMessage(listener: (message: ChatMessage) => void): Subscription;
}
