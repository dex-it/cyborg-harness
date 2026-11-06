import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

// Страницы лежат вне проекта Starlight, в docs/guide репозитория. Корень паттерна - корень
// репозитория; id страницы считаем сами, чтобы URL не нёс префикс каталога.
const PREFIX = 'docs/guide/';

export const collections = {
  docs: defineCollection({
    loader: glob({
      base: '..',
      pattern: ['docs/guide/**/*.{md,mdx}', '!**/_*'],
      generateId: ({ entry }) =>
        entry
          .slice(PREFIX.length)
          .replace(/\.(md|mdx)$/, '')
          .replace(/\/index$/, '')
          .toLowerCase(),
    }),
    schema: docsSchema(),
  }),
};
