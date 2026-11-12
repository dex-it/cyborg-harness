import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Agent, AgentFacts, PluginModule } from '@cyborg-harness/contracts';
import { agentContractSuite, AGENT_CHECK_NAMES, checkAgentContract, fakePty, type AgentSuiteOptions, projectSettingsContractSuite, PROJECT_SETTINGS_REQUIRED_CHECKS, secretSourceContractSuite, SECRET_SOURCE_REQUIRED_CHECKS, type InlinePlugin } from '../src/index.ts';

const FACTS: AgentFacts = { id: 'fake', title: 'Фальшивый', found: true, capabilities: { resume: false, history: false, events: false } };

const GOOD: Agent = {
  facts: async () => FACTS,
  launch: async (request) => ({ program: '/bin/sh', args: ['-c', 'true'], cwd: request.cwd, env: {} }),
  watch: () => ({ dispose: () => undefined }),
  ended: async (_id, exit) => (exit.code === 127 ? { kind: 'notFound', message: 'нет программы' } : null),
  history: async () => [],
};

/** Поставщик из кода теста; `agent` перекрывает члены хорошего, `launch` - право `launch` манифеста. */
function provider(agent: Partial<Agent> = {}, launch: unknown[] = ['/bin/sh']): InlinePlugin {
  const impl = { ...GOOD, ...agent };
  const module: PluginModule = { activate: (ctx) => void ctx.contracts.provide('cyborg.agent', '1.0', impl) };
  return { manifest: { id: 'fake-agent', version: '1.0.0', engines: { cyborg: '^1' }, provides: { 'cyborg.agent': '1.0' }, permissions: { launch } }, module };
}

// Хороший поставщик проходит те же проверки, что встроенные: набор вызывается и как тесты этого файла.
agentContractSuite(provider());

describe('набор cyborg.agent на плохих поставщиках', () => {
  it('ST-7003/2: ST-2006/1: хороший поставщик проходит и через checkAgentContract', async () => {
    await checkAgentContract(provider());
  });

  it('ST-7003/3: запуск не данные: функция в LaunchSpec не проходит границу хоста', async () => {
    const bad = provider({ launch: (async (request: { cwd: string }) => ({ program: '/bin/sh', args: [], cwd: request.cwd, env: {}, run: () => 1 })) as unknown as Agent['launch'] });
    await assert.rejects(checkAgentContract(bad), /fake-agent: launch - данные/);
  });

  it('ST-7003/3: ST-2006/8: неверный код выхода: 127 не переведён в notFound', async () => {
    await assert.rejects(checkAgentContract(provider({ ended: async () => null })), /ended: код 127.*127 - не найдена программа/);
  });

  it('ST-7003/3: код 0 принят за сбой', async () => {
    await assert.rejects(checkAgentContract(provider({ ended: async () => ({ kind: 'notFound', message: 'всегда' }) })), /код 0 - не сбой/);
  });

  it('программа не найдена в среде набора', async () => {
    await assert.rejects(checkAgentContract(provider({ facts: async () => ({ ...FACTS, found: false }) })), /программа не найдена/);
  });

  it('capabilities не булевы', async () => {
    const facts = { ...FACTS, capabilities: { resume: 'да', history: false, events: false } } as unknown as AgentFacts;
    await assert.rejects(checkAgentContract(provider({ facts: async () => facts })), /capabilities\.resume/);
  });

  it('ST-7003/3: ST-2006/2: запуск шире права launch: pty потребителя отказывает, запуск не доходит до бэкенда', async () => {
    const bad = provider({ launch: async (request) => ({ program: '/bin/bash', args: [], cwd: request.cwd, env: {} }) });
    await assert.rejects(checkAgentContract(bad), /запуск через потребителя по его праву pty/);
  });

  it('cwd подменён поставщиком', async () => {
    await assert.rejects(checkAgentContract(provider({ launch: async () => ({ program: '/bin/sh', args: [], cwd: '/elsewhere', env: {} }) })), /launch - данные/);
  });

  it('история непуста без capabilities.history', async () => {
    const entry = { id: 'a', cwd: '/w', title: 't', updated: 1 };
    await assert.rejects(checkAgentContract(provider({ history: async () => [entry] })), /history: .*capabilities\.history ложно/);
  });

  it('отказ шлюза, проглоченный поставщиком, виден в журнале: denied', async () => {
    const module: PluginModule = {
      activate: (ctx) =>
        void ctx.contracts.provide('cyborg.agent', '1.0', {
          ...GOOD,
          facts: async () => {
            await ctx.os.fs.readText('/etc/hosts').catch(() => undefined);
            return FACTS;
          },
        }),
    };
    await assert.rejects(checkAgentContract({ manifest: provider().manifest, module }), /в журнале нет denied и failed/);
  });

  it('плагин, который не активируется, назван в ошибке', async () => {
    const broken: InlinePlugin = { manifest: { id: 'fake-agent', version: '1.0.0', engines: { cyborg: '^1' }, provides: { 'cyborg.agent': '1.0' } }, module: { activate: () => Promise.reject(new Error('упал при активации')) } };
    await assert.rejects(checkAgentContract(broken), /fake-agent не активирован.*упал при активации/);
  });

  it('свой os.pty не принимается: набор сам наблюдает запуск, а не бэкенд теста', async () => {
    // Тип os набора исключает pty; в JS и через приведение типа отказ должен быть понятным, а не «pty не запущен».
    const withOwnPty = (() => ({ pty: fakePty() })) as unknown as NonNullable<AgentSuiteOptions['os']>;
    await assert.rejects(checkAgentContract(provider(), { os: withOwnPty }), /options\.os вернул pty.*не принимается/);
  });

  it('тип os набора не допускает pty', () => {
    // @ts-expect-error -- pty в os набора запрещён типом и рядом с другими полями среды
    const bad: AgentSuiteOptions = { os: () => ({ env: {}, pty: fakePty() }) };
    assert.ok(bad);
  });

  it('ST-7003/2: набор состоит из шести проверок, имена различны', () => {
    assert.equal(AGENT_CHECK_NAMES.length, 6);
    assert.equal(new Set(AGENT_CHECK_NAMES).size, 6);
  });
});

describe('каркасы наборов', () => {
  it('у каждой обязательной проверки есть источник и имя', () => {
    for (const c of [...SECRET_SOURCE_REQUIRED_CHECKS, ...PROJECT_SETTINGS_REQUIRED_CHECKS]) {
      assert.ok(c.name.length > 10 && c.source.includes('sad.md'), c.name);
    }
    assert.equal(SECRET_SOURCE_REQUIRED_CHECKS.length, 5);
    assert.equal(PROJECT_SETTINGS_REQUIRED_CHECKS.length, 3);
  });
});

// Каркасы регистрируют проверки как todo: в отчёте они видны, красными не бывают.
secretSourceContractSuite(provider());
projectSettingsContractSuite(provider());
