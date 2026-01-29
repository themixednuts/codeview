export type SourceArchiveOutcome =
	| { status: 'ok'; files: Map<string, string>; totalBytes: number }
	| { status: 'over-limit'; totalBytes: number }
	| { status: 'error'; message: string };

export interface SourceArchiveOptions {
	maxBytes: number;
	userAgent?: string;
	headers?: Record<string, string>;
}

const TEXT_DECODER = new TextDecoder();

export async function fetchSourceArchive(
	url: string,
	options: SourceArchiveOptions
): Promise<SourceArchiveOutcome> {
	const headers: Record<string, string> = { ...(options.headers ?? {}) };
	if (options.userAgent && !headers['User-Agent']) {
		headers['User-Agent'] = options.userAgent;
	}

	let response: Response;
	try {
		response = await fetch(url, { headers });
	} catch (err) {
		return { status: 'error', message: err instanceof Error ? err.message : String(err) };
	}

	if (!response.ok) {
		return { status: 'error', message: `Archive fetch failed: ${response.status} ${response.statusText}` };
	}

	return extractSourcesFromTarGz(response, options);
}

export async function extractSourcesFromTarGz(
	response: Response,
	options: SourceArchiveOptions
): Promise<SourceArchiveOutcome> {
	if (!response.body) {
		return { status: 'error', message: 'Archive response missing body' };
	}

	let stream: ReadableStream<Uint8Array>;
	try {
		stream = response.body.pipeThrough(new DecompressionStream('gzip'));
	} catch (err) {
		return {
			status: 'error',
			message: err instanceof Error ? err.message : 'Failed to create gzip stream'
		};
	}

	const reader = stream.getReader();
	const tar = new TarStreamReader(reader);
	const files = new Map<string, string>();
	let totalBytes = 0;
	let stripPrefix: string | null = null;
	let pendingLongPath: string | null = null;

	while (true) {
		const headerBlock = await tar.readBlock();
		if (!headerBlock) break;
		if (isZeroBlock(headerBlock)) break;

		const header = parseTarHeader(headerBlock);
		const size = header.size;

		if (header.typeflag === 'L') {
			const data = await tar.readExact(size);
			if (!data) {
				return { status: 'error', message: 'Unexpected EOF while reading long path' };
			}
			pendingLongPath = decodeText(data).replace(/\0.*$/, '').trimEnd();
			await tar.skipPadding(size);
			continue;
		}

		const rawPath = pendingLongPath ?? header.name;
		pendingLongPath = null;

		const pathWithPrefix = header.prefix
			? `${header.prefix}/${rawPath}`
			: rawPath;

		if (stripPrefix === null) {
			const cleaned = pathWithPrefix.replace(/^\.\/+/, '');
			if (cleaned.includes('/')) {
				const first = cleaned.split('/')[0];
				stripPrefix = first ? `${first}/` : '';
			} else {
				stripPrefix = '';
			}
		}

		const normalizedPath = normalizeArchivePath(pathWithPrefix, stripPrefix);
		const isFile = header.typeflag === '0' || header.typeflag === '\0';

		if (!normalizedPath || !isFile) {
			if (!(await tar.skipExact(size))) {
				return { status: 'error', message: 'Unexpected EOF while skipping entry' };
			}
			await tar.skipPadding(size);
			continue;
		}

		if (!shouldInclude(normalizedPath)) {
			if (!(await tar.skipExact(size))) {
				return { status: 'error', message: 'Unexpected EOF while skipping entry' };
			}
			await tar.skipPadding(size);
			continue;
		}

		if (totalBytes + size > options.maxBytes) {
			return { status: 'over-limit', totalBytes };
		}

		const data = await tar.readExact(size);
		if (!data) {
			return { status: 'error', message: 'Unexpected EOF while reading entry' };
		}
		await tar.skipPadding(size);
		files.set(normalizedPath, decodeText(data));
		totalBytes += size;
	}

	return { status: 'ok', files, totalBytes };
}

function shouldInclude(path: string): boolean {
	return path.endsWith('.rs') || path.endsWith('Cargo.toml');
}

function normalizeArchivePath(path: string, stripPrefix: string | null): string {
	let normalized = path.replace(/\\/g, '/').replace(/^\.\/+/, '');
	if (stripPrefix && normalized.startsWith(stripPrefix)) {
		normalized = normalized.slice(stripPrefix.length);
	}
	return normalized.replace(/^\/+/, '');
}

function decodeText(data: Uint8Array): string {
	return TEXT_DECODER.decode(data);
}

function isZeroBlock(block: Uint8Array): boolean {
	for (const byte of block) {
		if (byte !== 0) return false;
	}
	return true;
}

function parseTarHeader(block: Uint8Array): {
	name: string;
	size: number;
	typeflag: string;
	prefix: string;
} {
	const name = decodeNullTerminated(block.subarray(0, 100));
	const sizeRaw = decodeNullTerminated(block.subarray(124, 136));
	const typeflag = decodeNullTerminated(block.subarray(156, 157)) || '\0';
	const prefix = decodeNullTerminated(block.subarray(345, 500));

	return {
		name: name.trimEnd(),
		size: parseOctal(sizeRaw),
		typeflag,
		prefix: prefix.trimEnd()
	};
}

function decodeNullTerminated(bytes: Uint8Array): string {
	return TEXT_DECODER.decode(bytes).replace(/\0.*$/, '');
}

function parseOctal(value: string): number {
	const trimmed = value.replace(/\0.*$/, '').trim();
	if (!trimmed) return 0;
	const parsed = Number.parseInt(trimmed, 8);
	return Number.isNaN(parsed) ? 0 : parsed;
}

class TarStreamReader {
	#reader: ReadableStreamDefaultReader<Uint8Array>;
	#buffer: Uint8Array | null = null;
	#offset = 0;
	#done = false;

	constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
		this.#reader = reader;
	}

	async readBlock(): Promise<Uint8Array | null> {
		return this.readExact(512);
	}

	async readExact(length: number): Promise<Uint8Array | null> {
		const out = new Uint8Array(length);
		let written = 0;

		while (written < length) {
			if (this.#available() === 0) {
				const chunk = await this.#readChunk();
				if (!chunk) return null;
				this.#buffer = chunk;
				this.#offset = 0;
			}

			const available = this.#available();
			const take = Math.min(available, length - written);
			out.set(this.#buffer!.subarray(this.#offset, this.#offset + take), written);
			this.#offset += take;
			written += take;

			if (this.#offset >= this.#buffer!.length) {
				this.#buffer = null;
				this.#offset = 0;
			}
		}

		return out;
	}

	async skipExact(length: number): Promise<boolean> {
		let remaining = length;

		while (remaining > 0) {
			if (this.#available() === 0) {
				const chunk = await this.#readChunk();
				if (!chunk) return false;
				if (chunk.length <= remaining) {
					remaining -= chunk.length;
					continue;
				}
				this.#buffer = chunk;
				this.#offset = remaining;
				remaining = 0;
				continue;
			}

			const available = this.#available();
			const take = Math.min(available, remaining);
			this.#offset += take;
			remaining -= take;

			if (this.#offset >= this.#buffer!.length) {
				this.#buffer = null;
				this.#offset = 0;
			}
		}

		return true;
	}

	async skipPadding(size: number): Promise<void> {
		const padding = (512 - (size % 512)) % 512;
		if (padding > 0) {
			await this.skipExact(padding);
		}
	}

	#available(): number {
		return this.#buffer ? this.#buffer.length - this.#offset : 0;
	}

	async #readChunk(): Promise<Uint8Array | null> {
		if (this.#done) return null;
		const { value, done } = await this.#reader.read();
		if (done || !value) {
			this.#done = true;
			return null;
		}
		return value;
	}
}
