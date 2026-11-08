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

/** `cyborg.secret-source` 1, кратность many, поставщик выбирается по схеме ссылки (SAD, раздел «Секреты»). */
export const SECRET_SOURCE_REQUIRED_CHECKS: readonly RequiredCheck[] = [
  { name: 'resolve(ref) возвращает SecretValue: строку value и необязательный expiresAt (мс)', source: `${SOURCE}, «Секреты», контракт` },
  { name: 'ссылка своей схемы разрешается, чужой схемы - отказ, а не пустое значение', source: `${SOURCE}, «Секреты», выбор поставщика по схеме` },
  { name: 'ссылка вне права secrets.ref потребителя даёт PermissionDenied: источник не решает, кому что можно', source: `${SOURCE}, «Как ядро разрешает ссылку», п. 1` },
  { name: 'значение секрета не попадает в журнал, лог и текст ошибки', source: `${SOURCE}, «Секреты», хранилище ядра - корень доверия` },
  { name: 'list(prefix), если объявлен, отдаёт пути без значений', source: `${SOURCE}, «Секреты», контракт` },
  { name: 'поставщик объявляет schemes в манифесте; два поставщика одной схемы - отказ при загрузке', source: `${SOURCE}, «Секреты», контракт` },
];

/** `cyborg.project-settings` 1, кратность many (SAD, раздел 5.2). */
export const PROJECT_SETTINGS_REQUIRED_CHECKS: readonly RequiredCheck[] = [
  { name: 'fields() отдаёт секцию формы данными, клонируемыми через границу хоста', source: `${SOURCE}, «Настройки проекта у других плагинов»` },
  { name: 'load(draft) и validate(draft, values) не меняют переданный черновик и не пишут значения', source: `${SOURCE}, «Настройки проекта у других плагинов»` },
  { name: 'save(projectId, values) сохраняет значения в разделе поставщика и повторный load их возвращает', source: `${SOURCE}, «Настройки проекта у других плагинов»` },
  { name: 'в значениях формы нет секретов: токен приходит только ссылкой $secret', source: `${SOURCE}, «Настройки проекта у других плагинов»` },
  { name: 'validate отклоняет неверные значения данными (ошибки по полям), а не исключением', source: `${SOURCE}, «Настройки проекта у других плагинов»` },
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
