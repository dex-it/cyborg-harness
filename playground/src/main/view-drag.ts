import path from 'node:path';
import type { ViewDrop } from '../shared/views.ts';

/** Перетаскивание между видами ведёт ядро: путь и плагин-источник у него, вид-приёмник забирает их на сбросе один раз. */
export class ViewDrags {
  private current: ViewDrop | undefined;

  start(from: string, file: unknown): ViewDrop | undefined {
    if (typeof file !== 'string' || file.length === 0 || file.length > 4096 || file.includes('\0')) return undefined;
    if (!path.posix.isAbsolute(file) || path.posix.normalize(file) !== file) return undefined;
    this.current = { from, path: file };
    return this.current;
  }

  take(): ViewDrop | undefined {
    const drop = this.current;
    this.current = undefined;
    return drop;
  }

  /** Сброс мимо видов: забытый путь не должен достаться следующему сбросу файла из ОС. */
  end(drag: ViewDrop): void {
    if (this.current === drag) this.current = undefined;
  }
}
