import type { Agent, AgentEvent, LaunchRequest, PluginModule } from '@cyborg/contracts';

// Claude Code не оборачивается: хуки из --settings дописывают JSON события в файл сессии, плагин его читает.
const HOOK_COMMAND = '{ cat; echo; } >> "$CYBORG_EVENTS"';
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'Notification'];
export const LAUNCH_SCRIPT = 'exec claude --settings "$CYBORG_SETTINGS" "$@"';
const POLL_MS = 250;

// Белый список: новый тип Notification в следующей версии CC не уведомляет; idle_prompt повторяет Stop через минуту.
const WAITING: ReadonlyMap<string, string> = new Map([
  ['permission_prompt', 'Просит разрешение'],
  ['elicitation_dialog', 'Задаёт вопрос'],
  ['elicitation_url_dialog', 'Задаёт вопрос'],
  ['agent_needs_input', 'Ждёт ответа'],
  ['quota_auto_resume_stale', 'Остановилась на лимите'],
  ['quota_auto_resume_disabled', 'Остановилась на лимите'],
]);

interface HookEvent {
  hook_event_name?: string;
  cwd?: string;
  tool_name?: string;
  notification_type?: string;
  last_assistant_message?: string;
  background_tasks?: unknown[];
  session_crons?: unknown[];
}

/** Аргументы claude после --settings; промпт до --add-dir: тот вариадический и забрал бы промпт, стоящий после каталогов. */
export function claudeArgs(request: LaunchRequest): string[] {
  const fragments = request.promptFragments ?? [];
  const dirs = request.extraDirs ?? [];
  return [
    ...(request.resumeId ? ['--resume', request.resumeId] : []),
    ...(fragments.length > 0 ? ['--append-system-prompt', fragments.join('\n\n')] : []),
    ...(request.prompt ? [request.prompt] : []),
    ...(dirs.length > 0 ? ['--add-dir', ...dirs] : []),
  ];
}

/** Одно событие хука - одно событие контракта; смена cwd идёт перед ним. */
export function translate(hook: HookEvent, cwd: string | undefined): AgentEvent[] {
  const out: AgentEvent[] = hook.cwd && hook.cwd !== cwd ? [{ type: 'cwd', cwd: hook.cwd }] : [];
  const name = hook.hook_event_name;
  if (name === 'UserPromptSubmit') {
    out.push({ type: 'prompt' });
    return out;
  }
  if (name === 'Stop') {
    const background = (hook.background_tasks?.length ?? 0) > 0 || (hook.session_crons?.length ?? 0) > 0;
    out.push({ type: 'turnEnd', background, ...(typeof hook.last_assistant_message === 'string' && { text: hook.last_assistant_message }) });
    return out;
  }
  const reason = name === 'Notification' ? WAITING.get(hook.notification_type ?? '') : undefined;
  if (reason !== undefined) out.push({ type: 'waiting', reason });
  else out.push({ type: 'activity', ...(typeof hook.tool_name === 'string' && { tool: hook.tool_name }) });
  return out;
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;

const plugin: PluginModule = {
  async activate(ctx) {
    const { fs, paths } = ctx.os;
    const settings = `${paths.data}/claude-hooks.json`;
    const sessions = `${paths.data}/sessions`;
    await fs.mkdir(sessions);
    const hooks = Object.fromEntries(HOOK_EVENTS.map((event) => [event, [{ ...(event === 'PostToolUse' ? { matcher: '*' } : {}), hooks: [{ type: 'command', command: HOOK_COMMAND }] }]]));
    await fs.writeText(settings, JSON.stringify({ hooks }, null, 2));
    const eventsFile = (sessionId: string) => {
      if (!SESSION_ID.test(sessionId)) throw new Error(`id сессии не годится для имени файла: ${sessionId}`);
      return `${sessions}/${sessionId}.jsonl`;
    };

    const agent: Agent = {
      async facts() {
        const run = ctx.os.process?.run('$SHELL', ['-lc', 'claude --version']);
        const result = await run?.catch(() => undefined);
        const version = result?.code === 0 ? /\d+\.\d+\.\d+/.exec(result.stdout)?.[0] : undefined;
        return {
          id: 'claude-code',
          title: 'Claude Code',
          found: result?.code === 0,
          ...(version !== undefined && { version }),
          // История ждёт чтения файла по кускам: журнал длинной сессии - мегабайты, а ctx.os.fs читает файл целиком.
          capabilities: { resume: true, history: false, events: true },
        };
      },
      async launch(request) {
        const file = eventsFile(request.sessionId);
        await fs.writeText(file, '');
        return { program: '$SHELL', args: ['-lc', LAUNCH_SCRIPT, 'cyborg', ...claudeArgs(request)], cwd: request.cwd, env: { CYBORG_EVENTS: file, CYBORG_SETTINGS: settings } };
      },
      watch(sessionId, listener) {
        const file = eventsFile(sessionId);
        let seen = -1;
        let consumed = -1;
        let cwd: string | undefined;
        let busy = false;
        // fs.watch у ctx.os ещё нет: опрос размера, а подписка начинается с конца файла - прошлые события уже показаны.
        const poll = async () => {
          if (busy) return;
          busy = true;
          try {
            const size = (await fs.stat(file)).size;
            if (size === seen) return;
            seen = size;
            const text = await fs.readText(file);
            if (consumed < 0) {
              consumed = text.lastIndexOf('\n') + 1;
              return;
            }
            // Хук может дописывать строку прямо сейчас: читаем только до последнего полного перевода строки.
            const end = text.lastIndexOf('\n') + 1;
            if (end <= consumed) return;
            const lines = text.slice(consumed, end).split('\n');
            consumed = end;
            for (const line of lines) {
              if (!line.trim()) continue;
              let hook: HookEvent;
              try {
                hook = JSON.parse(line) as HookEvent;
              } catch {
                continue;
              }
              for (const event of translate(hook, cwd)) {
                if (event.type === 'cwd') cwd = event.cwd;
                listener(event);
              }
            }
          } catch {
            // Файла ещё нет или его уже убрал ended: следующий опрос попробует снова.
          } finally {
            busy = false;
          }
        };
        void poll();
        const timer = setInterval(() => void poll(), POLL_MS);
        return { dispose: () => clearInterval(timer) };
      },
      async ended(sessionId, exit) {
        await fs.remove(eventsFile(sessionId)).catch(() => undefined);
        // 127 - оболочка входа не нашла claude в своём PATH.
        return exit.code === 127 ? { kind: 'notFound', message: 'claude не найден в PATH оболочки входа' } : null;
      },
      async history() {
        return [];
      },
    };
    ctx.contracts.provide('cyborg.agent', '1.0', agent);
    return undefined;
  },
};

export default plugin;
