import fs from 'node:fs';
import path from 'node:path';
import type { ViewDrop } from '../shared/views.ts';

/** Файл внутри корня, который ядро разрешило перетаскивать; ссылки раскрываются до проверки, иначе ссылка в корне вывела бы наружу. */
export function resolveDragFile(root: string, relative: unknown): string | undefined {
  if (typeof relative !== 'string' || relative.length === 0 || relative.length > 4096 || relative.includes('\0')) return undefined;
  if (path.isAbsolute(relative)) return undefined;
  try {
    const base = fs.realpathSync(root);
    const file = fs.realpathSync(path.resolve(base, relative));
    if (!file.startsWith(base + path.sep) || !fs.statSync(file).isFile()) return undefined;
    return file;
  } catch {
    return undefined;
  }
}

interface ActiveDrag extends ViewDrop {
  /** Вид под курсором в момент отпускания; до него путь не выдаётся никому. */
  target?: string | undefined;
  readonly landed: Promise<void>;
  readonly land: () => void;
}

/** Перетаскивание между видами ведёт ядро: путь получает только вид, над которым отпущена кнопка, и только один раз. */
export class ViewDrags {
  private current: ActiveDrag | undefined;

  start(from: string, relative: string): ViewDrop {
    let land!: () => void;
    const landed = new Promise<void>((resolve) => {
      land = resolve;
    });
    this.current = { from, path: relative, landed, land };
    return this.current;
  }

  /** Куда сброшено; `undefined` - мимо видов. */
  landed(drag: ViewDrop, target: string | undefined): void {
    const current = this.current;
    if (!current || current !== drag) return;
    current.target = target;
    current.land();
  }

  async take(plugin: string): Promise<ViewDrop | undefined> {
    const drag = this.current;
    if (!drag) return undefined;
    await drag.landed;
    if (this.current !== drag || drag.target !== plugin) return undefined;
    this.current = undefined;
    return { from: drag.from, path: drag.path };
  }

  /** Сброс мимо видов: забытый путь не должен достаться следующему сбросу файла из ОС. */
  end(drag: ViewDrop): void {
    const current = this.current;
    if (!current || current !== drag) return;
    current.land();
    this.current = undefined;
  }
}
