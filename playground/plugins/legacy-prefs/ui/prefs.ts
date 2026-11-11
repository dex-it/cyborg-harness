// Вид пилота PL-06: забирает у главной части перенесённые настройки старого окна и записывает их в свою память (`ctx.state`). Одна страница на все виды плагина:
// у каждого вида (имя - в `ctx.view`) своя память, как будет у их владельцев после переезда (trackers, search, claude-extensions и др.).

import type { Disposable, UiContext, UiModule } from '@cyborg-harness/contracts';
import { mergeLegacy } from '../prefs-map.ts';

type SyncContext = Pick<UiContext, 'view' | 'commands' | 'state' | 'channel'>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Записывает в память вида перенесённое (если метки переноса ещё нет) и сообщает главной части, что забрал. Возвращает, было ли что записать. */
export async function applyLegacyPrefs(ctx: SyncContext, incoming: unknown): Promise<boolean> {
  if (!isRecord(incoming)) return false;
  const next = mergeLegacy(ctx.state.value, incoming);
  if (next !== undefined) await ctx.state.set(next);
  await ctx.commands.run('legacy-prefs.done', ctx.view);
  return next !== undefined;
}

/** При открытии: спросить ждущее у главной части и подписаться на толчок, если перенос придёт позже. */
export function syncLegacyPrefs(ctx: SyncContext, report: (text: string) => void = () => undefined): { done: Promise<void>; subscription: Disposable } {
  const fail = (error: unknown) => report(`перенос настроек: ${error instanceof Error ? error.message : String(error)}`);
  const apply = (incoming: unknown) =>
    applyLegacyPrefs(ctx, incoming).then((written) => report(written ? 'настройки старого окна перенесены' : 'перенос уже был или переносить нечего'), fail);
  const subscription = ctx.channel.onMessage((message) => {
    if (isRecord(message)) void apply(message.legacyPrefs);
  });
  const done = ctx.commands.run('legacy-prefs.pending', ctx.view).then((incoming) => (incoming === undefined ? undefined : apply(incoming)), fail);
  return { done, subscription };
}

export function mount(root: HTMLElement, ctx: UiContext): Disposable {
  const status = Object.assign(document.createElement('output'), { id: 'status', textContent: 'настройки старого окна: ждём' });
  root.append(status);
  const { subscription } = syncLegacyPrefs(ctx, (text) => (status.textContent = text));
  return {
    dispose() {
      subscription.dispose();
      root.replaceChildren();
    },
  };
}

mount satisfies UiModule<HTMLElement>['mount'];
