import { test } from 'node:test';
import assert from 'node:assert/strict';
import { violationNote } from '../src/shell/csp-note.ts';

// K-05: под строгой CSP вставленный <style> не применяется молча; оболочка называет причину и способ исправить в консоли фрейма вида.
test('отказ CSP вида: стили называют ui.inlineStyles, остальное - директиву и адрес', () => {
  for (const directive of ['style-src', 'style-src-elem', 'style-src-attr']) {
    const note = violationNote('echo', { violatedDirective: directive, blockedURI: 'inline' });
    assert.match(note, /^Вид echo: CSP отклонила инлайн-стиль \(/, directive);
    assert.match(note, /"inlineStyles": true/, 'подсказка: флаг манифеста');
    assert.match(note, /adoptedStyleSheets/, 'подсказка: стили без флага');
  }
  assert.equal(violationNote('echo', { violatedDirective: 'style-src-elem', blockedURI: 'https://cdn.example/x.css' }), 'Вид echo: CSP отклонила https://cdn.example/x.css (style-src-elem): вид читает только файлы своего origin и data: для картинок');
  assert.equal(violationNote('echo', { violatedDirective: 'connect-src', blockedURI: 'https://evil.example/' }), 'Вид echo: CSP отклонила https://evil.example/ (connect-src): вид читает только файлы своего origin и data: для картинок');
  assert.equal(violationNote('echo', { violatedDirective: 'script-src-elem', blockedURI: 'inline' }), 'Вид echo: CSP отклонила встроенный скрипт (script-src-elem): вид читает только файлы своего origin и data: для картинок');
});
