// Виды плагинов во фреймах (SAD2 §3.8): фрейм живёт, пока плагин активен, и не пересоздаётся на каждый снимок.

import type { PluginRow } from '../shared/plugins.ts';
import { el } from './dom.ts';

export class ViewsPanel {
  private readonly frames = new Map<string, HTMLElement>();
  private readonly root: HTMLElement;
  private readonly empty: HTMLElement;

  constructor(root: HTMLElement) {
    this.root = root;
    this.empty = el('p', 'empty', 'Активных плагинов с видом нет');
    root.append(this.empty);
  }

  sync(plugins: readonly PluginRow[]): void {
    const wanted = new Map(plugins.flatMap((p) => (p.view === undefined ? [] : [[p.id, p.view] as const])));
    for (const [id, box] of this.frames) {
      if (wanted.has(id)) continue;
      box.remove();
      this.frames.delete(id);
    }
    // Перенос <iframe> в DOM перезагружает его документ: новый фрейм встаёт на своё место, старые не двигаются.
    let previous: HTMLElement | undefined;
    for (const [id, url] of wanted) {
      const existing = this.frames.get(id);
      if (existing) {
        previous = existing;
        continue;
      }
      const box = el('figure', 'view');
      box.dataset.plugin = id;
      const frame = document.createElement('iframe');
      frame.src = url;
      frame.title = `Вид ${id}`;
      box.append(el('figcaption', 'view-origin', url), frame);
      this.frames.set(id, box);
      if (previous) previous.after(box);
      else this.root.prepend(box);
      previous = box;
    }
    this.empty.hidden = this.frames.size > 0;
  }
}
