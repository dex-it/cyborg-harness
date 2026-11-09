import { type TestPlugin } from './kernel.js';
/** Обязательная проверка будущего набора: что она доказывает и откуда требование. */
export interface RequiredCheck {
    readonly name: string;
    readonly source: string;
}
/**
 * Обязательные проверки каркасов - только то, что записано в SAD. Новая проверка сначала попадает в SAD или SRS как требование к контракту, потом сюда:
 * иначе будущий автор набора примет догадку за норму. Правила ядра (схему выбирает ядро, значения секретов не попадают в `config`, `state` и журнал) проверяются тестами ядра, а не набором поставщика.
 */
/** `cyborg.secret-source` 1, кратность many, поставщик выбирается по схеме ссылки (SAD, раздел «Секреты»). */
export declare const SECRET_SOURCE_REQUIRED_CHECKS: readonly RequiredCheck[];
/** `cyborg.project-settings` 1, кратность many (SAD, раздел 5.2). Формы `load` и `validate` в SAD не описаны (вопрос 3), проверок на них нет. */
export declare const PROJECT_SETTINGS_REQUIRED_CHECKS: readonly RequiredCheck[];
/** Каркас набора для `cyborg.secret-source`: регистрирует обязательные проверки как `todo`, ничего не проверяя. Сами проверки появятся с типом контракта. */
export declare function secretSourceContractSuite(provider: TestPlugin): void;
/** Каркас набора для `cyborg.project-settings`: то же, что `secretSourceContractSuite`. */
export declare function projectSettingsContractSuite(provider: TestPlugin): void;
