import { afterEach } from 'node:test';

interface Unloadable {
  unload(): Promise<void>;
}

/**
 * Ядра, поднятые тестом, выгружаются после каждого теста файла, в том числе упавшего. Упавшая проверка до `k.unload()` иначе оставляет слежение за файлами,
 * хосты и программы живыми, и процесс файла не выходит (на CI это 15 минут молчания до отмены задания). Повторная выгрузка безвредна.
 * Зовётся один раз на верхнем уровне файла; возвращённая функция регистрирует ядро и отдаёт его же.
 */
export function trackKernels(): <T extends Unloadable>(kernel: T) => T {
  const live = new Set<Unloadable>();
  afterEach(async () => {
    const left = [...live];
    live.clear();
    await Promise.allSettled(left.map((k) => k.unload()));
  });
  return (kernel) => {
    live.add(kernel);
    return kernel;
  };
}
