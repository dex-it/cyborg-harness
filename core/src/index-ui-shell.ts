// Публичный вход ядра для окна (браузер, без `node:*`): оболочка вида плагина. Перечень сверяет core/test/public-api.test.ts.
export { connectView, keepFocus, mountModule } from './ui-shell.ts';

export type { FocusRoot, FocusWindow, TerminalEvent, TerminalOpened, ViewBridge, ViewTarget } from './ui-shell.ts';
