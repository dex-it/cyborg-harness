// Порядок фокуса между областями окна (SAD2 §3.8): панели каркаса по порядку, затем фреймы видов.

/** Области в порядке обхода; вид - сам фрейм: дальше фокус ведёт документ плагина. */
function areas(): HTMLElement[] {
  const panes = [...document.querySelectorAll<HTMLElement>('main .pane:not(.pane-views)')];
  const frames = [...document.querySelectorAll<HTMLIFrameElement>('#views [data-plugin] iframe')].filter((f) => f.offsetParent !== null);
  return [...panes, ...frames].filter((a) => !a.closest('[hidden], [inert]'));
}

export function moveFocus(step: 1 | -1): void {
  // Модальный диалог держит фокус у себя: уход из него оставил бы ответ без человека.
  if (document.querySelector('dialog[open]')) return;
  const list = areas();
  if (list.length === 0) return;
  const active = document.activeElement;
  const at = list.findIndex((a) => a === active || a.contains(active));
  const from = at === -1 ? (step === 1 ? -1 : 0) : at;
  const next = list[(from + step + list.length) % list.length] ?? list[0];
  if (!next) return;
  if (!(next instanceof HTMLIFrameElement)) next.tabIndex = -1;
  next.focus();
}
