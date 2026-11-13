import type { ProtectedFileRule } from '@cyborg-harness/core';

const LABEL = 'конфигурация агента';
const DIRS = ['hooks', 'commands', 'agents', 'skills', 'output-styles'] as const;

/**
 * Файлы, из которых агент (Claude Code) берёт хуки, правила `allow`, серверы MCP и инструкции (TR-25, У-46, FR-CH-3031): хук в настройках - команда оболочки с правами пользователя
 * мимо права `process`, поэтому плагину они закрыты при любом праве `fs.write`.
 * `all` - файлы, где бывают ключи и переменные окружения (закрыты и для чтения); `write` - тексты инструкций и команды (читать можно, писать нельзя).
 * Рабочие каталоги самого агента (`.claude/worktrees`, `~/.claude/projects`) конфигурацией не считаются. `electronOs({ protectedFiles })` заменяет перечень, `[]` снимает защиту.
 */
export const AGENT_FILES: readonly ProtectedFileRule[] = [
  { path: ['.mcp.json'], closed: 'all', label: LABEL },
  { path: ['.claude.json'], under: 'home', closed: 'all', label: LABEL },
  { path: ['.claude', 'settings*.json'], closed: 'all', label: LABEL },
  { path: ['CLAUDE.md'], closed: 'write', label: LABEL },
  { path: ['CLAUDE.local.md'], closed: 'write', label: LABEL },
  ...DIRS.map((dir): ProtectedFileRule => ({ path: ['.claude', dir], tree: true, closed: 'write', label: LABEL })),
];
