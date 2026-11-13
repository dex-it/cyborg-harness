// Сборка запускателя Linux `cyborg-confine` (TR-22b, ADR-CH-0019, п. 6): один файл C, только libc и заголовки ядра. На других ОС ничего не делает (там ограничитель - Seatbelt из системы).
// Результат: electron/native/build/linux-<arch>/cyborg-confine. Приложение кладёт его в поставку рядом с бинарником Node и передаёт путь в `IsolationSettings.confinerBinary`.
// Статическая сборка предпочтительна (запускатель не зависит от libc машины пользователя); если статической libc нет, собирается динамическая и сообщает об этом.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

if (process.platform !== 'linux') {
  console.log(`build:confiner: ${process.platform} - запускатель нужен только на Linux, пропуск`);
  process.exit(0);
}
const pkg = join(import.meta.dirname, '..');
const outDir = join(pkg, 'native', 'build', `linux-${process.arch}`);
const out = join(outDir, 'cyborg-confine');
mkdirSync(outDir, { recursive: true });
const cc = process.env.CC ?? 'cc';
const base = ['-O2', '-Wall', '-Wextra', '-Werror', '-D_FORTIFY_SOURCE=2', '-fstack-protector-strong', '-o', out, join(pkg, 'native', 'cyborg-confine.c')];
try {
  execFileSync(cc, ['-static', ...base], { stdio: 'inherit' });
  console.log(`build:confiner: ${out} (статически)`);
} catch {
  execFileSync(cc, ['-pie', '-Wl,-z,relro,-z,now', ...base], { stdio: 'inherit' });
  console.log(`build:confiner: ${out} (динамически: статической libc нет)`);
}
