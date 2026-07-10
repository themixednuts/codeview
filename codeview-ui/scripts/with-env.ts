import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const separator = args.indexOf('--');
if (separator < 0 || separator === args.length - 1) {
	console.error('usage: bun scripts/with-env.ts KEY=value KEY?=default -- command [...args]');
	process.exit(2);
}

const env = { ...process.env };
for (const assignment of args.slice(0, separator)) {
	const defaultOnly = assignment.includes('?=');
	const delimiter = defaultOnly ? '?=' : '=';
	const delimiterIndex = assignment.indexOf(delimiter);
	if (delimiterIndex <= 0) {
		console.error(`invalid environment assignment: ${assignment}`);
		process.exit(2);
	}
	const key = assignment.slice(0, delimiterIndex);
	const value = assignment.slice(delimiterIndex + delimiter.length);
	if (!defaultOnly || env[key] === undefined || env[key] === '') env[key] = value;
}

const [command, ...rawCommandArgs] = args.slice(separator + 1);
const commandArgs = rawCommandArgs.map((argument) =>
	argument.replace(/\{([A-Z_][A-Z0-9_]*)\}/g, (_match, key: string) => env[key] ?? ''),
);
const child = spawn(command, commandArgs, {
	env,
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

child.on('error', (error) => {
	console.error(error);
	process.exit(1);
});
