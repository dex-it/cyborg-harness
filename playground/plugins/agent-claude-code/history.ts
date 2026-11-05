import type { HistoryEntry, OsFs } from '@cyborg/contracts';

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Журнал длинной сессии - мегабайты: заголовок и первый запрос ищутся только у краёв файла.
const EDGE_BYTES = 64 * 1024;
const LIMIT = 50;
const TITLE_MAX = 120;
// Сессия, ушедшая в worktree (<repo>/.claude/worktrees/<имя>), пишет журнал в каталог worktree; `claude --resume` из репозитория её находит.
const WORKTREE_INFIX = '--claude-worktrees-';

export const projectDirName = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-');

const oneLine = (text: string): string => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
};

function promptText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const text = (content as { type?: unknown; text?: unknown }[]).find((c) => c.type === 'text');
  return typeof text?.text === 'string' ? text.text : '';
}

/** Сессия запущена человеком в терминале, а не `claude -p`; заголовок - последний custom-title, иначе ai-title, иначе первый запрос. */
export function journalFacts(head: string, tail: string): { interactive: boolean; title: string } {
  let entrypoint: string | undefined;
  let custom = '';
  let ai = '';
  let firstPrompt = '';
  for (const [chunk, isHead] of [
    [head, true],
    [tail, false],
  ] as const) {
    for (const line of chunk.split('\n')) {
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (isHead && entrypoint === undefined && typeof record.entrypoint === 'string') entrypoint = record.entrypoint;
      if (record.type === 'custom-title' && typeof record.customTitle === 'string') custom = record.customTitle;
      if (record.type === 'ai-title' && typeof record.aiTitle === 'string') ai = record.aiTitle;
      if (isHead && !firstPrompt && record.type === 'user' && !record.isMeta) {
        const text = promptText((record.message as { content?: unknown } | undefined)?.content).trim();
        // `<local-command-caveat>` и прочая служебная разметка - не набранный человеком текст.
        if (text && !text.startsWith('<')) firstPrompt = text;
      }
    }
  }
  return { interactive: entrypoint === 'cli', title: oneLine(custom || ai || firstPrompt) };
}

/** Интерактивные сессии каталога и его worktree, свежие первыми; журнал без заголовка не показывается. */
export async function listHistory(fs: OsFs, root: string, cwd: string, limit = LIMIT): Promise<HistoryEntry[]> {
  const own = projectDirName(cwd);
  const dirs = (await fs.list(root).catch(() => [])).filter((e) => e.kind === 'dir' && (e.name === own || e.name.startsWith(own + WORKTREE_INFIX)));
  const candidates: { id: string; file: string; size: number; updated: number }[] = [];
  for (const dir of dirs) {
    for (const entry of await fs.list(`${root}/${dir.name}`).catch(() => [])) {
      const id = entry.name.replace(/\.jsonl$/, '');
      if (entry.kind !== 'file' || id === entry.name || !SESSION_ID.test(id)) continue;
      const file = `${root}/${dir.name}/${entry.name}`;
      const stat = await fs.stat(file).catch(() => undefined);
      if (stat && stat.size > 0) candidates.push({ id, file, size: stat.size, updated: stat.mtimeMs });
    }
  }
  candidates.sort((a, b) => b.updated - a.updated);
  const entries: HistoryEntry[] = [];
  for (const c of candidates) {
    if (entries.length >= limit) break;
    try {
      const head = await fs.readSlice(c.file, 0, EDGE_BYTES);
      const tail = c.size > EDGE_BYTES ? await fs.readSlice(c.file, c.size - EDGE_BYTES, EDGE_BYTES) : { text: '' };
      const facts = journalFacts(head.text, tail.text);
      if (facts.interactive && facts.title) entries.push({ id: c.id, cwd, title: facts.title, updated: c.updated });
    } catch {
      continue;
    }
  }
  return entries;
}
