// Адрес сайта и бренд: единственное место, откуда их читают конфиг Astro и проверка сборки.
//
// Адрес GitHub Pages задаёт имя репозитория: https://<организация>.github.io/<репозиторий>/.
// Репозиторий переименуют - меняются REPO_NAME (и, при смене организации, OWNER) в этом файле,
// остальное (base, canonical, sitemap, ссылки, проверка dist) подтягивается отсюда.

export const OWNER = 'dex-it';
export const REPO_NAME = 'cyborg-harness';

export const ORIGIN = `https://${OWNER}.github.io`;
export const BASE = `/${REPO_NAME}`;
export const SITE_URL = `${ORIGIN}${BASE}/`;
export const REPO = `https://github.com/${OWNER}/${REPO_NAME}`;

export const BRAND = 'Cyborg Harness';
export const TAGLINE = 'Микроядро для приложений на плагинах';
export const DESCRIPTION =
  'Cyborg Harness - микроядро для настольных приложений на плагинах: загрузка и изоляция плагинов, контракты вместо общих сервисов, терминал-ресурсы, виды во фреймах, права словами и документация для автора плагина.';
