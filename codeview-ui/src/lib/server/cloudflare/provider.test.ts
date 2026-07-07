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

function fakeRateLimit(success = true): RateLimit {
	return {
		async limit() {
			return { success };
		},
	} as unknown as RateLimit;
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
		} as unknown as Env & { CRATE_GRAPHS: R2Bucket });

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

	test('filters hosted nodes by kind from node shards without loaded tree children', async () => {
		const prefix = 'rust/demo/1.0.0';
		const crateNodeId = 'demo';
		const nestedNodeId = 'demo::hidden::Widget';
		const crateBucket = nodeViewBucket(crateNodeId);
		const nestedBucket = nodeViewBucket(nestedNodeId);
		const objects = new Map<string, unknown>([
			['rust/_refs/demo.json', crateRefs()],
			[`${prefix}/site/meta.json`, hostedMeta(128)],
			[
				`${prefix}/manifest.json`,
				{
					schema_version: 1,
					name: 'demo',
					version: '1.0.0',
					index: { name: 'demo', version: '1.0.0', crates: [] },
					nodeCount: 2,
					edgeCount: 0,
					kindCounts: { Crate: 1, Struct: 1 },
					roots: [],
					rootChildren: {},
					populatedShards: {
						nodes: [...new Set([crateBucket, nestedBucket])],
						nodeDetails: [],
						treeChildren: [],
					},
				},
			],
			[
				`${prefix}/nodes/${crateBucket}.json`,
				{
					nodes: {
						[crateNodeId]: {
							id: crateNodeId,
							name: 'demo',
							kind: 'Crate',
							visibility: { kind: 'Public' },
							attrs: [],
						},
					},
				},
			],
			[
				`${prefix}/nodes/${nestedBucket}.json`,
				{
					nodes: {
						[nestedNodeId]: {
							id: nestedNodeId,
							name: 'Widget',
							kind: 'Struct',
							visibility: { kind: 'Public' },
							attrs: [],
						},
					},
				},
			],
		]);
		const provider = createCloudflareProvider({
			CRATE_GRAPHS: fakeBucket(objects),
		} as Env & { CRATE_GRAPHS: R2Bucket });

		await expect(
			provider.searchNodesDirect?.('demo', '1.0.0', '', 10, ['Struct']),
		).resolves.toEqual([
			{
				id: nestedNodeId,
				name: 'Widget',
				kind: 'Struct',
				visibility: { kind: 'Public' },
				is_external: undefined,
				is_deprecated: undefined,
			},
		]);
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

	test('includes active GitHub parse workflow runs in queue snapshots', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input));
				const status = url.searchParams.get('status');
				return new Response(
					JSON.stringify({
						workflow_runs:
							status === 'in_progress'
								? [
										{
											id: 123,
											name: 'parse',
											display_title: 'parse hashbrown 0.17.1',
											status: 'in_progress',
											event: 'workflow_dispatch',
											head_branch: 'main',
											html_url: 'https://github.com/themixednuts/codeview/actions/runs/123',
											created_at: '2026-07-07T12:00:00Z',
											updated_at: '2026-07-07T12:05:00Z',
										},
									]
								: [],
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				);
			}),
		);
		const provider = createCloudflareProvider({
			CRATE_GRAPHS: fakeBucket(new Map()),
			GITHUB_REPO: 'themixednuts/codeview',
			GITHUB_WORKFLOW_FILE: 'parse.yml',
		} as Env & { CRATE_GRAPHS: R2Bucket });

		await expect(provider.getParseQueue?.(10)).resolves.toMatchObject({
			active: [],
			activeRuns: [
				{
					id: '123',
					title: 'parse hashbrown 0.17.1',
					status: 'in_progress',
					event: 'workflow_dispatch',
					branch: 'main',
					url: 'https://github.com/themixednuts/codeview/actions/runs/123',
				},
			],
			recent: [],
			planned: null,
		});
	});

	test('builds admin dashboard allowance from GitHub active runs and billing', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = new URL(String(input));
				if (url.pathname === '/repos/themixednuts/codeview') {
					return new Response(
						JSON.stringify({
							full_name: 'themixednuts/codeview',
							private: true,
							owner: { login: 'themixednuts', type: 'User' },
						}),
						{ status: 200, headers: { 'content-type': 'application/json' } },
					);
				}
				if (url.pathname === '/users/themixednuts/settings/billing/usage/summary') {
					expect(url.searchParams.get('product')).toBe('Actions');
					expect(url.searchParams.get('repository')).toBe('themixednuts/codeview');
					return new Response(
						JSON.stringify({
							usageItems: [
								{
									product: 'Actions',
									sku: 'actions_linux',
									unitType: 'minutes',
									grossQuantity: 125,
								},
								{
									product: 'Codespaces',
									sku: 'codespaces_compute',
									unitType: 'hours',
									grossQuantity: 10,
								},
							],
						}),
						{ status: 200, headers: { 'content-type': 'application/json' } },
					);
				}
				if (url.pathname === '/repos/themixednuts/codeview/actions/workflows/parse.yml/runs') {
					if (url.searchParams.has('created')) {
						return new Response(
							JSON.stringify({
								workflow_runs: [
									{
										id: 321,
										status: 'completed',
										created_at: '2026-07-07T12:00:00Z',
										updated_at: '2026-07-07T12:30:00Z',
									},
								],
							}),
							{ status: 200, headers: { 'content-type': 'application/json' } },
						);
					}
					return new Response(
						JSON.stringify({
							workflow_runs:
								url.searchParams.get('status') === 'in_progress'
									? [
											{
												id: 123,
												name: 'parse',
												display_title: 'parse bitflags 2.13.0',
												status: 'in_progress',
												event: 'workflow_dispatch',
												head_branch: 'main',
												html_url: 'https://github.com/themixednuts/codeview/actions/runs/123',
												created_at: '2026-07-07T12:00:00Z',
												updated_at: '2026-07-07T12:05:00Z',
											},
										]
									: [],
						}),
						{ status: 200, headers: { 'content-type': 'application/json' } },
					);
				}
				return new Response('{}', { status: 404 });
			}),
		);
		const provider = createCloudflareProvider({
			CRATE_GRAPHS: fakeBucket(new Map()),
			GITHUB_REPO: 'themixednuts/codeview',
			GITHUB_WORKFLOW_FILE: 'parse.yml',
			GITHUB_TOKEN: 'token',
			PLAN_DRAIN_ACTIVE_TARGET: '4',
			PLAN_DRAIN_BATCH_SIZE: '2',
			GITHUB_ACTIONS_REPO_USAGE_TARGET_PERCENT: '35',
			GITHUB_ACTIONS_MONTHLY_INCLUDED_MINUTES: '2000',
		} as unknown as Env & { CRATE_GRAPHS: R2Bucket });

		const dashboard = await provider.getAdminDashboard?.(10);

		expect(dashboard?.allowance).toMatchObject({
			repo: 'themixednuts/codeview',
			activeTarget: 4,
			batchSize: 2,
			trackedActiveCount: 0,
			githubActiveRunCount: 1,
			actionsInUse: 1,
			availableSlots: 3,
			repoUsageTargetPercent: 35,
			repoPrivate: true,
			standardRunnerMinutesMetered: true,
			estimatedRepoMinutesThisMonth: 30,
			repoBudgetMinutes: 700,
			billing: {
				available: true,
				includedMinutes: 2000,
				totalMinutesUsed: 125,
			},
		});
	});

	test('enqueues hosted parse requests', async () => {
		const objects = new Map<string, unknown>();
		const sent: unknown[] = [];
		const provider = createCloudflareProvider({
			CRATE_GRAPHS: fakeBucket(objects),
			PARSE_REQUESTS: fakeQueue(sent),
			RATE_LIMIT_PARSE_ANON: fakeRateLimit(),
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

	test('fails closed when hosted parse rate limiting is missing', async () => {
		const sent: unknown[] = [];
		const provider = createCloudflareProvider({
			CRATE_GRAPHS: fakeBucket(new Map()),
			PARSE_REQUESTS: fakeQueue(sent),
		} as Env & { CRATE_GRAPHS: R2Bucket });

		const result = await provider.triggerParse('serde', '1.0.228');
		expect(result.isErr()).toBe(true);
		if (!result.isErr()) throw new Error('expected parse request to fail');
		expect(result.error._tag).toBe('NotAvailableError');
		expect(result.error.message).toBe('Hosted parse rate limiting is not configured');
		expect(sent).toHaveLength(0);
	});

	test('requires admin auth for forced hosted parses', async () => {
		const sent: unknown[] = [];
		const provider = createCloudflareProvider({
			CRATE_GRAPHS: fakeBucket(new Map()),
			PARSE_REQUESTS: fakeQueue(sent),
			RATE_LIMIT_PARSE_ANON: fakeRateLimit(),
		} as Env & { CRATE_GRAPHS: R2Bucket });

		const result = await provider.triggerParse('serde', '1.0.228', true);
		expect(result.isErr()).toBe(true);
		if (!result.isErr()) throw new Error('expected force parse request to fail');
		expect(result.error._tag).toBe('NotAvailableError');
		expect(result.error.message).toBe('Force parse requires admin access');
		expect(sent).toHaveLength(0);
	});

	test('enqueues hosted sysroot parse requests for std crates', async () => {
		const objects = new Map<string, unknown>();
		const sent: unknown[] = [];
		const provider = createCloudflareProvider({
			CRATE_GRAPHS: fakeBucket(objects),
			PARSE_REQUESTS: fakeQueue(sent),
			RATE_LIMIT_PARSE_ANON: fakeRateLimit(),
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
