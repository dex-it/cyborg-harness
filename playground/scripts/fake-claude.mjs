// Подставной claude для smoke: хуки пишет в файл событий сессии, кнопки предлагает через MCP - как живой, но без входа в аккаунт и сети.
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
if (args[0] === '--version') {
  console.log('0.0.0 (smoke)');
  process.exit(0);
}

const hook = (event) => appendFileSync(process.env.CYBORG_EVENTS, `${JSON.stringify(event)}\n`);
const config = args.find((a) => a.startsWith('--mcp-config='));
const server = config && JSON.parse(readFileSync(config.slice('--mcp-config='.length), 'utf8')).mcpServers.cyborg;
const suggest = () =>
  fetch(server.url, {
    method: 'POST',
    headers: { authorization: server.headers.Authorization.replace('${CYBORG_MCP_TOKEN}', process.env.CYBORG_MCP_TOKEN ?? ''), 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'suggest_actions', arguments: { actions: [{ label: 'Продолжить', text: 'smoke-reply', submit: true }] } } }),
  });

console.log('fake claude: готов');
for await (const line of createInterface({ input: process.stdin })) {
  console.log(`получено: ${line}`);
  if (line === 'go') {
    await suggest();
    hook({ hook_event_name: 'Stop' });
  }
  // Только работа, без вопроса: сессия снова занята (снимает уведомление «ждёт»).
  if (line === 'work') hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash' });
  if (line === 'ask') {
    hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash' });
    await suggest();
    hook({ hook_event_name: 'Notification', notification_type: 'permission_prompt' });
    console.log('fake claude: просит разрешение');
  }
}
