import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  css: { devSourcemap: true },
  build: {
    sourcemap: true
  },
  resolve: {
    ...(process.env.VITEST ? { conditions: ['browser'] } : {})
  },
  test: {
    include: ['src/**/*.{test,spec}.{js,ts}']
  }
});
