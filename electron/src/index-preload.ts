// Адаптер Electron, часть preload: мосты окна и видов.
export { exposeViewBridge, inViewFrame, inWindowDocument, viewBridge, windowApi } from './preload.ts';
export type { WindowApi } from './preload.ts';
