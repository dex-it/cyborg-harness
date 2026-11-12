import assert from 'node:assert/strict';
import { test } from 'node:test';
import { routeInput, type RoutedInput } from '../src/key-route.ts';

// PL-03: решение «забрать нажатие у страницы» принимается по самому нажатию, без оглядки на кадр, в котором стоит фокус (SAD 3.9, FR-CH-2004: из любого `<iframe>`).
const input = (over: Partial<RoutedInput>): RoutedInput => ({ type: 'keyDown', key: 'N', code: 'KeyN', control: false, alt: false, shift: true, meta: true, isAutoRepeat: false, ...over });
const fake = (taken: readonly string[], modal = false) => {
  const seen: [string, boolean][] = [];
  return {
    seen,
    plugins: {
      dismissModal: () => modal,
      press: (i: { key: string }, repeat?: boolean) => {
        seen.push([i.key, repeat === true]);
        return taken.includes(i.key);
      },
    },
  };
};

test('ST-2002/3: нажатие: забранное ядром не доходит до страницы, чужое доходит; автоповтор передаётся ядру', () => {
  const { plugins, seen } = fake(['N']);
  assert.equal(routeInput(plugins, input({})), true);
  assert.equal(routeInput(plugins, input({ key: 'Z', code: 'KeyZ' })), false);
  assert.equal(routeInput(plugins, input({ isAutoRepeat: true })), true);
  assert.deepEqual(seen, [['N', false], ['Z', false], ['N', true]]);
});

test('нажатие: отпускание клавиши и не-клавиатурные события ядру не отдаются', () => {
  const { plugins, seen } = fake(['N']);
  assert.equal(routeInput(plugins, input({ type: 'keyUp' })), false);
  assert.equal(routeInput(plugins, input({ type: 'char' })), false);
  assert.deepEqual(seen, []);
});

test('нажатие: Escape при открытом модальном окне плагина забирается раньше сочетаний, без модального уходит дальше', () => {
  const open = fake(['Escape']);
  const modal = fake(['Escape'], true);
  assert.equal(routeInput(modal.plugins, input({ key: 'Escape', code: 'Escape', shift: false, meta: false })), true);
  assert.deepEqual(modal.seen, [], 'модальное окно получило Escape, сочетаниям он не достался');
  assert.equal(routeInput(open.plugins, input({ key: 'Escape', code: 'Escape', shift: false, meta: false })), true);
  assert.deepEqual(open.seen, [['Escape', false]]);
});
