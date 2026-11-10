// Оболочка вида: страницу и этот скрипт отдаёт приложение под origin плагина, модуль плагина получает готовый UiContext.

import { defineElements } from '@cyborg-harness/core/elements';
import { connectView, keepFocus, mountModule } from '@cyborg-harness/core/ui-shell';
import type { ShellBridge } from '../view-protocol.ts';
import { violationNote } from './csp-note.ts';

const script = document.currentScript as HTMLScriptElement;
const { plugin = '', view = '', entry = '' } = script.dataset;
const root = document.getElementById('cyborg-view') ?? document.body;
const bridge = (window as unknown as { cyborgView: ShellBridge }).cyborgView;

function fail(error: unknown): void {
  const box = document.createElement('p');
  box.className = 'cyborg-view-error';
  box.setAttribute('role', 'alert');
  box.textContent = `Вид ${plugin}: ${view} не открылся - ${error instanceof Error ? error.message : String(error)}`;
  root.replaceChildren(box);
}

async function start(): Promise<void> {
  // Отказ CSP не виден ни в разметке, ни в ленте ядра: стиль просто не применился. Причину называет консоль фрейма вида и запись в журнале плагина (#160).
  document.addEventListener('securitypolicyviolation', (event) => {
    // eslint-disable-next-line no-console -- консоль фрейма плагина: тот же текст, что в журнале плагина, для разработчика с DevTools
    console.warn(violationNote(plugin, event));
    bridge.cspViolation(event.violatedDirective, event.blockedURI);
  });
  defineElements();
  const ctx = await connectView(bridge, {
    pluginId: plugin,
    view,
    applyTheme: (tokens) => {
      for (const [name, value] of Object.entries(tokens)) document.documentElement.style.setProperty(name, value);
    },
    // eslint-disable-next-line no-console -- консоль фрейма плагина: в ленту ядра ошибки слушателей не идут
    report: (error) => console.error(error),
  });
  // Классический скрипт разрешает import() от своего адреса /<плагин>/.cyborg/, а путь манифеста - от каталога плагина: origin общий на группу, плагин в пути.
  const module: unknown = await import(new URL(entry, `${location.origin}/${plugin}/`).href);
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
