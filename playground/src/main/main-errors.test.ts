import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createErrorReporter, describeError, formatErrorEntry, type ErrorNotice } from './main-errors.ts';

/** Элемент, который обязан быть: пустая ячейка - провал теста, а не `undefined` дальше по коду. */
function item<T>(list: readonly T[], index: number): T {
  const value = list[index];
  assert.ok(value !== undefined, `в списке нет элемента ${String(index)}`);
  return value;
}

const at = new Date('2026-11-10T12:00:00.000Z');

test('describeError: ошибка со стеком даёт стек целиком, причина (cause) тоже', () => {
  const inner = new Error('нижняя');
  const outer = new Error('верхняя', { cause: inner });
  const text = describeError(outer);
  assert.match(text, /Error: верхняя/);
  assert.match(text, /Caused by: .*нижняя/s);
  assert.ok(text.includes(String(outer.stack)), 'стек не обрезан');
});

test('describeError: не-ошибки (строка, объект, undefined) не теряются', () => {
  assert.equal(describeError('просто строка'), 'просто строка');
  assert.match(describeError({ code: 7 }), /"code": 7/);
  assert.equal(describeError(undefined), 'undefined');
  const loop: Record<string, unknown> = {};
  loop.self = loop;
  assert.match(describeError(loop), /\[object Object\]|Circular/);
});

test('formatErrorEntry: время, вид и полный текст в одной записи', () => {
  const entry = formatErrorEntry('unhandledRejection', new Error('сбой'), at);
  assert.match(entry, /^\[2026-11-10T12:00:00\.000Z\] unhandledRejection\n/);
  assert.match(entry, /Error: сбой/);
  assert.ok(entry.endsWith('\n\n'), 'записи разделены пустой строкой');
});

function setup(options: { throwOnAppend?: boolean } = {}) {
  const lines: string[] = [];
  const stderr: string[] = [];
  const notices: ErrorNotice[] = [];
  let now = 1000;
  const reporter = createErrorReporter({
    logFile: '/x/logs/main-errors.log',
    now: () => now,
    append: (file, text) => {
      if (options.throwOnAppend === true) throw new Error('диск полон');
      lines.push(`${file}|${text}`);
    },
    stderr: (text) => stderr.push(text),
    notify: (notice) => notices.push(notice),
  });
  return { reporter, lines, stderr, notices, advance: (ms: number) => (now += ms) };
}

test('report: пишет в файл, в stderr и показывает окно с полным текстом', () => {
  const { reporter, lines, stderr, notices } = setup();
  reporter.report('uncaughtException', new Error('первая'));
  assert.equal(lines.length, 1);
  assert.ok(item(lines, 0).startsWith('/x/logs/main-errors.log|['));
  assert.match(item(lines, 0), /uncaughtException[\s\S]*Error: первая/);
  assert.equal(stderr.length, 1);
  assert.equal(notices.length, 1);
  assert.equal(item(notices, 0).logFile, '/x/logs/main-errors.log');
  assert.match(item(notices, 0).text, /Error: первая/);
});

test('report: второе окно раньше чем через 5 с не открывается, журнал и stderr пишут всё', () => {
  const { reporter, lines, stderr, notices, advance } = setup();
  reporter.report('uncaughtException', new Error('раз'));
  advance(4999);
  reporter.report('unhandledRejection', new Error('два'));
  assert.equal(notices.length, 1, 'окно одно');
  assert.equal(lines.length, 2);
  assert.equal(stderr.length, 2);
  advance(1);
  reporter.report('unhandledRejection', new Error('три'));
  assert.equal(notices.length, 2, 'через 5 с окно снова можно');
  assert.match(item(notices, 1).text, /три/);
});

test('report: ошибка записи журнала не роняет обработчик и не отменяет окно', () => {
  const { reporter, stderr, notices } = setup({ throwOnAppend: true });
  assert.doesNotThrow(() => reporter.report('uncaughtException', new Error('сбой')));
  assert.equal(notices.length, 1);
  assert.match(stderr.join(''), /диск полон/, 'причина, по которой журнала нет, видна');
  assert.match(item(notices, 0).text, /журнал не записан/);
});

test('report: ошибка самого окна не поднимается из обработчика', () => {
  const reporter = createErrorReporter({
    logFile: '/x/e.log',
    now: () => 0,
    append: () => undefined,
    stderr: () => undefined,
    notify: () => {
      throw new Error('окно не открылось');
    },
  });
  assert.doesNotThrow(() => reporter.report('uncaughtException', new Error('x')));
});

test('report: запись в настоящий файл создаёт каталог logs и дописывает', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'main-errors-'));
  try {
    const logFile = path.join(dir, 'logs', 'main-errors.log');
    const reporter = createErrorReporter({ logFile, notify: () => undefined, stderr: () => undefined });
    reporter.report('uncaughtException', new Error('первая'));
    reporter.report('unhandledRejection', 'вторая');
    const text = fs.readFileSync(logFile, 'utf8');
    assert.match(text, /первая/);
    assert.match(text, /unhandledRejection\nвторая/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
