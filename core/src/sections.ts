import { isDeepStrictEqual } from 'node:util';
import { TRUSTED_LAYER, type SectionResult } from './config.ts';
import { CoreError, errorMessage } from './errors.ts';
import type { SectionInput } from './host-runtime.ts';
import { compileSchema } from './json-schema.ts';
import type { BridgeEnd, KernelContext, Sections } from './kernel-context.ts';
import type { JournalEntry } from './kernel-types.ts';
import type { PluginManifest } from './manifest.ts';
import { isRecord } from './wire.ts';

/** Разделы `config` и `state` плагина: что уходит хосту при активации, запись из хоста и правка извне. */
export function createSections(ctx: KernelContext): Sections {
  const { options } = ctx;

  // Поле из net "config:<поле>" задаёт человек: запись плагина в него расширила бы его сеть после перезапуска.
  function guardNetFields(m: PluginManifest, target: string, data: Record<string, unknown>): void {
    // В слой пользователя повторить можно только его же значение: значение из файла воркспейса стало бы там доверенным. В остальные слои - значение любого слоя: права из них не берутся, а миграция и пересохранение раздела повторяют значение воркспейса.
    const layers = (options.config?.raw(m.id) ?? []).filter(([layer]) => target !== TRUSTED_LAYER || layer === TRUSTED_LAYER).map(([, d]) => (isRecord(d) ? d : {}));
    const fields = (m.permissions.net ?? []).filter((h) => h.startsWith('config:')).map((h) => h.slice('config:'.length));
    // Удалить поле или повторить значение, заданное человеком в слое пользователя, можно: новых хостов это не даёт.
    const touched = fields.filter((f) => data[f] !== undefined && !layers.some((d) => isDeepStrictEqual(d[f], data[f])));
    if (touched.length === 0) return;
    const detail = `поля ${touched.join(', ')} задают хосты net - их меняет только человек`;
    ctx.record({ pluginId: m.id, kind: 'denied', method: 'config.set', detail });
    throw new CoreError('PermissionDenied', `${m.id}: ${detail}`);
  }

  function input(kind: 'config' | 'state', m: PluginManifest): SectionInput | SectionResult | undefined {
    const declared = m[kind];
    const store = options[kind];
    if (!declared || !store) return undefined;
    const sectionInput = { version: declared.version, layers: store.raw(m.id) };
    const file = declared.schema;
    if (file === undefined) return sectionInput;
    let schema: unknown;
    try {
      if (!options.schema) throw new Error('приложение не читает файлы схем');
      schema = options.schema(m, file);
    } catch (error) {
      return { status: 'invalid', errors: [`${file}: ${errorMessage(error)}`] };
    }
    const compiled = compileSchema(schema);
    return compiled.ok ? { ...sectionInput, schema } : { status: 'invalid', errors: compiled.errors.map((e) => `${file}: ${e}`) };
  }

  function attach({ live, onRequest }: BridgeEnd): void {
    onRequest('section.write', { pluginId: 'string', kind: ['config', 'state'], layer: 'string', version: 'number', data: 'record' }, async (p) => {
      const declared = live(p.pluginId)[p.kind];
      if (!declared) throw new CoreError('NotDeclared', `${p.pluginId}: раздел ${p.kind} не объявлен в манифесте`);
      if (p.version !== declared.version) {
        throw new CoreError('Invalid', `${p.pluginId}: раздел ${p.kind} версии ${p.version}, а в манифесте ${declared.version}`);
      }
      if (p.kind === 'config') guardNetFields(live(p.pluginId), p.layer, p.data);
      await options[p.kind]?.write(p.layer, p.pluginId, p.version, p.data);
    });
  }

  /**
   * Перезагрузка идёт мимо очереди жизненного цикла: за время вызова плагин могли снять (`disable`), и запись о ней легла бы после его `unloaded`
   * и перекрыла бы её: по последней записи жизненного цикла `enable` поставщика решает, поднимать ли зависимого. Снятому плагину запись не пишется.
   */
  const note = (entry: Extract<JournalEntry, { kind: 'config' | 'state' }>) => {
    if (ctx.active.includes(entry.pluginId)) ctx.record(entry);
  };

  /** Раздел поменялся извне: активные владельцы получают `onChange`, не прошедший проверку - запись в журнал. */
  async function reload(kind: 'config' | 'state', ids: readonly string[]): Promise<void> {
    const { pool } = ctx.parts;
    for (const pluginId of [...ctx.active]) {
      const m = ctx.manifestOf(pluginId);
      const store = options[kind];
      if (!ids.includes(pluginId)) continue;
      if (kind === 'config') ctx.gateway.approve(pluginId);
      if (!m[kind] || !store) continue;
      try {
        const result = await pool.call<SectionResult>(pool.live(pluginId), pluginId, 'section.reload', { pluginId, kind, layers: store.raw(pluginId) });
        if (result.status !== 'ok') note({ pluginId, kind, result });
      } catch (error) {
        note({ pluginId, kind, result: { status: 'invalid', errors: [errorMessage(error)] } });
      }
    }
  }

  return { attach, input, reload };
}
