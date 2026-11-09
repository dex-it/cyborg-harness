var __addDisposableResource = (this && this.__addDisposableResource) || function (env, value, async) {
    if (value !== null && value !== void 0) {
        if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
        var dispose, inner;
        if (async) {
            if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
            dispose = value[Symbol.asyncDispose];
        }
        if (dispose === void 0) {
            if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
            dispose = value[Symbol.dispose];
            if (async) inner = dispose;
        }
        if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
        if (inner) dispose = function() { try { inner.call(this); } catch (e) { return Promise.reject(e); } };
        env.stack.push({ value: value, dispose: dispose, async: async });
    }
    else if (async) {
        env.stack.push({ async: true });
    }
    return value;
};
var __disposeResources = (this && this.__disposeResources) || (function (SuppressedError) {
    return function (env) {
        function fail(e) {
            env.error = env.hasError ? new SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
            env.hasError = true;
        }
        var r, s = 0;
        function next() {
            while (r = env.stack.pop()) {
                try {
                    if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
                    if (r.dispose) {
                        var result = r.dispose.call(r.value);
                        if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) { fail(e); return next(); });
                    }
                    else s |= 1;
                }
                catch (e) {
                    fail(e);
                }
            }
            if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
            if (env.hasError) throw env.error;
        }
        return next();
    };
})(typeof SuppressedError === "function" ? SuppressedError : function (error, suppressed, message) {
    var e = new Error(message);
    return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { resolvePlugin, startKernel } from './kernel.js';
import { sandbox } from './sandbox.js';
/** Потребитель набора: единственный плагин, который зовёт контракт. Право `pty` у него то же, что `launch` у поставщика: пересечение прав не пускает запуск шире описанного. */
const CONSUMER_ID = 'contract-consumer';
function launchRules(manifest) {
    const permissions = typeof manifest === 'object' && manifest !== null && 'permissions' in manifest ? manifest.permissions : undefined;
    const launch = typeof permissions === 'object' && permissions !== null && 'launch' in permissions ? permissions.launch : undefined;
    return Array.isArray(launch) ? launch : [];
}
async function openEnv(provider, options) {
    const resolved = resolvePlugin(provider);
    const box = await sandbox('cyborg-agent-suite-');
    let consumer;
    const probe = {
        manifest: {
            id: CONSUMER_ID,
            version: '1.0.0',
            engines: { cyborg: '^1' },
            consumes: { 'cyborg.agent': '^1' },
            permissions: { pty: launchRules(resolved.manifest) },
        },
        module: {
            activate(ctx) {
                consumer = ctx;
            },
        },
    };
    let kernel;
    try {
        const os = await options.os?.(box);
        if (os && 'pty' in os)
            throw new Error('options.os вернул pty: свой pty в наборе не принимается, запуск наблюдается в fakePty() набора (уберите поле pty)');
        kernel = await startKernel({ plugins: [provider, ...(options.plugins ?? []), probe], ...(os && { os }) });
        const failed = kernel.journal.filter((e) => e.kind === 'failed' || e.kind === 'invalid' || e.kind === 'rejected');
        assert.ok(kernel.active.includes(resolved.id), `${resolved.id} не активирован: ${JSON.stringify(failed)}`);
        assert.ok(consumer, 'потребитель набора не активирован');
        const ctx = consumer;
        const entry = ctx.contracts.all('cyborg.agent', 1).find((x) => x.pluginId === resolved.id);
        assert.ok(entry, `${resolved.id} не отдаёт cyborg.agent`);
        const live = kernel;
        return {
            kernel: live,
            providerId: resolved.id,
            agent: entry.impl,
            consumer: ctx,
            cwd: box.root,
            [Symbol.asyncDispose]: async () => {
                await live[Symbol.asyncDispose]();
                await box[Symbol.asyncDispose]();
            },
        };
    }
    catch (error) {
        await kernel?.[Symbol.asyncDispose]();
        await box[Symbol.asyncDispose]();
        throw error;
    }
}
/** Проверки из теста `cyborg.agent, общий набор` (ADR-CH-0004): факты и клонируемость, запуск через потребителя по его праву `pty`, причина выхода, история, отсутствие `denied`. */
const AGENT_CHECKS = [
    {
        name: 'факты - данные: id, название, найденная программа, булевы capabilities',
        async run({ agent }) {
            const facts = await agent.facts();
            assert.deepEqual(structuredClone(facts), facts, 'факты не данные');
            assert.equal(typeof facts.id, 'string', 'facts.id');
            assert.notEqual(facts.id, '', 'facts.id пуст');
            assert.equal(typeof facts.title, 'string', 'facts.title');
            assert.equal(facts.found, true, 'программа не найдена: набору нужна среда, где она находится (параметр os)');
            for (const flag of ['resume', 'history', 'events'])
                assert.equal(typeof facts.capabilities[flag], 'boolean', `capabilities.${flag}`);
        },
    },
    {
        name: 'launch - данные в границах запроса: cwd запроса, программа, аргументы и окружение строками',
        async run({ agent, cwd }) {
            const spec = await agent.launch({ sessionId: 'contract-launch', cwd });
            assert.deepEqual(structuredClone(spec), spec, 'запуск не данные');
            assert.equal(spec.cwd, cwd);
            assert.equal(typeof spec.program, 'string', 'program');
            assert.ok(spec.args.every((a) => typeof a === 'string'), 'args - строки');
            assert.ok(Object.values(spec.env).every((v) => typeof v === 'string'), 'env - строки');
        },
    },
    {
        name: 'запуск через потребителя по его праву pty: описание из launch годится как вход ctx.os.pty.spawn',
        async run({ agent, kernel, consumer, providerId }) {
            // Каталог запуска pty должен лежать в области потребителя; свой каталог данных есть у любого плагина.
            const spec = await agent.launch({ sessionId: 'contract-pty', cwd: consumer.os.paths.data });
            const pty = consumer.os.pty;
            assert.ok(pty, 'у потребителя нет ctx.os.pty');
            const before = kernel.pty.procs.length;
            await pty.spawn({ ...spec, cols: 120, rows: 32, describedBy: providerId });
            const proc = kernel.pty.procs[before];
            assert.ok(proc, 'pty не запущен');
            // `$SHELL` ядро заменяет путём оболочки входа; остальное доходит как описано.
            if (spec.program !== '$SHELL')
                assert.equal(proc.file, spec.program);
            assert.deepEqual(proc.args, spec.args);
            assert.equal(proc.options.cwd, spec.cwd);
        },
    },
    {
        name: 'ended: код 127 - notFound с сообщением, нормальный выход - null',
        async run({ agent, cwd }) {
            await agent.launch({ sessionId: 'contract-ended', cwd });
            const hint = await agent.ended('contract-ended', { code: 127 });
            assert.ok(hint, '127 - не найдена программа, а подсказки нет');
            assert.equal(hint.kind, 'notFound', '127 - не найдена программа');
            assert.equal(typeof hint.message, 'string', 'RecoveryHint.message');
            assert.equal(await agent.ended('contract-ended', { code: 0 }), null, 'код 0 - не сбой');
        },
    },
    {
        name: 'history: список записей; без capabilities.history - пустой',
        async run({ agent, cwd }) {
            const facts = await agent.facts();
            const list = await agent.history(cwd);
            assert.ok(Array.isArray(list), 'history не список');
            if (!facts.capabilities.history)
                assert.deepEqual(list, [], 'capabilities.history ложно, а список не пуст');
            for (const e of list)
                assert.deepEqual([typeof e.id, typeof e.cwd, typeof e.title, typeof e.updated], ['string', 'string', 'string', 'number'], 'HistoryEntry');
        },
    },
    {
        name: 'в журнале нет denied и failed: поставщик описал запуск в пределах своего права launch',
        async run({ kernel }) {
            const bad = kernel.journal.filter((e) => e.kind === 'denied' || e.kind === 'failed');
            assert.deepEqual(bad, [], 'журнал');
        },
    },
];
/** Имена проверок набора по порядку. */
export const AGENT_CHECK_NAMES = AGENT_CHECKS.map((c) => c.name);
/**
 * Прогоняет все проверки на поставщике и бросает на первой неудачной (в сообщении её имя). Нужна для проверки самого набора на плохом поставщике и для запуска вне `node:test`.
 */
export async function checkAgentContract(provider, options = {}) {
    const env_1 = { stack: [], error: void 0, hasError: false };
    try {
        const env = __addDisposableResource(env_1, await openEnv(provider, options), true);
        for (const check of AGENT_CHECKS) {
            try {
                await check.run(env);
            }
            catch (error) {
                throw new Error(`${env.providerId}: ${check.name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
            }
        }
    }
    catch (e_1) {
        env_1.error = e_1;
        env_1.hasError = true;
    }
    finally {
        const result_1 = __disposeResources(env_1);
        if (result_1)
            await result_1;
    }
}
/**
 * Общий набор тестов `cyborg.agent`: один и тот же для встроенных и сторонних поставщиков. Вызывается на верхнем уровне тестового файла:
 *
 *     agentContractSuite('/path/to/my-agent', { os: (box) => ({ env: { PATH: '/usr/bin:/bin' } }) });
 *
 * Поставщик - каталог плагина или плагин из кода. Потребителя (с правом `pty`, равным `launch` поставщика) и ядро набор поднимает сам.
 */
export function agentContractSuite(provider, options = {}) {
    const { id } = resolvePlugin(provider);
    void describe(`cyborg.agent, общий набор: ${id}`, () => {
        let env;
        before(async () => {
            env = await openEnv(provider, options);
        });
        after(async () => {
            await env?.[Symbol.asyncDispose]();
        });
        for (const check of AGENT_CHECKS) {
            void test(check.name, async () => {
                assert.ok(env, 'ядро набора не поднялось');
                await check.run(env);
            });
        }
    });
}
