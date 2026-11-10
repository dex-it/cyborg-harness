/** Что оболочка берёт из события `securitypolicyviolation`. */
export interface Violation {
  readonly violatedDirective: string;
  readonly blockedURI: string;
}

const SUFFIX = 'вид читает только файлы своего origin и data: для картинок';

/**
 * Что отклонила CSP и что делать: идёт в консоль фрейма (`violationNote`) и в журнал плагина (#160), без этого вставленный `<style>` не применяется молча.
 * Инлайн-стиль под строгой CSP называет флаг манифеста (K-05); прочее - директиву и адрес.
 */
export function violationDetail(violation: Violation): string {
  const { violatedDirective: directive, blockedURI: blocked } = violation;
  if (blocked === 'inline' && directive.startsWith('style-src'))
    return `инлайн-стиль (${directive}): объявите в манифесте "ui": { "inlineStyles": true } или берите стили из файла вида и adoptedStyleSheets`;
  const what = blocked === 'inline' && directive.startsWith('script-src') ? 'встроенный скрипт' : blocked;
  return `${what} (${directive}): ${SUFFIX}`;
}

/** Строка для консоли фрейма вида об отказе CSP. */
export function violationNote(plugin: string, violation: Violation): string {
  return `Вид ${plugin}: CSP отклонила ${violationDetail(violation)}`;
}
