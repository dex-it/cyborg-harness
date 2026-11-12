// Ручная проверка пилота PL-10 (#226) на настоящем GitLab: настоящее ядро, плагин trackers-http в хосте-процессе, настоящая сеть, DNS и TLS.
// Запуск: GITLAB_TOKEN=<токен> npm run pilot:trackers-http -- <хаб> <проект> [issues|merge_requests]
//   хаб - адрес или хост, как человек вписал бы его в настройку hubs (https://gitlab.com, gitlab.corp.example:8443); проект - группа/имя или числовой id.
// Токен берётся только из переменной окружения (не из аргументов: их видно в списке процессов) и нигде не печатается. Хранилище секретов в памяти: на диск ничего не пишется.
// Проверяет: список приходит (число записей, первые заголовки), хост вне настройки получает PermissionDenied, без токена запрос не уходит, токена нет в журнале и строках плагина.
import { forkHosts, load, PLUGIN_API_VERSION, SectionStore } from '@cyborg-harness/core';
import { memorySecrets, memoryStore } from '@cyborg-harness/testing';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [hub, project, kind = 'issues'] = process.argv.slice(2);
const token = process.env.GITLAB_TOKEN;
if (hub === undefined || project === undefined || !['issues', 'merge_requests'].includes(kind)) {
  console.error('Запуск: GITLAB_TOKEN=<токен> npm run pilot:trackers-http -- <хаб> <проект> [issues|merge_requests]');
  process.exit(2);
}
if (token === undefined || token === '') {
  console.error('Нет GITLAB_TOKEN в окружении: токен с правом read_api передаётся только так.');
  process.exit(2);
}

const plugins = path.join(import.meta.dirname, '..', 'plugins');
const manifest = JSON.parse(await readFile(path.join(plugins, 'trackers-http', 'manifest.json'), 'utf8'));
const secrets = memorySecrets();
const store = memoryStore({ user: { 'trackers-http': { $version: 1, hubs: [hub] } } });
const config = await SectionStore.open(store.store, ['user', 'workspace']);
const journal = [];
const logs = [];
const t0 = Date.now();
const k = await load({
  apiVersion: PLUGIN_API_VERSION,
  enabled: ['trackers-http'],
  manifests: [manifest],
  hosts: { 'trackers-http': ['trackers-http'] },
  spawnHost: forkHosts({ silent: true }),
  entry: () => pathToFileURL(path.join(plugins, 'trackers-http', 'index.ts')).href,
  os: { dataDir: path.join(process.env.TMPDIR ?? '/tmp', 'pilot-trackers-http-data'), tempDir: path.join(process.env.TMPDIR ?? '/tmp', 'pilot-trackers-http-temp'), secrets },
  config,
  onJournal: (e) => void journal.push(e),
  onLog: (id, message) => void logs.push(`${id}: ${message}`),
});

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : ` - ${detail}`}`);
  if (!ok) failed++;
};
try {
  // 1. Без токена запрос не уходит.
  const noToken = await k.run('trackers-http.list', hub, kind, project).then(() => undefined, (e) => e);
  check('без токена: отказ до сети', noToken instanceof Error && /не задан токен/.test(noToken.message), noToken?.message);

  // 2. Ввод токена (как это делает человек в виде) и список.
  await k.run('trackers-http.set-token', hub, token);
  const listing = await k.run('trackers-http.list', hub, kind, project).then((v) => ({ v }), (e) => ({ e }));
  if ('e' in listing) check('список с токеном', false, listing.e.message);
  else {
    const { items, pages, truncated, host } = listing.v;
    check('список с токеном', true, `${host}: ${String(items.length)} записей (${kind}), страниц ${String(pages)}${truncated ? ', список обрезан пределом страниц' : ''}`);
    for (const item of items.slice(0, 3)) console.log(`       !${item.id} ${item.title} [${item.state}] ${item.url}`);
  }

  // 3. Хост вне настройки: право net его не открывает.
  const stranger = 'https://example.org';
  await k.run('trackers-http.set-token', stranger, token);
  const outside = await k.run('trackers-http.list', stranger, kind, project).then(() => undefined, (e) => e);
  check('хост вне hubs: PermissionDenied', outside?.code === 'PermissionDenied', outside?.message);
  await k.run('trackers-http.clear-token', stranger);

  // 4. Токена нет ни в журнале, ни в строках плагина.
  const written = JSON.stringify(journal) + JSON.stringify(k.journal) + logs.join('\n') + JSON.stringify([...store.docs]);
  check('токена нет в журнале, строках плагина и слоях config', !written.includes(token));
  console.log(`всего ${String(Date.now() - t0)} мс; отказов в журнале ядра: ${String(k.journal.filter((e) => e.kind === 'denied').length)}`);
} finally {
  await k.unload();
}
process.exitCode = failed === 0 ? 0 : 1;
