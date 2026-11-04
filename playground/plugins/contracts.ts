import type { Subscription } from '@cyborg/contracts';

declare module '@cyborg/contracts' {
  interface Contracts {
    'demo.echo': { 1: Echo };
    'demo.chat': { 1: Chat };
  }
}

export interface Echo {
  say(text: string): Promise<string>;
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
