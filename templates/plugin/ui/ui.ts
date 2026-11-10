import type { Disposable, UiContext, UiModule } from '@cyborg-harness/contracts';

export function mount(root: HTMLElement, ctx: UiContext): Disposable {
  const button = document.createElement('cy-button');
  button.id = 'hello';
  button.textContent = 'Поздороваться';
  const answer = document.createElement('p');
  answer.id = 'answer';
  button.addEventListener('click', () => {
    void ctx.commands.run('example.hello').then(
      (value) => (answer.textContent = String(value)),
      (error: unknown) => (answer.textContent = `отказ: ${error instanceof Error ? error.message : String(error)}`),
    );
  });
  root.append(button, answer);
  return { dispose: () => root.replaceChildren() };
}

mount satisfies UiModule<HTMLElement>['mount'];
