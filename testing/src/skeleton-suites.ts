import { describe, test } from 'node:test';
import { resolvePlugin, type TestPlugin } from './kernel.ts';

/** Обязательная проверка будущего набора: что она доказывает и откуда требование. */
export interface RequiredCheck {
  readonly name: string;
  readonly source: string;
}

const SOURCE = 'docs/03-architecture/design/sad.md';

/** Причина, по которой каркас не проверяет: типов контракта нет в `@cyborg-harness/contracts`, а форма в SAD не закрыта (`cyborg.project-settings` - раздел 8, вопрос 3; `cyborg.secret-source` отложен, раздел «Секреты»). */
const PENDING = 'контракт ещё не объявлен в @cyborg-harness/contracts: набор станет рабочим вместе с типом';

/**
 * Обязательные проверки каркасов - только то, что записано в SAD. Новая проверка сначала попадает в SAD или SRS как требование к контракту, потом сюда:
 * иначе будущий автор набора примет догадку за норму. Правила ядра (схему выбирает ядро, значения секретов не попадают в `config`, `state` и журнал) проверяются тестами ядра, а не набором поставщика.
 */

/** `cyborg.secret-source` 1, кратность many, поставщик выбирается по схеме ссылки (SAD, раздел «Секреты»). */
export const SECRET_SOURCE_REQUIRED_CHECKS: readonly RequiredCheck[] = [
  { name: 'resolve(ref) возвращает SecretValue: строку value и необязательный expiresAt (мс)', source: `${SOURCE}, «Секреты», контракт` },
  { name: 'ссылка со схемой поставщика доходит до него и разрешается', source: `${SOURCE}, «Секреты», «Как ядро разрешает ссылку», п. 2-3` },
  { name: 'ссылка вне права secrets.ref потребителя даёт PermissionDenied от ядра: источник не вызывается и не решает, кому что можно', source: `${SOURCE}, «Секреты», «Как ядро разрешает ссылку», п. 1` },
  { name: 'list(prefix), если объявлен, отдаёт пути без значений', source: `${SOURCE}, «Секреты», контракт` },
  { name: 'поставщик объявляет schemes в манифесте; два поставщика одной схемы - отказ при загрузке', source: `${SOURCE}, «Секреты», контракт` },
];

/** `cyborg.project-settings` 1, кратность many (SAD, раздел 5.2). Формы `load` и `validate` в SAD не описаны (вопрос 3), проверок на них нет. */
export const PROJECT_SETTINGS_REQUIRED_CHECKS: readonly RequiredCheck[] = [
  { name: 'fields() отдаёт секцию формы данными, клонируемыми через границу хоста', source: `${SOURCE}, «Настройки проекта у других плагинов»` },
  { name: 'save(projectId, values) сохраняет значения в разделе поставщика', source: `${SOURCE}, «Настройки проекта у других плагинов»` },
  { name: 'в значениях формы нет секретов: токен приходит только ссылкой $secret', source: `${SOURCE}, «Настройки проекта у других плагинов»` },
];

function skeleton(contract: string, provider: TestPlugin, required: readonly RequiredCheck[]): void {
  const { id } = resolvePlugin(provider);
  void describe(`${contract}, общий набор (каркас): ${id}`, () => {
    for (const check of required) void test(`${check.name} [${check.source}]`, { todo: PENDING });
  });
}

/** Каркас набора для `cyborg.secret-source`: регистрирует обязательные проверки как `todo`, ничего не проверяя. Сами проверки появятся с типом контракта. */
export function secretSourceContractSuite(provider: TestPlugin): void {
  skeleton('cyborg.secret-source', provider, SECRET_SOURCE_REQUIRED_CHECKS);
}

/** Каркас набора для `cyborg.project-settings`: то же, что `secretSourceContractSuite`. */
export function projectSettingsContractSuite(provider: TestPlugin): void {
  skeleton('cyborg.project-settings', provider, PROJECT_SETTINGS_REQUIRED_CHECKS);
}
