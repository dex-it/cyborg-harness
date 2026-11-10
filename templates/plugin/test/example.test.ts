import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { checkPlugin } from '@cyborg-harness/core/plugin-check';
import type { UiContext } from '@cyborg-harness/contracts';
import { memoryStore, startKernel } from '@cyborg-harness/testing';

const home = path.resolve(import.meta.dirname, '..');
const consumer = path.join(import.meta.dirname, 'consumer');

describe('плагин example', () => {
  it('проверка состава: манифест, файлы, правило импортов - без замечаний, прав не просит', async () => {
    const report = await checkPlugin(home, { ignore: ['dist'] });
    assert.deepEqual(report.problems, []);
    assert.deepEqual(report.permissions, []);
  });

  it('активен, команда отвечает, вид main объявлен', async () => {
    await using kernel = await startKernel({ plugins: [home] });
    await kernel.waitForJournal({ kind: 'activated', pluginId: 'example' });
    assert.equal(await kernel.run('example.hello'), 'привет');
    assert.ok(kernel.layout.some((e) => e.pluginId === 'example' && e.kind === 'view' && e.name === 'main'));
  });

  it('раздел config: значение по схеме читается', async () => {
    const { store } = memoryStore({ user: { example: { $version: 1, greeting: 'здравствуйте' } } });
    await using kernel = await startKernel({ plugins: [home], config: store });
    await kernel.waitForJournal({ kind: 'activated', pluginId: 'example' });
    assert.equal(await kernel.run('example.hello'), 'здравствуйте');
  });

  it('раздел config: значение не по схеме - плагин не активируется, причина в журнале', async () => {
    const { store } = memoryStore({ user: { example: { $version: 1, greeting: 5 } } });
    await using kernel = await startKernel({ plugins: [home], config: store });
    assert.deepEqual(kernel.journal, [{ pluginId: 'example', kind: 'config', result: { status: 'invalid', errors: ['/greeting: ожидается string, получено integer'] } }]);
    assert.deepEqual(kernel.active, []);
  });

  it('контракт example.greeting: потребитель получает приветствие поставщика', async () => {
    await using kernel = await startKernel({ plugins: [home, consumer] });
    await kernel.waitForJournal({ kind: 'activated', pluginId: 'consumer' });
    assert.equal(await kernel.run('consumer.ask', 'мир'), 'привет, мир');
  });

  it('вид: mount собирает кнопку и ответ, клик показывает ответ команды или причину отказа', async () => {
    // Вид живёт в браузерном фрейме, а тест идёт в Node: DOM подменён минимумом, который трогает вид. Проверка настоящего фрейма - в окне (npm start).
    class FakeElement {
      id = '';
      textContent = '';
      children: FakeElement[] = [];
      listeners: (() => void)[] = [];
      addEventListener(_type: string, listener: () => void): void {
        this.listeners.push(listener);
      }
      click(): void {
        for (const listener of this.listeners) listener();
      }
      append(...nodes: FakeElement[]): void {
        this.children.push(...nodes);
      }
      replaceChildren(): void {
        this.children = [];
      }
    }
    Object.defineProperty(globalThis, 'document', { value: { createElement: () => new FakeElement() }, configurable: true });
    try {
      const { mount } = await import('../ui/ui.ts');
      const reply: { value: unknown } = { value: 'привет' };
      const ctx = { commands: { run: async (name: string) => (reply.value instanceof Error ? Promise.reject(reply.value) : `${name}: ${String(reply.value)}`) } } as unknown as UiContext;
      const root = new FakeElement();
      const view = mount(root as unknown as HTMLElement, ctx);
      const [button, answer] = root.children;
      assert.ok(button && answer);
      assert.equal(button.id, 'hello');
      button.click();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(answer.textContent, 'example.hello: привет');
      reply.value = new Error('нет права');
      button.click();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(answer.textContent, 'отказ: нет права');
      view.dispose();
      assert.deepEqual(root.children, []);
    } finally {
      Reflect.deleteProperty(globalThis, 'document');
    }
  });
});
