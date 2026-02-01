import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const isCloudflare = process.env.PUBLIC_CODEVIEW_PLATFORM === 'cloudflare';

const adapter = isCloudflare
  ? (await import('@sveltejs/adapter-cloudflare')).default({
      platformProxy: {
        persist: { path: './.wrangler/v3' }
      }
    })
  : (await import('@jesterkit/exe-sveltekit')).default({ binaryName: 'codeview-server' });

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  compilerOptions: {
    runes: true,
    experimental: {
      async: true
    }
  },
  kit: {
    adapter,
    alias: {
      '$cloudflare': 'src/lib/server/cloudflare',
      '$provider': isCloudflare
        ? 'src/lib/server/cloudflare/provider.ts'
        : 'src/lib/server/local/provider.ts'
    },
    experimental: {
      remoteFunctions: true
    }
  }
};

export default config;
