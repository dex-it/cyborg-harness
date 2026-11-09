import { isDeepStrictEqual } from 'node:util';
import type { SectionResult } from './config.ts';
import { CoreError, errorMessage } from './errors.ts';
import type { SectionInput } from './host-runtime.ts';
import { compileSchema } from './json-schema.ts';
import type { BridgeEnd, KernelContext, Sections } from './kernel-context.ts';
import type { PluginManifest } from './manifest.ts';
import { isRecord } from './wire.ts';

/** Разделы `config` и `state` плагина: что уходит хосту при активации, запись из хоста и правка извне. */
export function createSections(ctx: KernelContext): Sections {
  const { options } = ctx;

  // Поле из net "config:<поле>" задаёт человек: запись плагина в него расширила бы его сеть после перезапуска.
  function guardNetFields(m: PluginManifest, data: Record<string, unknown>): void {
    const layers = (options.config?.raw(m.id) ?? []).map(([, d]) => (isRecord(d) ? d : {}));
    const fields = (m.permissions.net ?? []).filter((h) => h.startsWith('config:')).map((h) => h.slice('config:'.length));
    // Удалить поле или повторить значение, заданное человеком в любом слое, можно: новых хостов это не даёт.
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
      if (p.kind === 'config') guardNetFields(live(p.pluginId), p.data);
      await options[p.kind]?.write(p.layer, p.pluginId, p.version, p.data);
    });
  }

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
        if (result.status !== 'ok') ctx.record({ pluginId, kind, result });
      } catch (error) {
        ctx.record({ pluginId, kind, result: { status: 'invalid', errors: [errorMessage(error)] } });
      }
    }
  }

  return { attach, input, reload };
}
