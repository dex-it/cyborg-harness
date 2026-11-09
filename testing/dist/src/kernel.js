var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inlineHosts, load, PLUGIN_API_VERSION, SectionStore, } from '@cyborg-harness/core';
import { fakePty } from './fake-pty.js';
import { memorySecrets } from './memory.js';
import { sandbox } from './sandbox.js';
const ENTRY_FILES = ['index.mjs', 'index.js', 'index.ts'];
function idOf(manifest, where) {
    const id = typeof manifest === 'object' && manifest !== null && 'id' in manifest ? manifest.id : undefined;
    if (typeof id !== 'string' || id === '')
        throw new Error(`${where}: в манифесте нет строки id`);
    return id;
}
/** Собирает манифест и точку входа; ошибка называет каталог. */
export function resolvePlugin(plugin) {
    if (typeof plugin !== 'string') {
        const id = idOf(plugin.manifest, 'плагин из кода теста');
        return { id, manifest: plugin.manifest, entry: `inline:${id}`, module: plugin.module };
    }
    const file = path.join(plugin, 'manifest.json');
    if (!existsSync(file))
        throw new Error(`${plugin}: нет manifest.json`);
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    const main = ENTRY_FILES.map((f) => path.join(plugin, f)).find((f) => existsSync(f));
    if (main === undefined)
        throw new Error(`${plugin}: нет точки входа (${ENTRY_FILES.join(', ')})`);
    return { id: idOf(manifest, file), manifest, entry: pathToFileURL(main).href };
}
const describeEntry = (e) => `${e.pluginId ?? '-'}:${e.kind}`;
/**
 * Поднимает ядро с плагинами теста на хостах внутри процесса теста (`inlineHosts`): граница данных та же, что в окне, изоляции сбоев нет.
 * Снимать ядро - `await using k = await startKernel(...)`.
 */
export async function startKernel(options) {
    const plugins = options.plugins.map(resolvePlugin);
    const ids = plugins.map((p) => p.id);
    const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
    if (duplicate !== undefined)
        throw new Error(`плагин ${duplicate} назван дважды`);
    const box = await sandbox('cyborg-kit-');
    const backend = fakePty();
    const secrets = memorySecrets();
    const os = {
        dataDir: box.path('data'),
        tempDir: box.path('temp'),
        home: box.root,
        env: { PATH: '/usr/bin:/bin', HOME: box.root },
        pty: backend,
        secrets,
        ...options.os,
    };
    const inline = new Map(plugins.flatMap((p) => (p.module ? [[p.entry, p.module]] : [])));
    const importer = async (entry) => inline.get(entry) ?? (await import(__rewriteRelativeImportExtension(entry))).default;
    const entries = new Map(plugins.map((p) => [p.id, p.entry]));
    let kernel;
    try {
        kernel = await load({
            ...options.load,
            apiVersion: PLUGIN_API_VERSION,
            enabled: options.enabled ?? ids,
            manifests: plugins.map((p) => p.manifest),
            entry: (m) => entries.get(m.id) ?? m.id,
            spawnHost: inlineHosts(importer),
            os,
            ...(options.config && { config: await SectionStore.open(options.config, ['user', 'workspace']) }),
            ...(options.state && { state: await SectionStore.open(options.state, ['workspace']) }),
        });
    }
    catch (error) {
        await box[Symbol.asyncDispose]();
        throw error;
    }
    const waitForJournal = async (match, wait = {}) => {
        const test = typeof match === 'function' ? match : (e) => e.kind === match.kind && (match.pluginId === undefined || e.pluginId === match.pluginId);
        const deadline = Date.now() + (wait.timeout ?? 5000);
        for (;;) {
            const found = kernel.journal.find(test);
            if (found)
                return found;
            if (Date.now() >= deadline)
                throw new Error(`в журнале нет нужной записи за ${String(wait.timeout ?? 5000)} мс; есть: ${kernel.journal.map(describeEntry).join(', ') || 'пусто'}`);
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    };
    let closed;
    return Object.assign(Object.create(kernel), {
        sandbox: box,
        pty: backend,
        secrets,
        dataDir: (pluginId) => path.join(os.dataDir, pluginId),
        waitForJournal,
        [Symbol.asyncDispose]: () => (closed ??= kernel.unload().finally(() => box[Symbol.asyncDispose]())),
    });
}
