import type { GitChange, GitCode, GitStatus, TreeMark, TreeMarkKind } from '@cyborg-harness/contracts';

const CODES = new Set<string>([' ', 'M', 'T', 'A', 'D', 'R', 'C', 'U', '?']);
const code = (c: string | undefined): GitCode => (c !== undefined && CODES.has(c) ? (c as GitCode) : ' ');

/** `## main...origin/main [ahead 2, behind 3]`, `## HEAD (no branch)`, `## No commits yet on main`. */
function parseBranch(line: string): Pick<GitStatus, 'branch' | 'ahead' | 'behind'> & { upstream?: string } {
  const head = line.slice(3);
  if (head.startsWith('HEAD (no branch)')) return { branch: null, ahead: 0, behind: 0 };
  const fresh = /^(?:No commits yet on|Initial commit on) (.+)$/.exec(head);
  if (fresh?.[1] !== undefined) return { branch: fresh[1], ahead: 0, behind: 0 };
  const counts = / \[([^\]]*)\]$/.exec(head);
  const names = counts ? head.slice(0, counts.index) : head;
  const split = names.indexOf('...');
  const branch = split === -1 ? names : names.slice(0, split);
  const upstream = split === -1 ? undefined : names.slice(split + 3);
  const number = (word: string) => Number(new RegExp(`${word} (\\d+)`).exec(counts?.[1] ?? '')?.[1] ?? 0);
  return { branch, ...(upstream !== undefined && { upstream }), ahead: number('ahead'), behind: number('behind') };
}

/**
 * Вывод `git status --porcelain=v1 -z --branch`: записи через NUL, пути без кавычек; у переименования и копирования следом идёт отдельная запись с исходным путём.
 * Заголовок `## ` один и первый; строка, которая не `XY путь`, изменением не считается.
 */
export function parseStatus(stdout: string): GitStatus {
  const records = stdout.split('\0');
  if (records[records.length - 1] === '') records.pop();
  let head: ReturnType<typeof parseBranch> = { branch: null, ahead: 0, behind: 0 };
  const changes: GitChange[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i] ?? '';
    if (i === 0 && record.startsWith('## ')) {
      head = parseBranch(record);
      continue;
    }
    if (record.length < 4 || record[2] !== ' ') continue;
    const index = code(record[0]);
    const worktree = code(record[1]);
    const path = record.slice(3);
    if (index === 'R' || index === 'C' || worktree === 'R' || worktree === 'C') {
      const from = records[++i];
      changes.push({ path, index, worktree, ...(from !== undefined && { from }) });
    } else changes.push({ path, index, worktree });
  }
  return { ...head, changes };
}

/** Одна отметка на путь: конфликт старше неотслеживаемого, далее добавленный, переименованный, удалённый, изменённый. */
export function markOf(change: GitChange): TreeMarkKind {
  const { index: x, worktree: y } = change;
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) return 'conflict';
  if (x === '?') return 'untracked';
  if (x === 'A' || x === 'C') return 'added';
  if (x === 'R' || y === 'R') return 'renamed';
  if (x === 'D' || y === 'D') return 'deleted';
  return 'modified';
}

export function marksOf(status: GitStatus): TreeMark[] {
  return status.changes.map((c) => ({ path: c.path, kind: markOf(c) }));
}
