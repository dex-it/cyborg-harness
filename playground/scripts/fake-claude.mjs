// Подставной claude для smoke и пилота PL-01: хуки пишет в файл событий сессии, кнопки предлагает через MCP - как живой, но без входа в аккаунт и сети.
// Для замеров нагрузки: `raw` включает клавиши (ответ `got: [x]`), в нём `flood N W` - N цветных строк по W знаков и последняя `END-N`, `size` - размер pty, `tick MS` и `stop` - нумерованные строки раз в MS мс, `sink` - принять ввод и назвать его размер; `exit` - выход.
import { Buffer } from 'node:buffer';
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { clearInterval, setInterval } from 'node:timers';

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

// Нагрузка по образцу базы Cyborg (PL-09): цветные строки по W знаков, последняя называет себя, чтобы зритель увидел конец.
function flood(count, width) {
  for (let i = 0; i < count; i++) {
    const text = (i === count - 1 ? `END-${count}` : `L${i}`).padEnd(width, 'x').slice(0, Math.max(width, 12));
    process.stdout.write(`\x1b[3${1 + (i % 6)}m${text}\x1b[0m\n`);
  }
}

// Режим клавиш: терминал отдаёт каждую клавишу сразу, программа отвечает на неё, как делает Ink в claude.
// Команда одним куском с Enter (`flood N W`, `size`, `tick MS`, `stop`, `sink`) выполняется, остальное - клавиши.
let raw = false;
let sink = 0;
let sunk;
let ticker;
let seq = 0;
process.stdin.on('data', (chunk) => {
  if (!raw) return;
  const text = String(chunk);
  const loud = /^flood (\d+) (\d+)\r$/.exec(text);
  if (loud) return flood(Number(loud[1]), Number(loud[2]));
  if (text === 'size\r') return console.log(`size: ${process.stdout.columns}x${process.stdout.rows}`);
  const every = /^tick (\d+)\r$/.exec(text);
  if (every) return void (ticker ??= setInterval(() => process.stdout.write(`[${String(seq++).padStart(6, '0')}]\n`), Number(every[1])));
  if (text === 'stop\r') return void (clearInterval(ticker), (ticker = undefined), console.log(`stopped: ${seq}`));
  // Приём большого ввода без вывода на каждый байт: один ответ, когда ввод затих.
  if (text === 'sink\r') return void (sink = -1);
  if (sink !== 0) {
    sink = Math.max(0, sink) + Buffer.byteLength(text);
    clearTimeout(sunk);
    sunk = setTimeout(() => {
      console.log(`sunk: ${sink}`);
      sink = 0;
    }, 300);
    return;
  }
  for (const key of text) process.stdout.write(`got: [${key}]\n`);
});

console.log('fake claude: готов');
for await (const line of createInterface({ input: process.stdin })) {
  // В режиме клавиш строки разбирает обработчик выше, readline молчит (иначе 1 МиБ ввода без Enter вернулся бы одной строкой).
  if (raw) continue;
  console.log(`получено: ${line}`);
  if (line === 'raw' && process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    raw = true;
    console.log('fake claude: клавиши');
  }
  if (line === 'exit') process.exit(0);
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
