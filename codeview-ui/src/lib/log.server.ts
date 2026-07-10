import { Result } from 'better-result';
import { getStreamSink, type Sink } from '@logtape/logtape';
import { setupLogging as setupBaseLogging } from './log';

async function createFileSink(): Promise<Sink | null> {
	if (typeof globalThis.caches !== 'undefined') return null;
	const logFile = process.env.LOG_FILE;
	if (!logFile) return null;

	const { createWriteStream } = await import('node:fs');
	const stream = createWriteStream(logFile, { flags: 'a' });
	const webStream = new WritableStream({
		write(chunk) {
			stream.write(chunk);
		},
		close() {
			stream.end();
		},
	});

	return getStreamSink(webStream, {
		formatter: (record) => {
			const timestamp = new Date(record.timestamp).toISOString();
			const level = record.level.toUpperCase();
			const category = record.category.slice(1).join(':');
			const message = record.message
				.map((part) => (typeof part === 'function' ? part() : part))
				.join('');
			const properties =
				record.properties && Object.keys(record.properties).length > 0
					? ` ${Result.try(() => JSON.stringify(record.properties)).unwrapOr('[unserializable]')}`
					: '';
			return `${timestamp} ${level} [${category}] ${message}${properties}\n`;
		},
	});
}

export async function setupLogging(): Promise<void> {
	const fileSink = await createFileSink().catch(() => null);
	await setupBaseLogging(fileSink ? { file: fileSink } : {});
}
