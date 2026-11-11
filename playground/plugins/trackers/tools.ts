// Три трекера Cyborg через программы командной строки: что запускать, какие аргументы закреплены правилом `process` манифеста и как читать ответ.
// Всё, что идёт в argv после закреплённого правилом префикса, правило не проверяет (SAD, вопрос 5): сегменты пути проверяет сам плагин, и ни один не начинается с `-`.

export type TrackerId = 'github' | 'gitlab' | 'jira';

export interface Item {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly state: string;
}

export interface Tool {
  readonly program: 'gh' | 'glab' | 'jira';
  /** Переменные, которые Cyborg передаёт программе (`GH_PROMPT_DISABLED=1`, `NO_COLOR=1`); имена те же, что в `env` правила. */
  readonly env: Readonly<Record<string, string>>;
  readonly args: (target: string) => string[];
  readonly items: (json: unknown) => Item[];
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const KEY = /^[A-Z][A-Z0-9_]{1,9}$/;

const record = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const text = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');

function segments(target: string, min: number, max: number, what: string): string[] {
  const parts = target.split('/');
  if (parts.length < min || parts.length > max || !parts.every((p) => SEGMENT.test(p))) throw new Error(`trackers: ${what}: ${JSON.stringify(target)}`);
  return parts;
}

export const TOOLS: Readonly<Record<TrackerId, Tool>> = {
  github: {
    program: 'gh',
    env: { GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
    args: (target) => ['api', '--method', 'GET', `repos/${segments(target, 2, 2, 'репозиторий GitHub - владелец/имя').join('/')}/pulls?state=open&per_page=100`],
    items: (json) => asList(json).map((e) => ({ id: text(e.number), title: text(e.title), url: text(e.html_url), state: text(e.state) })),
  },
  gitlab: {
    program: 'glab',
    env: { NO_COLOR: '1' },
    args: (target) => ['api', '--method', 'GET', `projects/${encodeURIComponent(segments(target, 2, 8, 'проект GitLab - группа/имя').join('/'))}/merge_requests?state=opened&per_page=100`],
    items: (json) => asList(json).map((e) => ({ id: text(e.iid), title: text(e.title), url: text(e.web_url), state: text(e.state) })),
  },
  jira: {
    program: 'jira',
    env: { NO_COLOR: '1' },
    args: (target) => {
      if (!KEY.test(target)) throw new Error(`trackers: ключ проекта Jira - заглавные буквы и цифры: ${JSON.stringify(target)}`);
      return ['issue', 'list', '--raw', '-p', target];
    },
    items: (json) => asList(json).map((e) => ({ id: text(e.key), title: text(record(e.fields).summary), url: '', state: text(record(record(e.fields).status).name) })),
  },
};

function asList(json: unknown): Record<string, unknown>[] {
  if (!Array.isArray(json)) throw new Error('trackers: ответ - не список');
  return json.map(record);
}

/** Вход не выполнен: `gh` отвечает кодом 4 и просит `gh auth login`, `glab` и `jira` называют 401 или аутентификацию. */
export const LOGIN_FAILED = /auth login|unauthori[sz]ed|401|not logged|authentication|log in/i;
