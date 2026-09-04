import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://theohermann.ch',
  base: process.env.PREVIEW_BASE || '/',
  integrations: [sitemap({ filter: (page) => !page.includes('/audit') })],
  output: 'static',
  vite: {
    plugins: [tailwindcss()],
  },
});
