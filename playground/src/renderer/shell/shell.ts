// Оболочка вида: страницу и этот скрипт отдаёт приложение под origin плагина, модуль плагина получает готовый UiContext.

import { connectView, keepFocus, mountModule } from '../../../../core/src/ui-shell.ts';
import type { ViewBridge } from '../../shared/views.ts';

const script = document.currentScript as HTMLScriptElement;
const { plugin = '', view = '', entry = '' } = script.dataset;
const root = document.getElementById('cyborg-view') ?? document.body;
const bridge = (window as unknown as { cyborgView: ViewBridge }).cyborgView;

function fail(error: unknown): void {
  const box = document.createElement('p');
  box.className = 'cyborg-view-error';
  box.setAttribute('role', 'alert');
  box.textContent = `Вид ${plugin}: ${view} не открылся - ${error instanceof Error ? error.message : String(error)}`;
  root.replaceChildren(box);
}

async function start(): Promise<void> {
  const ctx = await connectView(bridge, {
    pluginId: plugin,
    view,
    applyTheme: (tokens) => {
      for (const [name, value] of Object.entries(tokens)) document.documentElement.style.setProperty(name, value);
    },
    // eslint-disable-next-line no-console -- консоль фрейма плагина: в ленту ядра ошибки слушателей не идут
    report: (error) => console.error(error),
  });
  // Классический скрипт разрешает import() от своего адреса /.cyborg/, а путь манифеста - от каталога плагина.
  const module: unknown = await import(new URL(entry, `${location.origin}/`).href);
  const mounted = mountModule(module, root, ctx);
  const focus = keepFocus(window, root);
  addEventListener(
    'pagehide',
    () => {
      focus.dispose();
      mounted.dispose();
    },
    { once: true },
  );
}

start().catch(fail);
