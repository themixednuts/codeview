import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const isCloudflare = process.env.CODEVIEW_PLATFORM === 'cloudflare';

const adapter = isCloudflare
  ? (await import('@sveltejs/adapter-cloudflare')).default()
  : (await import('@jesterkit/exe-sveltekit')).default({ binaryName: 'codeview-server' });

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
    experimental: {
      remoteFunctions: true
    }
  }
};

export default config;
