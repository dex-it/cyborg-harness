import type { PluginModule } from '@cyborg-harness/contracts';

// Пилот PL-04: приёмник «открыть файл». Окна у пилота нет - просмотр держится в памяти плагина, чтобы тест видел, что и откуда дошло.
// Команда открыта чужим главным частям (`callers: "plugins"`), а `guard` требует у вызывающего право fs.read на путь до того, как вызов дойдёт сюда:
// сам viewer читает по своему праву и не отдал бы вызывающему то, чего тот прочитать не может (пересечение прав).

/** Сколько байт файла берёт просмотр (предел `fs.readSlice` - 1 МиБ). */
const PREVIEW_BYTES = 64 * 1024;

interface Opened {
  readonly path: string;
  readonly size: number;
  readonly shownBytes: number;
  readonly text: string;
}

const viewer: PluginModule = {
  activate(ctx) {
    let current: Opened | undefined;
    ctx.commands.register('viewer.open', async (spec) => {
      const path = (spec as { path?: unknown } | null)?.path;
      if (typeof path !== 'string') throw new Error('viewer.open: нужен { path: строка }');
      const slice = await ctx.os.fs.readSlice(path, 0, PREVIEW_BYTES);
      current = { path, size: slice.size, shownBytes: slice.bytes, text: slice.text };
      return { path, size: slice.size, shownBytes: slice.bytes, truncated: slice.bytes < slice.size };
    });
    ctx.commands.register('viewer.current', () => current ?? null);
    return undefined;
  },
};

export default viewer;
