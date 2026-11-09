// Страница замера: ставит пробные виды во фреймы, отвечает на ping и пересылает его во фрейм через postMessage.

import type { SpikeBridge } from '../shared/spike.ts';
import { byId } from './dom.ts';

const spike = (window as unknown as { spike: SpikeBridge }).spike;
const box = byId('views', HTMLElement);
const frames: { frame: HTMLIFrameElement; origin: string }[] = [];

/** Ставит фреймы и ждёт load каждого; возвращает, сколько это заняло, мс. */
async function mountFrames(urls: readonly string[]): Promise<number> {
  const start = performance.now();
  await Promise.all(
    urls.map((url, i) => {
      const frame = document.createElement('iframe');
      frame.title = `Пробный вид ${i}`;
      const loaded = new Promise<void>((resolve) => frame.addEventListener('load', () => resolve(), { once: true }));
      frame.src = url;
      const parsed = new URL(url);
      frame.dataset.plugin = parsed.host;
      frames.push({ frame, origin: `${parsed.protocol}//${parsed.host}` });
      box.append(frame);
      return loaded;
    }),
  );
  return performance.now() - start;
}

/** Левый верхний угол содержимого фрейма в окне. */
function frameRect(index: number): { x: number; y: number } {
  const frame = frames[index]?.frame;
  if (!frame) throw new Error(`нет фрейма ${index}`);
  const r = frame.getBoundingClientRect();
  return { x: r.left + frame.clientLeft, y: r.top + frame.clientTop };
}

spike.onPing((ping) => {
  if (ping.ack) spike.pong(ping.n);
});
spike.onRelay((target, ping) => {
  const entry = frames[target];
  entry?.frame.contentWindow?.postMessage(ping, entry.origin);
});
window.addEventListener('message', (event) => {
  if (!frames.some((f) => f.frame.contentWindow === event.source && f.origin === event.origin)) return;
  const n = (event.data as { pong?: unknown }).pong;
  if (typeof n === 'number') spike.pong(n);
});

Object.assign(window, { mountFrames, frameRect });
