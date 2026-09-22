import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  site: 'https://bramosjr.github.io',
  base: '/bramos/',
  output: 'static',
  vite: {
    plugins: [tailwindcss()],
  },
});
