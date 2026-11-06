// Значок берётся из assets/icon.svg: сайт не держит своей копии, она собирается перед dev, build и check
// в site/src/generated (логотип в шапке) и site/public (favicon); оба пути в .gitignore.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const icon = join(siteRoot, '..', 'assets', 'icon.svg');

for (const target of [join(siteRoot, 'src', 'generated', 'brand', 'icon.svg'), join(siteRoot, 'public', 'favicon.svg')]) {
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(icon, target);
}
console.log('copy-brand: assets/icon.svg -> src/generated/brand, public/favicon.svg');
