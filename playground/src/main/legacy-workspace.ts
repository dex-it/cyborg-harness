import type { Migrated } from '@cyborg-harness/core';
import { isRecord } from './guards.ts';

/** Поля проекта, которые знает старое приложение и которые уходят в свои места; всё остальное в записи проекта переезжает вместе с ним. */
const PROJECT_FIELDS = new Set(['id', 'name', 'description', 'repos', 'trackers', 'jira']);

/**
 * Конфиг Cyborg до плагинов (PL-06, таблица «поле - куда» - docs/05-verification/pilot-legacy-data.md):
 * `projects[]` - в `settings.projects.items` (поля `id`, `name`, `description`, `repos` и неизвестные поля проекта как есть),
 * `trackers` и `jira` проекта - в `settings.trackers.byProject`, `commands` - в `settings.command-buttons.commands`,
 * `lastProjectId` - в state `projects.lastProjectId`; запись проекта без строкового `id` (ключ для трекеров и активного проекта) не пропадает,
 * а кладётся как есть в `settings.projects.skipped`; прочие поля верхнего уровня остаются на месте.
 */
export function migrateLegacyWorkspace(doc: Record<string, unknown>): Migrated | undefined {
  if (!Array.isArray(doc.projects)) return undefined;
  const items: Record<string, unknown>[] = [];
  const skipped: unknown[] = [];
  const byProject: Record<string, unknown> = {};
  for (const p of doc.projects) {
    if (!isRecord(p) || typeof p.id !== 'string') {
      skipped.push(p);
      continue;
    }
    const hasRepos = Array.isArray(p.repos);
    const repos = Array.isArray(p.repos) ? p.repos.filter((r): r is string => typeof r === 'string') : typeof p.path === 'string' ? [p.path] : [];
    // `path` без `repos` - самый старый вид записи; он уже ушёл в `repos`, а рядом с `repos` это обычное неизвестное поле.
    const unknown = Object.fromEntries(Object.entries(p).filter(([k]) => !PROJECT_FIELDS.has(k) && (hasRepos || k !== 'path')));
    items.push({ id: p.id, name: typeof p.name === 'string' ? p.name : p.id, description: typeof p.description === 'string' ? p.description : '', repos, ...unknown });
    const trackers = { ...(isRecord(p.trackers) ? p.trackers : {}), ...(p.jira !== undefined && { jira: p.jira }) };
    if (Object.keys(trackers).length > 0) byProject[p.id] = trackers;
  }
  const { lastProjectId, commands } = doc;
  const commandsMoved = Array.isArray(commands);
  const lastMoved = typeof lastProjectId === 'string';
  const rest = Object.fromEntries(
    Object.entries(doc).filter(([k, v]) => k !== 'projects' && !(k === 'lastProjectId' && (lastMoved || v === null)) && !(k === 'commands' && commandsMoved)),
  );
  const settings = {
    ...(isRecord(rest.settings) ? rest.settings : {}),
    projects: { items, ...(skipped.length > 0 && { skipped }) },
    ...(Object.keys(byProject).length > 0 && { trackers: { byProject } }),
    ...(commandsMoved && { 'command-buttons': { commands } }),
  };
  return {
    config: { ...rest, settings },
    state: lastMoved ? { projects: { lastProjectId } } : {},
  };
}
