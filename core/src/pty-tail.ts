// Кольцевой хвост вывода pty: живёт в pty-хосте и в хосте плагина (вывод до первой подписки).

/** Хвост вывода: куски склеиваются при чтении и изредка при сжатии, а не копией всего хвоста на каждый кусок. */
export class Tail {
  readonly #limit: number;
  #chunks: string[] = [];
  #size = 0;

  constructor(limit: number) {
    this.#limit = limit;
  }

  push(data: string): void {
    this.#chunks.push(data);
    this.#size += data.length;
    let first = this.#chunks[0];
    while (first !== undefined && this.#chunks.length > 1 && this.#size - first.length >= this.#limit) {
      this.#chunks.shift();
      this.#size -= first.length;
      first = this.#chunks[0];
    }
    if (this.#chunks.length > 1024) {
      const text = this.text();
      this.#chunks = [text];
      this.#size = text.length;
    }
  }

  text(): string {
    const all = this.#chunks.join('');
    return all.length > this.#limit ? all.slice(-this.#limit) : all;
  }

  take(): string {
    const text = this.text();
    this.#chunks = [];
    this.#size = 0;
    return text;
  }
}

export const BACKLOG_LIMIT = 256 * 1024;
