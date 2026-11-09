// Публичный вход ядра для инструмента автора и сборки (Node): проверка каталога плагина без запуска его кода. Только именованные экспорты; перечень сверяет core/test/public-api.test.ts.
export { checkPlugin, CHECKED_KEYS, ENTRY_FILES, formatProblem, isTestPath } from './plugin-check.ts';

export type { CheckOptions, CheckReport, FileRef, ImportRules, Problem } from './plugin-check.ts';
