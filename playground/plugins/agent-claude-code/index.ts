import type { Agent, AgentEvent, Disposable, LaunchRequest, PluginModule } from '@cyborg/contracts';
import { listHistory } from './history.ts';

// Claude Code не оборачивается: хуки из --settings дописывают JSON события в файл сессии, плагин его читает.
const HOOK_COMMAND = '{ cat; echo; } >> "$CYBORG_EVENTS"';
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'Notification'];
export const LAUNCH_SCRIPT = 'exec claude --settings "$CYBORG_SETTINGS" "$@"';
const SLICE_BYTES = 256 * 1024;
// Первый символ не дефис: id идёт в argv claude и не должен стать флагом.
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const STOP_QUIET_MS = 30_000;

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
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  notification_type?: string;
  last_assistant_message?: string;
  background_tasks?: unknown[];
  session_crons?: unknown[];
}

/** Аргументы claude после --settings; промпт до --add-dir: тот вариадический и забрал бы промпт, стоящий после каталогов. */
export function claudeArgs(request: LaunchRequest, mcpFile?: string): string[] {
  // resumeId приходит из данных документа, а их правит не только плагин: чужая форма стала бы флагом claude.
  if (request.resumeId !== undefined && !SESSION_ID.test(request.resumeId)) throw new Error(`id сессии для --resume не годится: ${request.resumeId}`);
  const fragments = request.promptFragments ?? [];
  const dirs = request.extraDirs ?? [];
  return [
    ...(request.resumeId ? ['--resume', request.resumeId] : []),
    ...(fragments.length > 0 ? ['--append-system-prompt', fragments.join('\n\n')] : []),
    // Через «=»: --mcp-config вариадический и иначе забрал бы промпт.
    ...(mcpFile !== undefined ? [`--mcp-config=${mcpFile}`] : []),
    ...(request.prompt ? [request.prompt] : []),
    ...(dirs.length > 0 ? ['--add-dir', ...dirs] : []),
  ];
}

export const MCP_SERVER = 'cyborg';

// Токен - в окружении процесса claude: его видит только владелец, а файл и argv - другие пользователи машины.
export function mcpConfig(url: string): unknown {
  return { mcpServers: { [MCP_SERVER]: { type: 'http', url, headers: { Authorization: 'Bearer ${CYBORG_MCP_TOKEN}' } } } };
}

/** Одно событие хука - одно событие контракта; смена cwd идёт перед ним. */
export function translate(hook: HookEvent, cwd: string | undefined): AgentEvent[] {
  const out: AgentEvent[] = hook.cwd && hook.cwd !== cwd ? [{ type: 'cwd', cwd: hook.cwd }] : [];
  const name = hook.hook_event_name;
  if (name === 'UserPromptSubmit') {
    out.push({ type: 'prompt' });
    return out;
  }
  // id уходит в argv `--resume` и в state воркспейса: чужая форма не доходит ни туда, ни туда.
  if (name === 'SessionStart' && typeof hook.session_id === 'string' && SESSION_ID.test(hook.session_id)) {
    out.push({ type: 'session', resumeId: hook.session_id });
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

// Чужой Stop-хук может продолжить ход: «ждёт» после Stop объявляется, только если сессия молчит quietMs.
export function waitAfterStop(listener: (event: AgentEvent) => void, quietMs: number): { listener: (event: AgentEvent) => void; dispose(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const dispose = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  return {
    listener: (event) => {
      dispose();
      listener(event);
      if (event.type === 'turnEnd' && !event.background) {
        timer = setTimeout(() => {
          timer = undefined;
          listener({ type: 'waiting', reason: 'Ход завершён, ждёт ответа' });
        }, quietMs);
      }
    },
    dispose,
  };
}

const plugin: PluginModule = {
  async activate(ctx) {
    const { fs, paths } = ctx.os;
    const settings = `${paths.data}/claude-hooks.json`;
    const sessions = `${paths.data}/sessions`;
    await fs.mkdir(sessions);
    const hooks = Object.fromEntries(HOOK_EVENTS.map((event) => [event, [{ ...(event === 'PostToolUse' ? { matcher: '*' } : {}), hooks: [{ type: 'command', command: HOOK_COMMAND }] }]]));
    // Инструменты сервера cyborg дали плагины, которые человек включил: вопрос о разрешении на каждый вызов был бы лишним.
    await fs.writeText(settings, JSON.stringify({ hooks, permissions: { allow: [`mcp__${MCP_SERVER}`] } }, null, 2));
    const eventsFile = (sessionId: string) => {
      if (!SESSION_ID.test(sessionId)) throw new Error(`id сессии не годится для имени файла: ${sessionId}`);
      return `${sessions}/${sessionId}.jsonl`;
    };
    const mcpFile = (sessionId: string) => `${eventsFile(sessionId).slice(0, -'.jsonl'.length)}.mcp.json`;

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
          capabilities: { resume: true, history: true, events: true },
        };
      },
      async launch(request) {
        const file = eventsFile(request.sessionId);
        await fs.writeText(file, '');
        const mcp = request.tools ? mcpFile(request.sessionId) : undefined;
        if (request.tools && mcp !== undefined) await fs.writeText(mcp, JSON.stringify(mcpConfig(request.tools.url)));
        return {
          program: '$SHELL',
          args: ['-lc', LAUNCH_SCRIPT, 'cyborg', ...claudeArgs(request, mcp)],
          cwd: request.cwd,
          env: { CYBORG_EVENTS: file, CYBORG_SETTINGS: settings, ...(request.tools && { CYBORG_MCP_TOKEN: request.tools.token }) },
        };
      },
      watch(sessionId, onEvent) {
        const quiet = waitAfterStop(onEvent, STOP_QUIET_MS);
        const listener = quiet.listener;
        const file = eventsFile(sessionId);
        const name = file.slice(sessions.length + 1);
        let consumed: number | undefined;
        let cwd: string | undefined;
        let busy = false;
        let again = false;
        let closed = false;
        const emit = (line: string) => {
          let hook: HookEvent;
          try {
            hook = JSON.parse(line) as HookEvent;
          } catch {
            return;
          }
          for (const event of translate(hook, cwd)) {
            if (event.type === 'cwd') cwd = event.cwd;
            listener(event);
          }
        };
        // Хук может дописывать строку прямо сейчас: сдвиг только до последнего полного перевода строки, хвост придёт следующим событием.
        const pull = async () => {
          if (busy) {
            again = true;
            return;
          }
          busy = true;
          try {
            for (;;) {
              if (closed) return;
              const from = consumed ?? (await fs.stat(file)).size;
              consumed = from;
              const slice = await fs.readSlice(file, from, SLICE_BYTES);
              const end = slice.text.lastIndexOf('\n') + 1;
              if (end === 0) break;
              const whole = slice.text.slice(0, end);
              consumed = from + new TextEncoder().encode(whole).length;
              for (const line of whole.split('\n')) if (line.trim()) emit(line);
              if (slice.bytes < SLICE_BYTES) break;
            }
          } catch {
            // Файл убрал ended или его ещё нет: следующее изменение попробует снова.
          } finally {
            busy = false;
            if (again) {
              again = false;
              void pull();
            }
          }
        };
        // Подписка начинается с конца файла: прошлые события уже показаны.
        const watching: Promise<Disposable | undefined> = pull().then(() =>
          fs.watch(sessions, (names) => {
            if (names.length === 0 || names.includes(name)) void pull();
          }),
        ).catch(() => undefined);
        return {
          dispose: () => {
            closed = true;
            quiet.dispose();
            void watching.then((w) => w?.dispose());
          },
        };
      },
      async ended(sessionId, exit) {
        await fs.remove(eventsFile(sessionId)).catch(() => undefined);
        await fs.remove(mcpFile(sessionId)).catch(() => undefined);
        // 127 - оболочка входа не нашла claude в своём PATH.
        return exit.code === 127 ? { kind: 'notFound', message: 'claude не найден в PATH оболочки входа' } : null;
      },
      history: (cwd) => listHistory(fs, `${paths.home}/.claude/projects`, cwd),
    };
    ctx.contracts.provide('cyborg.agent', '1.0', agent);
    return undefined;
  },
};

export default plugin;
