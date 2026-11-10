/** Что оболочка берёт из события `securitypolicyviolation`. */
export interface Violation {
  readonly violatedDirective: string;
  readonly blockedURI: string;
}

const SUFFIX = 'вид читает только файлы своего origin и data: для картинок';

/**
 * Строка для консоли фрейма вида об отказе CSP: без неё вставленный `<style>` не применяется молча.
 * Инлайн-стиль под строгой CSP называет флаг манифеста (K-05); прочее - директиву и адрес.
 */
export function violationNote(plugin: string, violation: Violation): string {
  const { violatedDirective: directive, blockedURI: blocked } = violation;
  const head = `Вид ${plugin}: CSP отклонила`;
  if (blocked === 'inline' && directive.startsWith('style-src'))
    return `${head} инлайн-стиль (${directive}): объявите в манифесте "ui": { "inlineStyles": true } или берите стили из файла вида и adoptedStyleSheets`;
  const what = blocked === 'inline' && directive.startsWith('script-src') ? 'встроенный скрипт' : blocked;
  return `${head} ${what} (${directive}): ${SUFFIX}`;
}
