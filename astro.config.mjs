import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://theohermann.ch',
  integrations: [sitemap({ filter: (page) => !page.includes('/audit') })],
  output: 'static',
  vite: {
    plugins: [tailwindcss()],
  },
});
