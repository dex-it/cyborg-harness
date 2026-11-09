// Вид editor (PL-05): Monaco во фрейме на cyborg-plugin://. Файл отдаёт главная часть командами, схему настроек проверяет она же, вид показывает её ответ маркерами.

import type { Disposable, ThemeTokens, UiContext, UiModule } from '@cyborg-harness/contracts';
import * as monaco from 'monaco-editor/editor/editor.main.js';

interface Problem {
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props);
}

const LANGUAGES: Readonly<Record<string, string>> = { '.json': 'json', '.ts': 'typescript' };
/** Метка воркера Monaco -> собранный файл рядом с модулем вида (playground/scripts/build.mjs). */
const WORKERS: Readonly<Record<string, string>> = { json: 'json', css: 'css', scss: 'css', less: 'css', html: 'html', handlebars: 'html', razor: 'html', typescript: 'ts', javascript: 'ts' };

// Нарушения CSP документа вида: воркеры, шрифты и стили Monaco упёрлись бы в них молча, поэтому они копятся для проверки.
const violations: string[] = [];
document.addEventListener('securitypolicyviolation', (event) => violations.push(`${event.violatedDirective} ${event.blockedURI}`));

const started: string[] = [];
globalThis.MonacoEnvironment = {
  // Воркер - файл того же origin: `blob:` CSP вида не пустила бы, а так хватает `worker-src 'self'`.
  getWorker: (_id, label) => {
    const file = WORKERS[label] ?? 'editor';
    started.push(file);
    return new Worker(new URL(`./workers/${file}.worker.js`, import.meta.url));
  },
};

const scheme = (tokens: ThemeTokens) => (tokens['--cy-scheme'] === 'dark' ? 'vs-dark' : 'vs');

export function mount(root: HTMLElement, ctx: UiContext): Disposable {
  // Время от начала навигации фрейма: модуль (разбор и выполнение бандла) готов; первый файл нарисован - в openedMs.
  root.dataset.mountMs = String(Math.round(performance.now()));
  const files = el('div', { id: 'files', className: 'files' });
  const status = el('span', { id: 'editor-state', className: 'state', textContent: 'файл не открыт' });
  const save = el('cy-button', { id: 'save', textContent: 'Сохранить' });
  save.setAttribute('variant', 'primary');
  const header = el('header');
  header.append(el('strong', { textContent: 'Редактор' }), files, status, save);
  const host = el('div', { id: 'monaco', className: 'monaco-host' });
  const problems = el('ul', { id: 'problems', className: 'problems' });
  const sheet = (href: string) => el('link', { rel: 'stylesheet', href: new URL(href, import.meta.url).href });
  // ui.css - таблица Monaco, собранная вместе с модулем; view.css - раскладка вида.
  root.append(sheet('./ui.css'), sheet('./view.css'), header, host, problems);

  const editor = monaco.editor.create(host, { automaticLayout: true, minimap: { enabled: false }, fontFamily: ctx.theme.tokens['--cy-font-mono'] ?? 'monospace', fontSize: 13, theme: scheme(ctx.theme.tokens), scrollBeyondLastLine: false });
  const themed = ctx.theme.onChange((tokens) => monaco.editor.setTheme(scheme(tokens)));
  let current: string | undefined;
  let saved = '';
  let checking = 0;

  const state = (text: string) => (status.textContent = text);
  const failed = (error: unknown) => state(`отказ: ${error instanceof Error ? error.message : String(error)}`);
  // Метки состояния для проверок снаружи: какие воркеры подняты, нарушения CSP, маркеры (json - из воркера, owner - от владельца), время открытия.
  const report = () => {
    root.dataset.workers = started.join(',');
    root.dataset.violations = violations.join('; ');
    root.dataset.markers = monaco.editor
      .getModelMarkers({})
      .map((m) => `${m.owner}:${String(m.startLineNumber)}:${m.message}`)
      .join('; ');
  };
  const show = (list: readonly Problem[]) => {
    const model = editor.getModel();
    if (!model) return;
    monaco.editor.setModelMarkers(
      model,
      'owner',
      list.map((p) => ({ severity: monaco.MarkerSeverity.Error, message: p.message, startLineNumber: p.line, startColumn: p.column, endLineNumber: p.line, endColumn: model.getLineMaxColumn(p.line) })),
    );
    problems.replaceChildren(...list.map((p) => el('li', { textContent: `${String(p.line)}:${String(p.column)} ${p.message}` })));
  };
  const check = async () => {
    const generation = ++checking;
    if (current === undefined) return;
    const answer = (await ctx.commands.run('editor.check', current, editor.getValue())) as Problem[];
    if (generation === checking) show(answer);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const changed = editor.onDidChangeModelContent(() => {
    // Ответ проверки на прежний текст несёт строки, которых в новом тексте может не быть.
    checking++;
    state(editor.getValue() === saved ? `${current ?? ''}: сохранён` : `${current ?? ''}: изменён`);
    clearTimeout(timer);
    timer = setTimeout(() => void check().catch(failed), 150);
  });
  const open = async (name: string) => {
    const text = (await ctx.commands.run('editor.open', name)) as string;
    current = name;
    saved = text;
    const old = editor.getModel();
    const extension = name.slice(name.lastIndexOf('.'));
    const uri = monaco.Uri.parse(`cyborg-plugin://${ctx.pluginId}/files/${name}`);
    // Модель с тем же адресом уже есть, если файл открыт: createModel на неё бросает.
    const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(text, LANGUAGES[extension], uri);
    model.setValue(text);
    editor.setModel(model);
    if (old !== model) old?.dispose();
    state(`${name}: открыт`);
    report();
    if (root.dataset.openedMs === undefined) requestAnimationFrame(() => requestAnimationFrame(() => (root.dataset.openedMs = String(Math.round(performance.now())))));
    await check();
  };
  save.addEventListener('click', () => {
    const name = current;
    if (name === undefined) return;
    const text = editor.getValue();
    void ctx.commands
      .run('editor.save', name, text)
      .then(() => {
        saved = text;
        state(`${name}: сохранён`);
      })
      .catch(failed);
  });
  void (async () => {
    const names = (await ctx.commands.run('editor.files')) as string[];
    files.replaceChildren(
      ...names.map((name) => {
        const b = el('cy-button', { textContent: name });
        b.dataset.file = name;
        b.addEventListener('click', () => void open(name).catch(failed));
        return b;
      }),
    );
    const first = names[0];
    if (first !== undefined) await open(first);
  })().catch(failed);
  // Воркеры поднимаются позже открытия файла: метки обновляются, пока вид жив.
  const tick = setInterval(report, 250);
  return {
    dispose: () => {
      clearInterval(tick);
      clearTimeout(timer);
      changed.dispose();
      themed.dispose();
      editor.getModel()?.dispose();
      editor.dispose();
    },
  };
}

mount satisfies UiModule<HTMLElement>['mount'];
