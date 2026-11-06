import type { AgentTool, AgentToolSpec, ServeRequest, ServeResponse, SessionAction } from '@cyborg-harness/contracts';

export const MCP_PATH = '/mcp';
// Первая - та, что отвечаем клиенту с неизвестной версией: спецификация велит назвать свою последнюю.
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_ACTIONS = 6;
export const MAX_LABEL = 40;
const MAX_TEXT = 2000;

export interface ToolSource {
  readonly pluginId: string;
  readonly impl: AgentTool;
}

export interface McpOptions {
  sessionOf(token: string): string | undefined;
  sources(): readonly ToolSource[];
  onActions(sessionId: string, actions: readonly SessionAction[]): void;
  log(message: string): void;
}

type Id = string | number;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const json = (body: unknown): ServeResponse => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const result = (id: Id, value: unknown) => json({ jsonrpc: '2.0', id, result: value });
const failure = (id: Id | null, code: number, message: string) => json({ jsonrpc: '2.0', id, error: { code, message } });

/** Инструменты всех поставщиков по порядку id плагина; чужое имя или повтор отброшены с записью в журнал. */
export async function collectTools(sources: readonly ToolSource[], log: (message: string) => void): Promise<Map<string, { spec: AgentToolSpec; source: ToolSource }>> {
  const out = new Map<string, { spec: AgentToolSpec; source: ToolSource }>();
  for (const source of sources.toSorted((a, b) => a.pluginId.localeCompare(b.pluginId))) {
    let specs: readonly AgentToolSpec[];
    try {
      specs = await source.impl.tools();
    } catch (error) {
      log(`${source.pluginId}: список инструментов - ${String(error)}`);
      continue;
    }
    for (const spec of specs) {
      if (!TOOL_NAME.test(spec.name) || !isRecord(spec.inputSchema) || spec.inputSchema.type !== 'object') log(`${source.pluginId}: инструмент ${spec.name} отброшен - имя [A-Za-z0-9_-] и inputSchema с type object`);
      else if (out.has(spec.name)) log(`${source.pluginId}: инструмент ${spec.name} уже есть у ${out.get(spec.name)?.source.pluginId ?? ''}`);
      else out.set(spec.name, { spec, source });
    }
  }
  return out;
}

/** Кнопки идут в терминал по клику человека: управляющие символы срезаны, подпись и текст ограничены. */
export function readActions(raw: unknown): SessionAction[] {
  if (!Array.isArray(raw)) return [];
  const clean = (s: string) => s.replace(/\p{Cc}/gu, ' ').trim();
  return raw.slice(0, MAX_ACTIONS).flatMap((a) => {
    if (!isRecord(a) || typeof a.label !== 'string' || typeof a.text !== 'string') return [];
    const label = clean(a.label).slice(0, MAX_LABEL);
    const text = clean(a.text).slice(0, MAX_TEXT);
    return label && text ? [{ label, text, ...(a.submit === true && { submit: true }) }] : [];
  });
}

/** Сервер MCP по Streamable HTTP без потока SSE: на POST - один ответ JSON, уведомления - 202. */
export function mcpHandler(o: McpOptions): (request: ServeRequest) => Promise<ServeResponse> {
  return async (request) => {
    if (request.path.split('?')[0] !== MCP_PATH) return { status: 404 };
    const token = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1];
    const sessionId = token === undefined ? undefined : o.sessionOf(token);
    if (sessionId === undefined) return { status: 401 };
    if (request.method !== 'POST') return { status: 405, headers: { allow: 'POST' } };
    let message: unknown;
    try {
      message = JSON.parse(request.body);
    } catch {
      return failure(null, -32700, 'тело не JSON');
    }
    if (!isRecord(message) || message.jsonrpc !== '2.0') return failure(null, -32600, 'ожидается одно сообщение JSON-RPC 2.0');
    const id = message.id;
    // Уведомление или ответ клиента на наш запрос: отвечать нечем.
    if (typeof message.method !== 'string' || id === undefined || id === null) return { status: 202 };
    if (typeof id !== 'string' && typeof id !== 'number') return failure(null, -32600, 'id - строка или число');
    const params = isRecord(message.params) ? message.params : {};
    switch (message.method) {
      case 'initialize': {
        const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        return result(id, {
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'cyborg', version: '1.0.0' },
        });
      }
      case 'ping':
        return result(id, {});
      case 'tools/list': {
        const tools = await collectTools(o.sources(), (m) => o.log(m));
        return result(id, { tools: [...tools.values()].map(({ spec }) => ({ name: spec.name, description: spec.description, inputSchema: spec.inputSchema })) });
      }
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : '';
        const tool = (await collectTools(o.sources(), (m) => o.log(m))).get(name);
        if (!tool) return failure(id, -32602, `инструмента ${name} нет`);
        try {
          const answer = await tool.source.impl.call(name, params.arguments ?? {}, { sessionId });
          const actions = readActions(answer.actions);
          if (actions.length > 0) o.onActions(sessionId, actions);
          return result(id, { content: [{ type: 'text', text: answer.text }], isError: answer.isError === true });
        } catch (error) {
          // Ошибка инструмента - ответ агенту, а не сбой протокола: так её видит модель и может поправить вызов.
          return result(id, { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true });
        }
      }
      default:
        return failure(id, -32601, `метода ${message.method} нет`);
    }
  };
}
