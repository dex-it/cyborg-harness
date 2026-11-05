import { own } from './wire.ts';

/** Модификаторы в порядке записи; `CmdOrCtrl` - Cmd на macOS и Ctrl на остальных. */
const MODIFIERS = ['CmdOrCtrl', 'Ctrl', 'Alt', 'Shift', 'Meta'] as const;
type Modifier = (typeof MODIFIERS)[number];

const ALIASES: Readonly<Record<string, Modifier>> = {
  cmdorctrl: 'CmdOrCtrl',
  commandorcontrol: 'CmdOrCtrl',
  ctrl: 'Ctrl',
  control: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
  meta: 'Meta',
  cmd: 'Meta',
  command: 'Meta',
  super: 'Meta',
};

const NAMED = ['Enter', 'Escape', 'Space', 'Tab', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'Up', 'Down', 'Left', 'Right'];
// Имена клавиш KeyboardEvent.key -> имена акселератора.
const FROM_EVENT: Readonly<Record<string, string>> = { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Esc: 'Escape' };

function readKey(raw: string): string | undefined {
  if (/^[a-z0-9]$/i.test(raw)) return raw.toUpperCase();
  if (/^F([1-9]|1[0-9]|2[0-4])$/i.test(raw)) return raw.toUpperCase();
  return NAMED.find((n) => n.toLowerCase() === raw.toLowerCase());
}

/** Сочетание в одной записи: модификаторы по порядку, клавиша последней; без модификатора - только F1-F24. Иначе undefined. */
export function normalizeKey(raw: string): string | undefined {
  const parts = raw.split('+').map((p) => p.trim());
  const key = readKey(parts.pop() ?? '');
  if (key === undefined) return undefined;
  const mods = new Set<Modifier>();
  for (const part of parts) {
    const mod = own(ALIASES, part.toLowerCase());
    if (mod === undefined || mods.has(mod)) return undefined;
    mods.add(mod);
  }
  if (mods.size === 0 && !/^F\d/.test(key)) return undefined;
  return [...MODIFIERS.filter((m) => mods.has(m)), key].join('+');
}

/** Запись под платформу: `CmdOrCtrl` становится тем, что реально нажато, - Meta на macOS, Ctrl на остальных. */
export function resolveKey(normalized: string, platform: string): string {
  const parts = normalized.split('+');
  const native = platform === 'darwin' ? 'Meta' : 'Ctrl';
  const mods = new Set(parts.slice(0, -1).map((m) => (m === 'CmdOrCtrl' ? native : m)));
  return [...MODIFIERS.filter((m) => mods.has(m)), parts.at(-1)].join('+');
}

export interface KeyInput {
  readonly key: string;
  /** Физическая клавиша: с Shift `key` у цифры - уже символ (`!`), а `code` остаётся `Digit1`. */
  readonly code?: string;
  readonly control: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
}

/** Нажатие (Electron `before-input-event`, DOM `keydown`) в запись `resolveKey`; клавиша-модификатор сама по себе - undefined. */
export function keyOfInput(input: KeyInput): string | undefined {
  const physical = /^(?:Key|Digit)([A-Z0-9])$/.exec(input.code ?? '')?.[1];
  const key = readKey(physical ?? FROM_EVENT[input.key] ?? input.key);
  if (key === undefined) return undefined;
  const mods: Modifier[] = [];
  if (input.control) mods.push('Ctrl');
  if (input.alt) mods.push('Alt');
  if (input.shift) mods.push('Shift');
  if (input.meta) mods.push('Meta');
  return [...mods, key].join('+');
}
