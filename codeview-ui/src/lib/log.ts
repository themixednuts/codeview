import { Result } from 'better-result';
import {
	configure,
	getConsoleSink,
	getStreamSink,
	getLogger as _getLogger,
	type LogLevel,
	isLogLevel
} from '@logtape/logtape';

let configured = false;

const isBrowser = typeof globalThis.document !== 'undefined';
const isCloudflare = typeof globalThis.caches !== 'undefined' && !isBrowser;

function isPerfEnabled(): boolean {
	if (!isBrowser) return false;
	try {
		if (new URL(window.location.href).searchParams.has('perf')) return true;
	} catch {}
	try {
		if (localStorage.getItem('codeview-perf') === '1') return true;
	} catch {}
	return false;
}

function resolveLogLevel(): LogLevel {
	if (isBrowser) {
		try {
			const param = new URL(window.location.href).searchParams.get('log');
			if (param && isLogLevel(param)) return param;
		} catch {}
		try {
			const stored = localStorage.getItem('codeview-log-level');
			if (stored && isLogLevel(stored)) return stored as LogLevel;
		} catch {}
	} else if (!isCloudflare) {
		// Node / Bun server
		try {
			const envLevel = process.env.LOG_LEVEL;
			if (envLevel && isLogLevel(envLevel)) return envLevel as LogLevel;
		} catch {}
	}
	// Default: debug in dev-like, info otherwise
	if (isBrowser) {
		try {
			if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
				return 'debug';
		} catch {}
	} else if (!isCloudflare) {
		try {
			if (process.env.NODE_ENV !== 'production') return 'debug';
		} catch {}
	}
	return 'info';
}

function buildFileSink(): Record<string, ReturnType<typeof getStreamSink>> {
	if (isBrowser || isCloudflare) return {};
	try {
		const logFile = process.env.LOG_FILE;
		if (!logFile) return {};
		const { createWriteStream } = require('node:fs') as typeof import('node:fs');
		const ws = createWriteStream(logFile, { flags: 'a' });
		const webStream = globalThis.WritableStream
			? new WritableStream({
					write(chunk) {
						ws.write(chunk);
					},
					close() {
						ws.end();
					}
				})
			: null;
		if (!webStream) return {};
		return {
			file: getStreamSink(webStream, {
				formatter: (record) => {
					const ts = new Date(record.timestamp).toISOString();
					const level = record.level.toUpperCase();
					const cat = record.category.slice(1).join(':');
					const msg = record.message
						.map((p) => (typeof p === 'function' ? p() : p))
						.join('');
					const props =
						record.properties && Object.keys(record.properties).length > 0
							? ' ' + Result.try(() => JSON.stringify(record.properties)).unwrapOr('[unserializable]')
							: '';
					return `${ts} ${level} [${cat}] ${msg}${props}\n`;
				}
			})
		};
	} catch {
		return {};
	}
}

export async function setupLogging(): Promise<void> {
	if (configured) return;
	configured = true;

	const perfEnabled = isPerfEnabled();
	const logLevel = resolveLogLevel();
	const fileSinks = buildFileSink();
	const hasFile = 'file' in fileSinks;

	const allSinks = hasFile ? ['console', 'file'] : ['console'];

	await configure({
		sinks: {
			console: getConsoleSink({
				formatter: (record) => {
					const cat = record.category.slice(1).join(':');
					const prefix = `[${cat}]`;
					const msg = record.message
						.map((p) => (typeof p === 'function' ? p() : p))
						.join('');
					const props =
						record.properties && Object.keys(record.properties).length > 0
							? ' ' + Result.try(() => JSON.stringify(record.properties)).unwrapOr('[unserializable]')
							: '';
					return [`${prefix} ${msg}${props}`];
				}
			}),
			...fileSinks
		},
		loggers: [
			{
				category: ['logtape', 'meta'],
				sinks: []
			},
			{
				category: ['codeview', 'perf'],
				sinks: perfEnabled ? allSinks : [],
				parentSinks: 'override',
				lowestLevel: 'debug'
			},
			{
				category: ['codeview'],
				sinks: allSinks,
				lowestLevel: logLevel
			}
		]
	});
}

export function getLogger(...category: string[]) {
	return _getLogger(['codeview', ...category]);
}

export function getPerfLogger(category: string) {
	return _getLogger(['codeview', 'perf', category]);
}

export function getLoggerWith(category: string, context: Record<string, unknown>) {
	return _getLogger(['codeview', category]).with(context);
}
