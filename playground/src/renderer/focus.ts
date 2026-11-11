// Порядок фокуса между областями окна (SAD §3.8, PL-08): F6 идёт по области за областью в порядке окна - полоса сессий, панель инструментов
// основной области, основная область, выезжающая панель, вкладки боковой колонки и их открытая панель, - затем по кругу.

/** Полосы вкладок: фокус встаёт на выбранную вкладку, а не на саму полосу. */
const TABLISTS = '#session-strip, #side-tabs';
/** Панели окна: вид боковой колонки и общая сетка видов ведут фокус через свои фреймы, поэтому сами остановкой не служат. */
const PANES = 'main .pane:not(.pane-views, .pane-session, .pane-side-page)';
const FRAMES = '.views [data-plugin] iframe';

interface Stop {
  readonly node: HTMLElement;
  /** Номер области в документе: виды одной области идут вместе, как их выкладывает окно. */
  readonly group: number;
  /** Место вида в области (`order` ядра, его ставит стиль обёртки); у остальных остановок - 0. */
  readonly slot: number;
  readonly dom: number;
}

/** Остановки по порядку окна: области в порядке документа, внутри области виды - по `order` ядра, а не по порядку, в каком создавались фреймы. */
export function stops(root: ParentNode = document): HTMLElement[] {
  const nodes = [...root.querySelectorAll<HTMLElement>(`${TABLISTS}, ${PANES}, ${FRAMES}`)].filter((n) => !n.closest('[hidden], [inert]') && (n instanceof HTMLIFrameElement ? n.offsetParent !== null : true));
  const regions = [...root.querySelectorAll<HTMLElement>('.views')];
  const list: Stop[] = nodes.map((node, dom) => {
    const region = node instanceof HTMLIFrameElement ? node.closest<HTMLElement>('.views') : null;
    const figure = node instanceof HTMLIFrameElement ? node.closest<HTMLElement>('.view') : null;
    return { node, group: region ? regions.indexOf(region) : -1, slot: Number(figure?.style.order ?? 0) || 0, dom };
  });
  // Остановка без области держит место по документу, остановка с областью - место первой остановки области; одна область идёт подряд.
  const first = new Map<number, number>();
  for (const s of list) if (s.group !== -1 && !first.has(s.group)) first.set(s.group, s.dom);
  const rank = (s: Stop) => (s.group === -1 ? s.dom : (first.get(s.group) ?? s.dom));
  return list.sort((a, b) => rank(a) - rank(b) || a.slot - b.slot || a.dom - b.dom).map((s) => s.node);
}

function target(node: HTMLElement): HTMLElement {
  if (!node.matches(TABLISTS)) return node;
  return node.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ?? node.querySelector<HTMLElement>('[role="tab"]') ?? node;
}

export function moveFocus(step: 1 | -1): void {
  // Модальный диалог держит фокус у себя: уход из него оставил бы ответ без человека.
  if (document.querySelector('dialog[open]')) return;
  const list = stops();
  if (list.length === 0) return;
  const active = document.activeElement;
  const at = list.findIndex((a) => a === active || a.contains(active));
  const from = at === -1 ? (step === 1 ? -1 : 0) : at;
  const next = list[(from + step + list.length) % list.length] ?? list[0];
  if (!next) return;
  const to = target(next);
  if (!(to instanceof HTMLIFrameElement) && !to.matches('[role="tab"]')) to.tabIndex = -1;
  to.focus();
}
