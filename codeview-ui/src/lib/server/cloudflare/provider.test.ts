import { afterEach, describe, expect, test, vi } from 'vitest';
import { createCloudflareProvider } from './provider';

function jsonObject(value: unknown): R2ObjectBody {
	return new Response(
		typeof value === 'string' ? value : JSON.stringify(value),
	) as unknown as R2ObjectBody;
}

function fakeBucket(objects: Map<string, unknown>): R2Bucket {
	return {
		async get(key: string) {
			const value = objects.get(key);
			return value === undefined ? null : jsonObject(value);
		},
		async put(key: string, value: string | ArrayBuffer | ArrayBufferView | ReadableStream) {
			if (typeof value === 'string') {
				objects.set(key, value);
			} else if (value instanceof ReadableStream) {
				objects.set(key, await new Response(value).text());
			} else {
				objects.set(
					key,
					new TextDecoder().decode(value instanceof ArrayBuffer ? value : value.buffer),
				);
			}
			return null;
		},
		async head(key: string) {
			return objects.has(key) ? ({} as R2Object) : null;
		},
		async list(options?: R2ListOptions) {
			const prefix = options?.prefix ?? '';
			const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
			return {
				objects: keys.map((key) => ({ key })),
				delimitedPrefixes: [],
				truncated: false,
			} as unknown as R2Objects;
		},
	} as unknown as R2Bucket;
}

function fakeQueue(sent: unknown[]): Queue {
	return {
		async send(body: unknown) {
			sent.push(body);
		},
	} as unknown as Queue;
}

function fnv1a32(value: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < value.length; i += 1) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash >>> 0;
}

function nodeViewBucket(nodeId: string, bucketCount = 128): string {
	const bucket = fnv1a32(nodeId) % bucketCount;
	const width = Math.max(3, (bucketCount - 1).toString(16).length);
	return bucket.toString(16).padStart(width, '0');
}

function hostedMeta(nodeViewBucketCount: number, version = '1.0.0') {
	return {
		schema_version: 1,
		name: 'demo',
		version,
		index: {
			name: 'demo',
			version,
			crates: [],
		},
		nodeCount: 1,
		edgeCount: 0,
		kindCounts: {},
		roots: [],
		rootChildren: {},
		artifacts: {
			nodeViewBucketCount,
			treeChildrenBucketCount: 128,
			aliasBucketCount: 128,
		},
	};
}

function crateRefs(version = '1.0.0') {
	const versions = [...new Set([version, '1.0.0', '1.0.1'])];
	return {
		schemaVersion: 1,
		storageName: 'demo',
		displayName: 'demo',
		aliases: {
			latest: {
				version,
				graphHash: `hash-${version}`,
			},
		},
		versions: versions.map((entryVersion) => ({
			version: entryVersion,
			graphHash: `hash-${entryVersion}`,
		})),
	};
}

function baseNodeArtifacts(
	prefix: string,
	nodeId: string,
	version = '1.0.0',
): Array<[string, unknown]> {
	const bucket = nodeViewBucket(nodeId);
	return [
		[
			`${prefix}/manifest.json`,
			{
				schema_version: 1,
				name: 'demo',
				version,
				index: {
					name: 'demo',
					version,
					crates: [],
				},
				nodeCount: 1,
				edgeCount: 0,
				kindCounts: {
					Crate: 1,
				},
				roots: [],
				rootChildren: {},
				populatedShards: {
					nodes: [bucket],
					nodeDetails: [bucket],
					treeChildren: [],
				},
			},
		],
		[
			`${prefix}/nodes/${bucket}.json`,
			{
				nodes: {
					[nodeId]: {
						id: nodeId,
						name: 'demo',
						kind: 'Crate',
						visibility: { kind: 'Public' },
						attrs: [],
					},
				},
			},
		],
		[
			`${prefix}/node-details/${bucket}.json`,
			{
				details: {
					[nodeId]: {
						edges: [],
						relatedIds: [],
						ancestors: [],
					},
				},
			},
		],
	];
}

describe('createCloudflareProvider', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	test('resolves published crates through canonical refs', async () => {
		const objects = new Map<string, unknown>([
			[
				'rust/_refs/proc_macro.json',
				{
					schemaVersion: 1,
					storageName: 'proc_macro',
					displayName: 'proc_macro',
					aliases: {
						latest: {
							version: '1.98.0-nightly',
							graphHash: 'hash',
						},
					},
					versions: [
						{
							version: '1.98.0-nightly',
							graphHash: 'hash',
						},
					],
				},
			],
			[
				'rust/proc_macro/1.98.0-nightly/site/meta.json',
				{
					schema_version: 1,
					name: 'proc_macro',
					version: '1.98.0-nightly',
					index: {
						name: 'proc_macro',
						version: '1.98.0-nightly',
						crates: [],
					},
					nodeCount: 0,
					edgeCount: 0,
					kindCounts: {},
					roots: [],
					rootChildren: {},
				},
			],
		]);
		const provider = createCloudflareProvider({
			CRATE_GRAPHS: fakeBucket(objects),
		} as Env & { CRATE_GRAPHS: R2Bucket });

		await expect(provider.getCrateStatus('proc-macro', '1.98.0-nightly')).resolves.toEqual({
			status: 'ready',
		});
	});

	test('does not assemble node views when materialized node views are required', async () => {
		const prefix = 'rust/demo/1.0.0';
		const nodeId = 'demo';
		const objects = new Map<string, unknown>([
			['rust/_refs/demo.json', crateRefs()],
			[`${prefix}/site/meta.json`, hostedMeta(128)],
			...baseNodeArtifacts(prefix, nodeId),
		]);
		const provider = createCloudflareProvider({
			CRATE_GRAPHS: fakeBucket(objects),
		} as Env & { CRATE_GRAPHS: R2Bucket });
		const loadNodeViewDirect = provider.loadNodeViewDirect;
		expect(loadNodeViewDirect).toBeDefined();
		if (!loadNodeViewDirect) throw new Error('loadNodeViewDirect missing');

		await expect(loadNodeViewDirect('demo', '1.0.0', nodeId)).resolves.toBeNull();
	});

	test('assembles node views only when materialized node views are deferred', async () => {
		const version = '1.0.1';
		const prefix = `rust/demo/${version}`;
		const nodeId = 'demo';
		const objects = new Map<string, unknown>([
			['rust/_refs/demo.json', crateRefs(version)],
			[`${prefix}/site/meta.json`, hostedMeta(0, version)],
			...baseNodeArtifacts(prefix, nodeId, version),
		]);
		const provider = createCloudflareProvider({
			CRATE_GRAPHS: fakeBucket(objects),
		} as Env & { CRATE_GRAPHS: R2Bucket });
		const loadNodeViewDirect = provider.loadNodeViewDirect;
		expect(loadNodeViewDirect).toBeDefined();
		if (!loadNodeViewDirect) throw new Error('loadNodeViewDirect missing');

		await expect(loadNodeViewDirect('demo', version, nodeId)).resolves.toMatchObject({
			detail: {
				node: {
					id: nodeId,
				},
				edges: [],
				relatedNodes: [],
			},
			ancestors: [],
		});
	});

	test('uses live crates.io metadata for top crates', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							crates: [
								{
									id: 'rand_core',
									name: 'rand_core',
									description: 'Core random number generator traits',
									repository: 'https://github.com/rust-random/rand',
									max_version: '0.9.3',
								},
							],
						}),
						{ status: 200, headers: { 'content-type': 'application/json' } },
					),
			),
		);
		const provider = createCloudflareProvider({
			CRATE_GRAPHS: fakeBucket(new Map()),
		} as Env & { CRATE_GRAPHS: R2Bucket });

		await expect(provider.getTopCrates(1)).resolves.toEqual([
			{
				id: 'rand-core',
				name: 'rand_core',
				version: '0.9.3',
				description: 'Core random number generator traits',
			},
		]);
	});

	test('enqueues hosted parse requests', async () => {
		const objects = new Map<string, unknown>();
		const sent: unknown[] = [];
		const provider = createCloudflareProvider({
			CRATE_GRAPHS: fakeBucket(objects),
			PARSE_REQUESTS: fakeQueue(sent),
		} as Env & { CRATE_GRAPHS: R2Bucket });

		const result = await provider.triggerParse('serde', '1.0.228');
		if (result.isErr()) throw result.error;
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({
			schemaVersion: 1,
			ecosystem: 'rust',
			kind: 'crate',
			name: 'serde',
			version: '1.0.228',
			force: false,
			source: 'ui',
		});

		await expect(provider.getCrateStatus('serde', '1.0.228')).resolves.toEqual({
			status: 'failed',
			error: 'No static graph is published for serde@1.0.228.',
			action: 'docs_unavailable',
		});
		await expect(provider.getProcessingCrates(5)).resolves.toEqual([]);
	});

	test('enqueues hosted sysroot parse requests for std crates', async () => {
		const objects = new Map<string, unknown>();
		const sent: unknown[] = [];
		const provider = createCloudflareProvider({
			CRATE_GRAPHS: fakeBucket(objects),
			PARSE_REQUESTS: fakeQueue(sent),
		} as Env & { CRATE_GRAPHS: R2Bucket });

		const result = await provider.triggerParse('std', 'nightly');
		if (result.isErr()) throw result.error;
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({
			schemaVersion: 1,
			ecosystem: 'rust',
			kind: 'sysroot',
			name: 'std',
			version: 'nightly',
			force: false,
			source: 'ui',
		});
	});
});
