// Спайк UI во фреймах (SAD, открытый вопрос 11); итог - JSON в `--spike=<файл>`, печатает его scripts/spike-iframe.mjs.

import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { app, BrowserWindow, ipcMain, type WebFrameMain } from 'electron';
import type { SpikePing, SpikeReport } from '../shared/spike.ts';
import { PATH_MIME, viewOrigin } from '@cyborg-harness/electron/window';
import { pssKb as pss } from './proc-memory.ts';
import { framesOf, resolveStaticFile, serveViews } from '@cyborg-harness/electron';

export interface SpikeOptions {
  readonly out: string;
  readonly preload: string;
  readonly rendererDir: string;
}

export interface MemoryRow {
  readonly frames: number;
  readonly origins: 'distinct' | 'shared';
  /** От вставки фреймов до события load последнего. */
  readonly mountMs: number;
  readonly processes: number;
  readonly renderers: number;
  /** Сколько разных процессов рендера у самих фреймов, без документа окна. */
  readonly frameProcesses: number;
  /** Сумма workingSetSize всех процессов приложения; на Linux завышена общими страницами. */
  readonly workingSetMb: number;
  /** Сумма PSS всех процессов: общие страницы поделены между ними. На macOS - сумма footprint, другая мера. */
  readonly pssMb?: number;
}

export interface LatencyRow {
  readonly path: string;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  /** Поток 4 МиБ кусками по 4 КиБ, как вывод терминала: до ответа на последний кусок. */
  readonly streamMs: number;
  readonly streamMbps: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const round = (value: number, digits = 2) => Number(value.toFixed(digits));
const PINGS = 300;
const CHUNK = 'x'.repeat(4096);
const CHUNKS = 1024;
const MODIFIERS = new Set(['Control', 'Shift', 'Alt', 'Meta']);

function probeUrl(index: number, origins: MemoryRow['origins']): string {
  return origins === 'shared' ? `${viewOrigin('probe')}/?i=${index}` : `${viewOrigin(`probe-${index}`)}/`;
}

/** Ответы фреймов и окна на ping по номеру. */
class Pongs {
  private readonly waiting = new Map<number, () => void>();
  private seq = 0;

  constructor() {
    ipcMain.on('spike:pong', (_event, n: number) => {
      this.waiting.get(n)?.();
      this.waiting.delete(n);
    });
  }

  next(): { n: number; done: Promise<void> } {
    const n = ++this.seq;
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`нет ответа на ping ${n}`)), 10_000);
      this.waiting.set(n, () => {
        clearTimeout(timer);
        resolve();
      });
    });
    return { n, done };
  }
}

interface Point {
  x: number;
  y: number;
}

export interface KeysRow {
  readonly input: 'synthetic' | 'xtest';
  readonly focusInFrame: boolean;
  /** Что увидел главный процесс; Ctrl+Shift+K он гасит. */
  readonly beforeInputEvent: readonly string[];
  /** Что дошло до keydown внутри фрейма. */
  readonly frameKeydown: readonly string[];
  readonly typed: string;
}

export interface RealDragRow {
  /** `html5` - DataTransfer страницы, `kernel` - startDrag главного процесса по просьбе вида. */
  readonly how: 'html5' | 'kernel';
  readonly dragstartIn: string | null;
  readonly dropIn: string | null;
  readonly dropTypes: readonly string[] | null;
  readonly dropPath: string | null;
  /** Плагин-источник, названный ядром; у html5 его нет. */
  readonly dropFrom: string | null;
}

class Spike {
  private readonly reports: (SpikeReport & { origin: string })[] = [];
  private readonly pongs = new Pongs();
  private readonly options: SpikeOptions;

  constructor(options: SpikeOptions) {
    this.options = options;
    ipcMain.on('spike:report', (event, report: SpikeReport) => this.reports.push({ ...report, origin: event.senderFrame?.origin ?? '' }));
  }

  private async open(urls: readonly string[]): Promise<{ win: BrowserWindow; mountMs: number }> {
    const win = new BrowserWindow({
      width: 1200,
      height: 800,
      webPreferences: { preload: this.options.preload, contextIsolation: true, sandbox: true, nodeIntegrationInSubFrames: true },
    });
    await win.loadFile(path.join(this.options.rendererDir, 'spike.html'));
    const mountMs = (await win.webContents.executeJavaScript(`mountFrames(${JSON.stringify(urls)})`)) as number;
    return { win, mountMs };
  }

  private frame(win: BrowserWindow, pluginId: string): WebFrameMain {
    const frame = framesOf(win.webContents, viewOrigin(pluginId))[0];
    if (!frame) throw new Error(`нет фрейма ${pluginId}`);
    return frame;
  }

  async memory(frames: number, origins: MemoryRow['origins']): Promise<MemoryRow> {
    const { win, mountMs } = await this.open(Array.from({ length: frames }, (_, i) => probeUrl(i, origins)));
    // Процессы фреймов дорастают после load: скрипт, стили, первая отрисовка.
    await sleep(2500);
    const top = win.webContents.getOSProcessId();
    const framePids = new Set(win.webContents.mainFrame.frames.map((f) => f.osProcessId).filter((pid) => pid !== top));
    const metrics = app.getAppMetrics();
    const pssKb = metrics.map((m) => pss(m.pid));
    win.destroy();
    await sleep(1500);
    return {
      frames,
      origins,
      mountMs: round(mountMs, 1),
      processes: metrics.length,
      renderers: metrics.filter((m) => m.type === 'Tab').length,
      frameProcesses: framePids.size,
      workingSetMb: round(metrics.reduce((sum, m) => sum + m.memory.workingSetSize, 0) / 1024, 1),
      ...(pssKb.every((kb) => kb !== undefined) && { pssMb: round(pssKb.reduce((sum, kb) => sum + kb, 0) / 1024, 1) }),
    };
  }

  private async measure(name: string, send: (ping: SpikePing) => void): Promise<LatencyRow> {
    const roundTrip = async () => {
      const { n, done } = this.pongs.next();
      const start = process.hrtime.bigint();
      send({ n, ack: true });
      await done;
      return Number(process.hrtime.bigint() - start) / 1e6;
    };
    for (let i = 0; i < 30; i++) await roundTrip();
    const times: number[] = [];
    for (let i = 0; i < PINGS; i++) times.push(await roundTrip());
    times.sort((a, b) => a - b);
    const at = (q: number) => round(times[Math.min(times.length - 1, Math.floor(q * times.length))] ?? NaN, 3);

    const start = process.hrtime.bigint();
    const last = this.pongs.next();
    for (let i = 0; i < CHUNKS; i++) send({ n: i === CHUNKS - 1 ? last.n : 0, ack: i === CHUNKS - 1, data: CHUNK });
    await last.done;
    const streamMs = Number(process.hrtime.bigint() - start) / 1e6;
    return { path: name, p50: at(0.5), p95: at(0.95), p99: at(0.99), streamMs: round(streamMs, 1), streamMbps: round((CHUNKS * CHUNK.length) / 1e6 / (streamMs / 1000), 1) };
  }

  async latency(): Promise<LatencyRow[]> {
    const { win } = await this.open([probeUrl(0, 'distinct')]);
    const frame = this.frame(win, 'probe-0');
    const rows = [
      await this.measure('окно: webContents.send', (ping) => win.webContents.send('spike:ping', ping)),
      await this.measure('фрейм: preload, frame.send', (ping) => frame.send('spike:ping', ping)),
      await this.measure('фрейм: postMessage через окно', (ping) => win.webContents.send('spike:relay', 0, ping)),
    ];
    win.destroy();
    return rows;
  }

  /** Центр элемента фрейма в координатах окна: фреймы не знают, где они в окне. */
  private async point(win: BrowserWindow, index: number, frame: WebFrameMain, selector: string): Promise<Point> {
    const origin = (await win.webContents.executeJavaScript(`frameRect(${index})`)) as Point;
    const inner = (await frame.executeJavaScript(
      `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
    )) as Point;
    return { x: Math.round(origin.x + inner.x), y: Math.round(origin.y + inner.y) };
  }

  /** Клавиши при фокусе в поле фрейма; `xtest` - внешняя команда настоящего ввода X11, без неё только синтетический. */
  async keys(input: 'synthetic' | 'xtest', xtest?: readonly string[]): Promise<KeysRow> {
    const { win } = await this.open([probeUrl(0, 'distinct')]);
    const frame = this.frame(win, 'probe-0');
    const seen: string[] = [];
    win.webContents.on('before-input-event', (event, key) => {
      if (key.type !== 'keyDown' || MODIFIERS.has(key.key)) return;
      seen.push(`${key.control ? 'Ctrl+' : ''}${key.shift ? 'Shift+' : ''}${key.key}`);
      if (key.control && key.shift && key.key.toLowerCase() === 'k') event.preventDefault();
    });
    win.focus();
    win.webContents.focus();
    const field = await this.point(win, 0, frame, '#field');
    if (input === 'xtest' && xtest) {
      const bounds = win.getContentBounds();
      execFileSync(xtest[0] ?? '', [...xtest.slice(1), 'click', String(bounds.x + field.x), String(bounds.y + field.y)]);
    } else {
      // sendInputEvent шлёт в виджет окна, а не во фрейм: фокус ставится скриптом, если щелчок его не донёс.
      win.webContents.sendInputEvent({ type: 'mouseDown', x: field.x, y: field.y, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x: field.x, y: field.y, button: 'left', clickCount: 1 });
      await sleep(300);
      await frame.executeJavaScript(`document.getElementById('field').focus()`);
    }
    await sleep(300);
    const focusInFrame = (await frame.executeJavaScript(`document.hasFocus() && document.activeElement?.id === 'field'`)) as boolean;
    seen.length = 0;
    this.reports.length = 0;
    if (input === 'xtest' && xtest) execFileSync(xtest[0] ?? '', [...xtest.slice(1), 'keys', 'x', 'ctrl+shift+k', 'y']);
    else {
      for (const [keyCode, modifiers] of [['x', []], ['K', ['control', 'shift']], ['y', []]] as const) {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers: [...modifiers] });
        if (modifiers.length === 0) win.webContents.sendInputEvent({ type: 'char', keyCode });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers: [...modifiers] });
      }
    }
    await sleep(500);
    const frameKeydown = this.reports.flatMap((r) => (r.kind === 'key' && !MODIFIERS.has(r.key) && r.origin === viewOrigin('probe-0') ? [`${r.ctrl ? 'Ctrl+' : ''}${r.shift ? 'Shift+' : ''}${r.key}`] : []));
    const typed = (await frame.executeJavaScript(`document.getElementById('field').value`)) as string;
    win.destroy();
    return { input, focusInFrame, beforeInputEvent: [...seen], frameKeydown, typed };
  }

  async drag(): Promise<Record<string, unknown>> {
    const { win } = await this.open([probeUrl(0, 'distinct'), probeUrl(1, 'distinct')]);
    const source = this.frame(win, 'probe-0');
    const target = this.frame(win, 'probe-1');
    const from = await this.point(win, 0, source, '#drag');
    const to = await this.point(win, 1, target, '#drop');
    this.reports.length = 0;
    const dbg = win.webContents.debugger;
    dbg.attach('1.3');
    let data: { items?: { mimeType: string }[] } | undefined;
    dbg.on('message', (_event, method, params: { data?: typeof data }) => {
      if (method === 'Input.dragIntercepted') data = params.data;
    });
    // Без перехвата Chromium отдаёт перетаскивание оконной системе, и в xvfb оно не завершится.
    await dbg.sendCommand('Input.setInterceptDrags', { enabled: true });
    const mouse = (type: string, at: Point, buttons: number) => dbg.sendCommand('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', buttons, clickCount: 1 });
    await mouse('mouseMoved', from, 0);
    await mouse('mousePressed', from, 1);
    for (let step = 1; step <= 10; step++) await mouse('mouseMoved', { x: from.x + step * 8, y: from.y + step * 3 }, 1);
    for (let i = 0; i < 20 && !data; i++) await sleep(100);
    if (data) for (const type of ['dragEnter', 'dragOver', 'drop']) await dbg.sendCommand('Input.dispatchDragEvent', { type, x: to.x, y: to.y, data });
    await mouse('mouseReleased', to, 0);
    for (let i = 0; i < 20 && !this.reports.some((r) => r.kind === 'drop'); i++) await sleep(100);
    dbg.detach();
    const drop = this.reports.find((r) => r.kind === 'drop');
    win.destroy();
    return {
      dragstartIn: this.reports.find((r) => r.kind === 'dragstart')?.origin ?? null,
      dragMimeTypes: data?.items?.map((i) => i.mimeType) ?? null,
      dropIn: drop?.origin ?? null,
      dropTypes: drop?.kind === 'drop' ? drop.types : null,
      dropPath: drop?.kind === 'drop' ? drop.path : null,
      expectedMime: PATH_MIME,
    };
  }

  /** Настоящее перетаскивание X11 из probe-0 в probe-1: CDP в drag() обходит проверку Chromium, которую проходит живая мышь. */
  async realDrag(how: RealDragRow['how'], xtest: readonly string[]): Promise<RealDragRow> {
    const { win } = await this.open([probeUrl(0, 'distinct'), probeUrl(1, 'distinct')]);
    win.focus();
    const from = await this.point(win, 0, this.frame(win, 'probe-0'), how === 'html5' ? '#drag' : '#kdrag');
    const to = await this.point(win, 1, this.frame(win, 'probe-1'), '#drop');
    const bounds = win.getContentBounds();
    this.reports.length = 0;
    // Синхронный запуск держал бы главный процесс, и startDrag ядра начался бы уже после отпускания кнопки.
    await promisify(execFile)(xtest[0] ?? '', [...xtest.slice(1), 'drag', ...[bounds.x + from.x, bounds.y + from.y, bounds.x + to.x, bounds.y + to.y].map(String)]);
    for (let i = 0; i < 20 && !this.reports.some((r) => r.kind === 'drop'); i++) await sleep(100);
    const drop = this.reports.find((r) => r.kind === 'drop');
    win.destroy();
    return {
      how,
      dragstartIn: this.reports.find((r) => r.kind === 'dragstart')?.origin ?? null,
      dropIn: drop?.origin ?? null,
      dropTypes: drop?.kind === 'drop' ? drop.types : null,
      dropPath: drop?.kind === 'drop' ? drop.path : null,
      dropFrom: drop?.kind === 'drop' ? drop.from : null,
    };
  }
}

export async function runSpike(options: SpikeOptions): Promise<void> {
  serveViews((url) => resolveStaticFile(url, (id) => (/^probe(?:-\d+)?$/.test(id) ? path.join(options.rendererDir, 'probe') : undefined)), path.join(options.rendererDir, 'shell'));
  const spike = new Spike(options);
  const result: Record<string, unknown> = {
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  };
  try {
    const memory: MemoryRow[] = [];
    for (const [frames, origins] of [[0, 'distinct'], [1, 'distinct'], [2, 'distinct'], [5, 'distinct'], [10, 'distinct'], [2, 'shared'], [10, 'shared']] as const) {
      memory.push(await spike.memory(frames, origins));
    }
    result.memory = memory;
    result.latency = await spike.latency();
    const xtest = process.env.CYBORG_SPIKE_XTEST?.split(' ').filter(Boolean);
    result.keys = [await spike.keys('synthetic'), ...(xtest?.length ? [await spike.keys('xtest', xtest)] : [])];
    result.drag = await spike.drag();
    if (xtest?.length) result.realDrag = [await spike.realDrag('html5', xtest), await spike.realDrag('kernel', xtest)];
  } catch (error) {
    result.error = (error as Error).stack ?? String(error);
    process.exitCode = 1;
  }
  fs.writeFileSync(options.out, JSON.stringify(result, null, 2));
}
