import type { AgentTool, PluginModule, SessionAction } from '@cyborg/contracts';

export const TOOL = 'suggest_actions';

// Замена HTML-комментария cyborg-buttons сегодняшнего Cyborg: вызов инструмента вместо разметки, которую надо выкусывать из вывода.
export const NEXT_ACTIONS_PROMPT = `Если после ответа человеку понятны 1-2 следующих шага, в конце хода вызови инструмент ${TOOL}: label - подпись до 40 знаков, text - реплика человека к тебе одной строкой. submit: true - только если реплику можно отправить без правки. Не очевидно, что делать дальше, - не вызывай. В тексте ответа вызов не упоминай.`;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const tool: AgentTool = {
  tools: () => [
    {
      name: TOOL,
      description: 'Предложить человеку кнопки следующих шагов под сессией: нажатие отправляет реплику агенту или кладёт её в поле ввода.',
      inputSchema: {
        type: 'object',
        properties: {
          actions: {
            type: 'array',
            maxItems: 6,
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', maxLength: 40 },
                text: { type: 'string' },
                submit: { type: 'boolean' },
              },
              required: ['label', 'text'],
            },
          },
        },
        required: ['actions'],
      },
    },
  ],
  call(name, input) {
    const raw = isRecord(input) ? input.actions : undefined;
    if (name !== TOOL || !Array.isArray(raw)) return Promise.resolve({ text: 'ожидается { actions: [{ label, text, submit? }] }', isError: true });
    const actions = raw.filter((a): a is SessionAction => isRecord(a) && typeof a.label === 'string' && typeof a.text === 'string');
    return Promise.resolve({ text: actions.length > 0 ? `кнопок показано: ${String(actions.length)}` : 'кнопок нет', actions });
  },
};

const plugin: PluginModule = {
  activate(ctx) {
    ctx.contracts.provide('cyborg.agent-tool', '1.0', tool);
    ctx.contracts.provide('cyborg.session-prompt', '1.0', { fragment: () => NEXT_ACTIONS_PROMPT });
    return undefined;
  },
};

export default plugin;
