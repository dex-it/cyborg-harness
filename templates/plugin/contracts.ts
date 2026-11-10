// Объявления контракта плагина: только типы и дополнение карты Contracts, кода здесь нет.
// Потребитель подключает этот файл (или пакет с ним) через `import type`, а проверка импортов не пускает значения из него в код плагина.

declare module '@cyborg-harness/contracts' {
  interface Contracts {
    'example.greeting': { 1: Greeting };
  }
}

export interface Greeting {
  greet(name: string): Promise<string>;
}
