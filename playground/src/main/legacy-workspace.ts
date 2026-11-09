import type { Migrated } from '@cyborg-harness/core';
import { isRecord } from '@cyborg-harness/core';

/** Конфиг Cyborg до плагинов `{projects, lastProjectId}`: проекты и трекеры - в разделы плагинов, активный проект - в state. */
export function migrateLegacyWorkspace(doc: Record<string, unknown>): Migrated | undefined {
  if (!Array.isArray(doc.projects)) return undefined;
  const items: Record<string, unknown>[] = [];
  const byProject: Record<string, unknown> = {};
  for (const p of doc.projects) {
    if (!isRecord(p) || typeof p.id !== 'string') continue;
    const repos = Array.isArray(p.repos) ? p.repos.filter((r): r is string => typeof r === 'string') : typeof p.path === 'string' ? [p.path] : [];
    items.push({ id: p.id, name: typeof p.name === 'string' ? p.name : p.id, description: typeof p.description === 'string' ? p.description : '', repos });
    const trackers = { ...(isRecord(p.trackers) ? p.trackers : {}), ...(p.jira !== undefined && { jira: p.jira }) };
    if (Object.keys(trackers).length > 0) byProject[p.id] = trackers;
  }
  const { lastProjectId } = doc;
  const rest = Object.fromEntries(Object.entries(doc).filter(([k]) => k !== 'projects' && k !== 'lastProjectId'));
  const settings = { ...(isRecord(rest.settings) ? rest.settings : {}), projects: { items }, ...(Object.keys(byProject).length > 0 && { trackers: { byProject } }) };
  return {
    config: { ...rest, settings },
    state: typeof lastProjectId === 'string' ? { projects: { lastProjectId } } : {},
  };
}
