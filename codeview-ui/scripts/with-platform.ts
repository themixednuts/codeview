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

const child = spawn(command, args, {
	env: {
		...process.env,
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
