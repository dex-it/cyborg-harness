import type { PluginModule } from '@cyborg-harness/contracts';
import { readLegacyPrefs } from './prefs-map.ts';

// Пилот PL-06: настройки окна Cyborg из localStorage старого окна - в память видов. Прочитать localStorage может только старое окно, оно зовёт `legacy-prefs.import`
// со всеми ключами `cyborg.*`. Главная часть раскладывает их по видам и ждёт, пока вид заберёт своё: память вида пишет только сам вид (`ctx.state.set`).
// Канал «главная часть - вид» сообщений не хранит, поэтому открытому виду посылается толчок, а вид, которого ещё нет, спрашивает команду `legacy-prefs.pending` при открытии.
// Ждущее лежит в памяти главной части: до записи видом перезапуск его теряет, и старое окно отдаёт ключи заново (localStorage при этом остаётся нетронутым).
const legacyPrefs: PluginModule = {
  activate(ctx) {
    const pending = new Map<string, Record<string, unknown>>();
    ctx.commands.register('legacy-prefs.import', async (dump) => {
      const { views, skipped } = readLegacyPrefs(dump);
      for (const [view, state] of Object.entries(views)) {
        pending.set(view, state);
        await ctx.views.channel(view).post({ legacyPrefs: state });
      }
      for (const { key, reason } of skipped) ctx.log(`${key}: не перенесён - ${reason}`);
      return { views: Object.keys(views), skipped };
    });
    ctx.commands.register('legacy-prefs.pending', (view) => pending.get(String(view)));
    ctx.commands.register('legacy-prefs.done', (view) => pending.delete(String(view)));
    return undefined;
  },
};

export default legacyPrefs;
