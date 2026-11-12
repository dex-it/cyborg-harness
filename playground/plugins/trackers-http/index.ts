import type { PluginContext, PluginModule } from '@cyborg-harness/contracts';

// Пилот PL-10 (#226): трекер через HTTP API вместо CLI (решение владельца 2026-11-11, D-00 строка 19). Срез GitLab: задачи и MR проекта через `ctx.os.net.fetch`.
// Права плагина - только `net` на хабы из настройки `hubs` (слой пользователя; хабов у человека бывает несколько, свои GitLab и Jira), ни `process`, ни файлов.
// Токен хаба вводит человек командой `set-token` (команда только для видов и палитры, другим плагинам она закрыта) и лежит в хранилище секретов ядра под ключом хаба;
// в `config`, `state`, журнал и сообщения об ошибках он не попадает. Окна нет, в DEFAULT_CONFIG плагин не включён.

/** Страниц по 100 записей за вызов; дальше ответ помечается `truncated`, а не растёт без предела. */
export const MAX_PAGES = 10;
export const PER_PAGE = 100;
/** Сколько текста ответа сервера плагин пишет в строку журнала при отказе. */
const EXCERPT = 200;

export const KINDS = ['issues', 'merge_requests'] as const;
export type Kind = (typeof KINDS)[number];

export interface Item {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly state: string;
}

export interface Listing {
  readonly host: string;
  readonly project: string;
  readonly kind: Kind;
  readonly items: readonly Item[];
  readonly pages: number;
  /** Страниц было больше `MAX_PAGES`: список неполон. */
  readonly truncated: boolean;
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Токен уходит заголовком: пробелы и переводы строк в нём - ошибка ввода, а не часть значения. */
const TOKEN = /^[\x21-\x7e]{1,4096}$/;

const text = (value: unknown): string => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');
const record = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** Хаб: адрес со схемой или хост (с портом); без схемы - https. Токен привязан к `host`: он уходит только на этот хост. */
export function parseHub(hub: string): { readonly origin: string; readonly host: string } {
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(hub) ? hub : `https://${hub}`);
  } catch {
    throw new Error(`trackers-http: хаб - адрес или хост, получено ${JSON.stringify(hub)}`);
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.host === '' || url.username !== '' || url.password !== '') throw new Error(`trackers-http: хаб - адрес https или http без учётных данных, получено ${JSON.stringify(hub)}`);
  return { origin: url.origin, host: url.host.toLowerCase() };
}

/** Проект GitLab: числовой id или путь `группа/подгруппа/имя`; сегмент не начинается с `-`, `.` и не содержит `%`, чтобы путь запроса остался внутри `/api/v4/projects/`. */
export function projectPath(project: string): string {
  if (/^\d+$/.test(project)) return project;
  const parts = project.split('/');
  if (parts.length < 1 || parts.length > 8 || !parts.every((p) => SEGMENT.test(p))) throw new Error(`trackers-http: проект - числовой id или группа/имя, получено ${JSON.stringify(project)}`);
  return encodeURIComponent(project);
}

const tokenKey = (host: string): string => `token/${host}`;

function listOf(json: unknown): Record<string, unknown>[] {
  if (!Array.isArray(json)) throw new Error('trackers-http: ответ - не список');
  return json.map(record);
}

const trackersHttp: PluginModule = {
  config: {
    defaults: { hubs: [] },
    validate: (value) => (Array.isArray(value.hubs) && value.hubs.every((h) => typeof h === 'string') ? [] : ['hubs: ожидается список адресов или хостов']),
  },
  activate(ctx: PluginContext) {
    const net = ctx.os.net;
    if (!net) throw new Error('нет ctx.os.net: в манифесте trackers-http нет права net');

    const list = async (hubArg: unknown, kindArg: unknown, projectArg: unknown): Promise<Listing> => {
      if (typeof hubArg !== 'string') throw new Error('trackers-http: хаб - строка');
      if (!KINDS.includes(kindArg as Kind)) throw new Error(`trackers-http: вид - ${KINDS.join(' или ')}, получено ${JSON.stringify(kindArg)}`);
      if (typeof projectArg !== 'string') throw new Error('trackers-http: проект - строка');
      const kind = kindArg as Kind;
      const hub = parseHub(hubArg);
      const project = projectPath(projectArg);
      const token = await ctx.os.secrets.get(tokenKey(hub.host));
      // Без токена запрос не уходит: анонимный ответ трекера принять за пустой список нельзя.
      if (token === undefined) throw new Error(`trackers-http: для ${hub.host} не задан токен; введите его командой trackers-http.set-token`);
      const items: Item[] = [];
      let page = 1;
      let truncated = false;
      for (;;) {
        const path = `/api/v4/projects/${project}/${kind}?state=opened&per_page=${String(PER_PAGE)}&page=${String(page)}`;
        const response = await net.fetch(`${hub.origin}${path}`, { headers: { 'private-token': token, accept: 'application/json' } });
        if (response.status !== 200) {
          // Тело ответа бывает любым, в том числе с эхом заголовков запроса; журнал вычёркивает известные ему секреты, но плагин сообщает вызывающему только код.
          ctx.log(`${hub.host}: ${kind} ${String(response.status)}: ${response.body.slice(0, EXCERPT)}`, 'warn');
          if (response.status === 401 || response.status === 403) throw new Error(`trackers-http: ${hub.host} отвергает токен (${String(response.status)}); введите новый командой trackers-http.set-token`);
          // Переадресацию ядро не выполняет: токен не уходит на другой хост.
          throw new Error(`trackers-http: ${hub.host} ответил ${String(response.status)}`);
        }
        let json: unknown;
        try {
          json = JSON.parse(response.body);
        } catch {
          throw new Error(`trackers-http: ответ ${hub.host} - не JSON`);
        }
        for (const e of listOf(json)) items.push({ id: text(e.iid), title: text(e.title), url: text(e.web_url), state: text(e.state) });
        if ((response.headers['x-next-page'] ?? '') === '') break;
        if (page >= MAX_PAGES) {
          truncated = true;
          break;
        }
        page++;
      }
      return { host: hub.host, project: projectArg, kind, items, pages: page, truncated };
    };

    ctx.commands.register('trackers-http.list', list);
    /** Хабы из настройки, как их видит плагин, и есть ли токен; значения токенов не отдаются. */
    ctx.commands.register('trackers-http.hubs', async () => {
      const hubs = ctx.config?.get().hubs;
      const out: { host: string; hasToken: boolean; invalid?: true }[] = [];
      for (const hub of Array.isArray(hubs) ? hubs : []) {
        if (typeof hub !== 'string') continue;
        try {
          const { host } = parseHub(hub);
          out.push({ host, hasToken: (await ctx.os.secrets.get(tokenKey(host))) !== undefined });
        } catch {
          out.push({ host: hub, hasToken: false, invalid: true });
        }
      }
      return out;
    });
    ctx.commands.register('trackers-http.set-token', async (hubArg: unknown, token: unknown) => {
      if (typeof hubArg !== 'string') throw new Error('trackers-http: хаб - строка');
      if (typeof token !== 'string' || !TOKEN.test(token)) throw new Error('trackers-http: токен - печатные символы без пробелов, до 4096');
      const { host } = parseHub(hubArg);
      await ctx.os.secrets.set(tokenKey(host), token);
      return { host };
    });
    ctx.commands.register('trackers-http.clear-token', async (hubArg: unknown) => {
      if (typeof hubArg !== 'string') throw new Error('trackers-http: хаб - строка');
      const { host } = parseHub(hubArg);
      await ctx.os.secrets.delete(tokenKey(host));
      return { host };
    });
    return undefined;
  },
};

export default trackersHttp;
