import type { PluginModule } from '@cyborg/contracts';

// Текст сегодняшнего Cyborg (src/main/claude-args.ts): EnterWorktree, а не git worktree add - он меняет cwd сессии.
export const ISOLATION_PROMPT =
  'В этих репозиториях параллельно работают другие сессии. Перед первой правкой в репозитории, сменой ветки или коммитом - EnterWorktree, дальше работа только в нём; основной каталог - только чтение. Файлы вне репозиториев (скрэтчпад, временные) worktree не требуют. EnterWorktree изолирует только репозиторий рабочего каталога: перед правкой в репозитории из --add-dir - git worktree add <репозиторий>/.claude/worktrees/<то же имя> -b <та же ветка>, и правки только по этому пути.';

const plugin: PluginModule = {
  activate(ctx) {
    ctx.contracts.provide('cyborg.session-prompt', '1.0', { fragment: () => ISOLATION_PROMPT });
    return undefined;
  },
};

export default plugin;
