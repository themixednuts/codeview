import { spawn } from 'node:child_process';

const [platform, command, ...args] = process.argv.slice(2);

if (platform !== 'local' && platform !== 'cloudflare') {
	console.error('usage: bun scripts/with-platform.ts <local|cloudflare> <command> [...args]');
	process.exit(2);
}

if (!command) {
	console.error('missing command');
	process.exit(2);
}

// Vite+ may evaluate the SvelteKit config in more than one process. Keep the
// app/version identifier identical across every phase of this command so the
// SSR bootstrap and client runtime agree on their generated global name.
const codeviewVersion =
	process.env.CODEVIEW_VERSION ??
	process.env.GITHUB_SHA ??
	process.env.CF_VERSION_METADATA_ID ??
	`${Date.now()}`;

const child = spawn(command, args, {
	env: {
		...process.env,
		CODEVIEW_VERSION: codeviewVersion,
		PUBLIC_CODEVIEW_PLATFORM: platform,
	},
	shell: process.platform === 'win32',
	stdio: 'inherit',
});

child.on('exit', (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal);
		return;
	}
	process.exit(code ?? 1);
});

child.on('error', (err) => {
	console.error(err);
	process.exit(1);
});
