// Публичный вход ядра для окна (браузер, без `node:*`): то, что главный процесс отдаёт окну. Только именованные экспорты; перечень сверяет core/test/public-api.test.ts.
// Типы из loader.ts и documents.ts стираются при сборке: в JS этого входа попадает только window-layer.ts.
export { WINDOW_OWNER } from './window-layer.ts';

export type { DocumentRow } from './documents.ts';
export type { LayoutEntry } from './layout.ts';
export type { DisablePreview } from './loader.ts';
export type { Area } from './manifest-layout.ts';
export type { ShownDialog, WindowLock, WindowSnapshot, WindowTitle } from './window-layer.ts';
