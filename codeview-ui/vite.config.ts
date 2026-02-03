import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { build, type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

const isCloudflare = process.env.PUBLIC_CODEVIEW_PLATFORM === 'cloudflare';

/**
 * After the main SvelteKit build, build the codeview-services worker entry
 * with Vite so import.meta.glob (used by migrations.ts) gets resolved.
 * The workers wrangler.toml points at the output with no_bundle = true.
 */
function cloudflareWorkers(): Plugin {
  return {
    name: 'cloudflare-workers',
    apply: 'build',
    async closeBundle() {
      if (!isCloudflare) return;
      console.log('\nBuilding codeview-services worker…');
      await build({
        configFile: false,
        build: {
          ssr: resolve(__dirname, 'src/lib/server/cloudflare/workers/src/index.ts'),
          outDir: resolve(__dirname, 'src/lib/server/cloudflare/workers/dist'),
          emptyOutDir: true,
          rollupOptions: {
            external: ['cloudflare:workers'],
            output: { entryFileNames: 'index.js' },
          },
        },
        resolve: {
          alias: {
            $lib: resolve(__dirname, 'src/lib'),
            $cloudflare: resolve(__dirname, 'src/lib/server/cloudflare'),
          },
        },
        ssr: { noExternal: true },
      });
    },
  };
}

export default defineConfig({
  plugins: [tailwindcss(), sveltekit(), cloudflareWorkers()],
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
