import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import trackersHttp, { MAX_PAGES, parseHub, projectPath } from '../plugins/trackers-http/index.ts';
import { rig, sandbox, type Rig } from './trackers-http-kit.ts';

// PL-10 (#226): трекер через HTTP API. Настоящее ядро, плагин trackers-http и пробы в хостах-процессах (forkHosts), подставной GitLab на 127.0.0.1.
// Корпоративные имена хабов (`gitlab.corp.example`) резолвятся подставным lookup в 127.0.0.1: для ядра это локальный адрес, как частный адрес Jira или GitLab за VPN.
// Сервер ведёт свой журнал (`fake.seen`) независимо от плагина: что дошло до сети, видно по нему, а не по словам плагина.

const TOKEN = 'pilot-token-Zx9-0001';
const OTHER_TOKEN = 'pilot-token-Qw7-0002';
const CORP = 'gitlab.corp.example';
const CORP2 = 'gitlab2.corp.example';
const PORTED = (name: string) => `${name}:$PORT`;
const HUB = (name: string) => `http://${name}:$PORT`;

interface Listed {
  readonly host: string;
  readonly project: string;
  readonly kind: string;
  readonly items: readonly { id: string; title: string; url: string; state: string }[];
  readonly pages: number;
  readonly truncated: boolean;
}

const list = (r: Rig, hub: string, kind: string, project: string) => r.run('trackers-http.list', r.hub(hub), kind, project) as Promise<Listed>;
const hostPort = (r: Rig, name: string) => `${name}:${String(r.fake.port)}`;

test('разбор хаба и проекта: адрес или хост, путь проекта не выходит из /api/v4/projects/', () => {
  assert.deepEqual(parseHub('https://GitLab.Corp.Example/api/v4'), { origin: 'https://gitlab.corp.example', host: 'gitlab.corp.example' });
  assert.deepEqual(parseHub('gitlab.corp.example:8443'), { origin: 'https://gitlab.corp.example:8443', host: 'gitlab.corp.example:8443' });
  assert.deepEqual(parseHub('http://localhost:3000'), { origin: 'http://localhost:3000', host: 'localhost:3000' });
  for (const bad of ['', 'ftp://x.example', 'https://u:p@x.example', 'https://', 'не адрес с пробелами']) assert.throws(() => parseHub(bad), /хаб/, bad);
  assert.equal(projectPath('group/sub/name'), 'group%2Fsub%2Fname');
  assert.equal(projectPath('42'), '42');
  for (const bad of ['', '../x', 'a/../b', 'a//b', '-flag', 'a/%2e%2e', 'a?b', 'a/b/c/d/e/f/g/h/i']) assert.throws(() => projectPath(bad), /проект/, bad);
});

test('PL-10: задачи и MR проекта по HTTP с токеном из хранилища ядра; права плагина - только net на хаб, процессов и файлов нет', async () => {
  await using box = await sandbox();
  await using r = await rig({ box, layers: { user: [HUB(CORP)] }, resolve: [CORP] });
  const manifest = JSON.parse(await readFile(path.join(import.meta.dirname, '..', 'plugins', 'trackers-http', 'manifest.json'), 'utf8')) as { permissions: unknown };
  assert.deepEqual(manifest.permissions, { net: ['config:hubs'] }, 'в манифесте только net на хаб из настройки');
  assert.deepEqual(r.k.manifests.find((m) => m.id === 'trackers-http')?.permissions, { net: ['config:hubs'] });

  r.fake.accept.set(hostPort(r, CORP), TOKEN);
  r.fake.total.set('team/app/issues', 120);
  assert.deepEqual(await r.run('trackers-http.set-token', r.hub(CORP), TOKEN), { host: hostPort(r, CORP) });

  const issues = await list(r, CORP, 'issues', 'team/app');
  assert.equal(issues.items.length, 120);
  assert.deepEqual([issues.pages, issues.truncated, issues.host, issues.kind], [2, false, hostPort(r, CORP), 'issues']);
  assert.deepEqual(issues.items[0], { id: '1', title: 'Задача 1', url: `http://${hostPort(r, CORP)}/team/app/-/issues/1`, state: 'opened' });
  const mrs = await list(r, CORP, 'merge_requests', 'team/app');
  assert.deepEqual(mrs.items.map((i) => i.title), ['MR 1', 'MR 2']);

  assert.equal(r.fake.seen.length, 3, 'две страницы задач и страница MR');
  assert.ok(r.fake.seen.every((s) => s.token === TOKEN && s.host === hostPort(r, CORP)), 'токен дошёл на свой хаб');
  assert.match(r.fake.seen[0]?.url ?? '', /^\/api\/v4\/projects\/team%2Fapp\/issues\?state=opened&per_page=100&page=1$/);
  assert.deepEqual([...r.secrets.map], [[`trackers-http/token/${hostPort(r, CORP)}`, TOKEN]], 'токен лежит в хранилище ядра под ключом хаба и больше нигде');
  assert.deepEqual(await r.run('trackers-http.hubs'), [{ host: hostPort(r, CORP), hasToken: true }]);
  assert.deepEqual(r.denied(), []);
});

test('PL-10: страниц больше предела - список помечен truncated, а не растёт без предела', async () => {
  await using box = await sandbox();
  await using r = await rig({ box, layers: { user: [HUB(CORP)] }, resolve: [CORP] });
  r.fake.accept.set(hostPort(r, CORP), TOKEN);
  r.fake.total.set('team/big/issues', (MAX_PAGES + 3) * 100);
  await r.run('trackers-http.set-token', r.hub(CORP), TOKEN);
  const big = await list(r, CORP, 'issues', 'team/big');
  assert.deepEqual([big.items.length, big.pages, big.truncated], [MAX_PAGES * 100, MAX_PAGES, true]);
  assert.equal(r.fake.seen.length, MAX_PAGES);
});

test('PL-10: несколько хабов в одной настройке hubs, токены раздельные: токен хаба не уходит на другой', async () => {
  await using box = await sandbox();
  await using r = await rig({ box, layers: { user: [HUB(CORP), PORTED(CORP2)] }, resolve: [CORP, CORP2] });
  r.fake.accept.set(hostPort(r, CORP), TOKEN);
  r.fake.accept.set(hostPort(r, CORP2), OTHER_TOKEN);
  await r.run('trackers-http.set-token', r.hub(CORP), TOKEN);
  await r.run('trackers-http.set-token', `${CORP2}:${String(r.fake.port)}`, OTHER_TOKEN);

  assert.equal((await list(r, CORP, 'issues', 'a/b')).items.length, 3);
  assert.equal((await list(r, CORP2, 'issues', 'a/b')).items.length, 3, 'хаб без схемы в настройке (хост:порт) работает по тому же порту');
  for (const s of r.fake.seen) assert.equal(s.token, s.host.startsWith(CORP2) ? OTHER_TOKEN : TOKEN, `токен на ${s.host}`);
  assert.deepEqual(await r.run('trackers-http.hubs'), [{ host: hostPort(r, CORP), hasToken: true }, { host: hostPort(r, CORP2), hasToken: true }]);

  // Токен снят у одного хаба: он отказывает до сети, второй работает.
  await r.run('trackers-http.clear-token', r.hub(CORP));
  const before = r.fake.seen.length;
  await assert.rejects(list(r, CORP, 'issues', 'a/b'), /не задан токен/);
  assert.equal(r.fake.seen.length, before, 'без токена запрос не ушёл');
  assert.equal((await list(r, CORP2, 'issues', 'a/b')).items.length, 3);
});

test('PL-10: запрос на хост вне права - PermissionDenied, запись denied, до сервера не дошёл; токен хоста не уходит', async () => {
  await using box = await sandbox();
  await using r = await rig({ box, layers: { user: [HUB(CORP)] }, resolve: [CORP, 'evil.example'] });
  r.fake.accept.set(hostPort(r, 'evil.example'), TOKEN);
  // Человек (или ошибка) задал токен хосту, которого в hubs нет: токен лежит, но сеть к этому хосту плагину не открыта.
  await r.run('trackers-http.set-token', r.hub('evil.example'), TOKEN);
  await assert.rejects(list(r, 'evil.example', 'issues', 'a/b'), { code: 'PermissionDenied', message: /хост не в net/ });
  assert.equal(r.fake.seen.length, 0, 'запрос на хост вне права не дошёл до сервера');
  const [denied, ...rest] = r.denied();
  assert.deepEqual([denied?.method, denied?.pluginId, rest.length], ['net.fetch', 'trackers-http', 0]);
  assert.match(denied?.detail ?? '', new RegExp(`хост не в net: ${hostPort(r, 'evil.example')}`));
  assert.ok(!r.everything().includes(TOKEN), 'токен не попал в журнал');
});

test('PL-10: хаб, заданный в слое пользователя, работает; заданный в файле воркспейса - нет (ADR-CH-0015)', async () => {
  await using box = await sandbox();
  await using r = await rig({ box, layers: { user: [HUB(CORP)], workspace: [HUB(CORP), HUB(CORP2)] }, resolve: [CORP, CORP2] });
  r.fake.accept.set(hostPort(r, CORP), TOKEN);
  r.fake.accept.set(hostPort(r, CORP2), TOKEN);
  await r.run('trackers-http.set-token', r.hub(CORP), TOKEN);
  await r.run('trackers-http.set-token', r.hub(CORP2), TOKEN);

  assert.equal((await list(r, CORP, 'issues', 'a/b')).items.length, 3, 'хаб из слоя пользователя');
  await assert.rejects(list(r, CORP2, 'issues', 'a/b'), { code: 'PermissionDenied', message: /хост не в net/ });
  assert.deepEqual(r.fake.seen.map((s) => s.host), [hostPort(r, CORP)], 'хаб из файла воркспейса до сервера не дошёл, хотя плагин его видит и токен для него есть');
  const [denied] = r.denied();
  assert.match(denied?.detail ?? '', /config:hubs задан в файле воркспейса, а хосты из настройки берутся только из файла пользователя/);

  // Плагин видит слитую настройку; список «hubs» это показывает, ядро права по нему не выдаёт.
  assert.deepEqual((await r.run('trackers-http.hubs') as { host: string }[]).map((h) => h.host), [hostPort(r, CORP), hostPort(r, CORP2)]);
});

test('PL-10, У-35: частный адрес корпоративного хаба открывает только имя, названное человеком в config; тот же хост в манифесте другого плагина и пустая настройка - отказ', async () => {
  await using box = await sandbox();
  await using r = await rig({
    box,
    layers: { user: [HUB(CORP)] },
    resolve: [CORP],
    probes: [
      // Автор плагина записал внутренний хост именем в манифесте: ядро частную сеть по такой записи не открывает.
      { id: 'fixed', permissions: { net: [PORTED(CORP)] } },
      // Плагин с тем же правом `config:hubs`, но человек в его настройке ничего не назвал.
      { id: 'bare', config: true, permissions: { net: ['config:hubs'] } },
    ],
  });
  r.fake.accept.set(hostPort(r, CORP), TOKEN);
  await r.run('trackers-http.set-token', r.hub(CORP), TOKEN);
  assert.equal((await list(r, CORP, 'issues', 'a/b')).items.length, 3, 'имя хаба резолвится в локальный адрес, и плагин с хабом от человека его получает');
  const reached = r.fake.seen.length;

  await assert.rejects(r.run('fixed.get', `${r.hub(CORP)}/api/v4/projects/a%2Fb/issues?page=1`), { code: 'PermissionDenied', message: /адрес 127\.0\.0\.1 локальный/ });
  await assert.rejects(r.run('bare.get', `${r.hub(CORP)}/api/v4/projects/a%2Fb/issues?page=1`), { code: 'PermissionDenied', message: /хост не в net/ });
  assert.equal(r.fake.seen.length, reached, 'чужие плагины до локального сервера не дошли');
  const reasons = r.denied().map((e) => `${e.pluginId}: ${e.detail}`);
  assert.ok(reasons.some((x) => x.startsWith('fixed:') && x.includes('адрес 127.0.0.1 локальный')), reasons.join('\n'));
  assert.ok(reasons.some((x) => x.startsWith('bare:') && x.includes('хост не в net')), reasons.join('\n'));
});

test('PL-10: токен вводит человек; плагин другого автора команду ввода не вызовет, токен не попадает в журнал, строки плагина, трассу и слои config', async () => {
  await using box = await sandbox();
  await using r = await rig({ box, layers: { user: [HUB(CORP)] }, resolve: [CORP], probes: [{ id: 'snoop' }] });
  r.fake.accept.set(hostPort(r, CORP), TOKEN);

  // Отказ при отсутствии токена: запрос не уходит.
  await assert.rejects(list(r, CORP, 'issues', 'a/b'), new RegExp(`для ${hostPort(r, CORP).replace('.', '\\.')} не задан токен`));
  assert.equal(r.fake.seen.length, 0);

  // Ввод: команда для человека (палитра, вид); главная часть другого плагина получает отказ ядра.
  await assert.rejects(r.run('snoop.run', 'trackers-http.set-token', r.hub(CORP), TOKEN), { code: 'PermissionDenied', message: /не открыл команду другим плагинам/ });
  assert.equal(r.secrets.map.size, 0, 'чужой плагин токен не записал');
  for (const bad of ['', 'с пробелом токен', 'a\nb', 'x'.repeat(5000)]) await assert.rejects(r.run('trackers-http.set-token', r.hub(CORP), bad), /токен - печатные символы/, JSON.stringify(bad).slice(0, 20));
  await r.run('trackers-http.set-token', r.hub(CORP), OTHER_TOKEN);
  r.fake.accept.set(hostPort(r, CORP), TOKEN);
  await assert.rejects(list(r, CORP, 'issues', 'a/b'), /отвергает токен \(401\)/);
  await r.run('trackers-http.set-token', r.hub(CORP), TOKEN);

  // Сервер, который в ответе об ошибке повторяет присланный токен (прокси так делают): строка плагина с телом ответа идёт через вычёркивание ядра.
  r.fake.echo = true;
  await r.run('trackers-http.set-token', r.hub(CORP), OTHER_TOKEN);
  await assert.rejects(list(r, CORP, 'issues', 'a/b'), /отвергает токен/);
  assert.ok(r.logs.some((l) => l.includes('401 Unauthorized: token [секрет]')), `строка плагина с вычеркнутым токеном: ${r.logs.join(' | ')}`);
  r.fake.echo = false;
  await r.run('trackers-http.set-token', r.hub(CORP), TOKEN);
  assert.equal((await list(r, CORP, 'issues', 'a/b')).items.length, 3);

  const everything = r.everything();
  assert.ok(r.traces.some((t) => t.kind === 'operation' && JSON.stringify(t).includes('net.fetch')), 'трасса net.fetch есть - проверять есть что');
  assert.ok(r.journal.length > 0 && r.logs.length > 0, 'журнал и строки плагина не пусты - проверять есть что');
  for (const secret of [TOKEN, OTHER_TOKEN]) assert.ok(!everything.includes(secret), `значение токена просочилось: ${secret}`);
  assert.ok([...r.docs.values()].every((doc) => !JSON.stringify(doc).includes('pilot-token')), 'слои config токена не содержат');
});

test('PL-10: сервер отвечает ошибкой или переадресацией - плагин сообщает код, переадресацию не выполняет, токен на другой хост не уходит', async () => {
  await using box = await sandbox();
  await using r = await rig({ box, layers: { user: [HUB(CORP)] }, resolve: [CORP] });
  r.fake.accept.set(hostPort(r, CORP), TOKEN);
  await r.run('trackers-http.set-token', r.hub(CORP), TOKEN);
  await assert.rejects(list(r, CORP, 'issues', 'moved/away'), /ответил 302/);
  await assert.rejects(list(r, CORP, 'issues', 'broken/one'), /ответил 500/);
  assert.equal(r.fake.seen.length, 2, 'по запросу на каждый вызов, переходов нет');
  assert.ok(r.fake.seen.every((s) => s.host === hostPort(r, CORP)));
  await assert.rejects(r.run('trackers-http.list', r.hub(CORP), 'wikis', 'a/b'), /вид - issues или merge_requests/);
  await assert.rejects(r.run('trackers-http.list', r.hub(CORP), 'issues', '../../etc'), /проект/);
  assert.equal(r.fake.seen.length, 2, 'неверные аргументы отказаны до сети');
});

test('PL-10: конфигурация плагина - hubs список строк; иное отвергается проверкой раздела', () => {
  const validate = trackersHttp.config?.validate;
  assert.ok(validate);
  assert.deepEqual(validate({ hubs: ['a.example', 'https://b.example'] }), []);
  assert.deepEqual(validate({ hubs: [] }), []);
  for (const bad of [{ hubs: 'a.example' }, { hubs: [1] }, {}]) assert.equal(validate(bad).length, 1, JSON.stringify(bad));
});
