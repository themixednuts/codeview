import { spawn } from 'node:child_process';

const bunCmd = 'bun';
let child = null;
let stopping = false;
let firstRun = true;

function launch() {
	const script = firstRun ? 'cf:dev:clear' : 'cf:dev';
	const port = process.env.CODEVIEW_E2E_PORT;
	const args = ['run', script];
	if (port) args.push('--', '--port', port);
	firstRun = false;

	console.log(`[cf-supervisor] starting ${script}`);
	child = spawn(bunCmd, args, {
		stdio: 'inherit',
		env: process.env,
	});

	child.on('exit', (code, signal) => {
		if (stopping) {
			process.exit(0);
		}

		console.error(
			`[cf-supervisor] dev server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'}), restarting in 2s`,
		);
		setTimeout(launch, 2_000);
	});
}

function shutdown() {
	if (stopping) return;
	stopping = true;

	if (child && !child.killed) {
		child.kill('SIGTERM');
	}

	setTimeout(() => process.exit(0), 5_000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

launch();
