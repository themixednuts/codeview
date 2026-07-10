import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const isCloudflare = process.env.PUBLIC_CODEVIEW_PLATFORM === 'cloudflare';
const appVersion =
	process.env.CODEVIEW_VERSION ??
	process.env.GITHUB_SHA ??
	process.env.CF_VERSION_METADATA_ID ??
	'dev';

const adapter = isCloudflare
	? (await import('@sveltejs/adapter-cloudflare')).default({
			platformProxy: {
				persist: { path: './.wrangler/state/v3' },
			},
		})
	: (await import('@jesterkit/exe-sveltekit')).default({ binaryName: 'codeview-server' });

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	compilerOptions: {
		runes: true,
		experimental: {
			async: true,
		},
	},
	kit: {
		adapter,
		alias: {
			$cloudflare: 'src/lib/server/cloudflare',
			$provider: isCloudflare
				? 'src/lib/server/cloudflare/provider.ts'
				: 'src/lib/server/local/provider.ts',
			$realtime: 'src/lib/ws/client.ts',
		},
		experimental: {
			remoteFunctions: true,
		},
		version: {
			name: appVersion,
			pollInterval: 60_000,
		},
	},
};

export default config;
