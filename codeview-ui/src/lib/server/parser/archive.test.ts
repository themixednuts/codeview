import { describe, expect, test } from 'vitest';
import { gzipSync } from 'node:zlib';
import { extractSourceFileFromTarGz } from './archive';

function octal(value: number, width: number): string {
	return value.toString(8).padStart(width - 1, '0') + '\0';
}

function tarEntry(name: string, content: string): Buffer {
	const data = Buffer.from(content);
	const header = Buffer.alloc(512);
	header.write(name, 0, 100, 'utf-8');
	header.write(octal(0o644, 8), 100, 8, 'ascii');
	header.write(octal(0, 8), 108, 8, 'ascii');
	header.write(octal(0, 8), 116, 8, 'ascii');
	header.write(octal(data.length, 12), 124, 12, 'ascii');
	header.write(octal(0, 12), 136, 12, 'ascii');
	header.fill(' ', 148, 156);
	header.write('0', 156, 1, 'ascii');
	header.write('ustar\0', 257, 6, 'ascii');
	header.write('00', 263, 2, 'ascii');

	let checksum = 0;
	for (const byte of header) checksum += byte;
	header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');

	const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
	return Buffer.concat([header, data, padding]);
}

function tarGz(entries: Array<[string, string]>): ArrayBuffer {
	const compressed = gzipSync(
		Buffer.concat([...entries.map(([name, content]) => tarEntry(name, content)), Buffer.alloc(1024)]),
	);
	return compressed.buffer.slice(
		compressed.byteOffset,
		compressed.byteOffset + compressed.byteLength,
	) as ArrayBuffer;
}

function responseFor(entries: Array<[string, string]>): Response {
	return new Response(tarGz(entries));
}

describe('extractSourceFileFromTarGz', () => {
	test('does not count skipped files against the target file byte limit', async () => {
		const result = await extractSourceFileFromTarGz(
			responseFor([
				['crate-1.0.0/src/large.rs', '0123456789'.repeat(20)],
				['crate-1.0.0/src/target.rs', 'small'],
			]),
			'src/target.rs',
			{ maxBytes: 10 },
		);

		expect(result).toEqual({ status: 'ok', content: 'small', totalBytes: 205 });
	});

	test('still rejects a target file larger than the byte limit', async () => {
		const result = await extractSourceFileFromTarGz(
			responseFor([['crate-1.0.0/src/target.rs', '0123456789'.repeat(2)]]),
			'src/target.rs',
			{ maxBytes: 10 },
		);

		expect(result.status).toBe('over-limit');
	});
});
