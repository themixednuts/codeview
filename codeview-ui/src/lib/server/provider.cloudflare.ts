import type { Confidence, CrateGraph, EdgeKind, NodeKind, Visibility, Workspace } from '$lib/graph';
import type { CrateIndex } from '$lib/schema';
import { parseWorkspace } from '$lib/schema';
import type { CrossEdgeData, DataProvider, CrateStatus, CrateSummaryResult } from './provider';
import type { GraphStore } from './graph-store';
import type { CrateRegistry } from './crate-registry';
import type { Ecosystem } from './registry/types';
import { getRegistry } from './registry/index';
import { isValidCrateName, isValidVersion } from './validation';

interface CfEnv {
	GRAPH_STORE: DurableObjectNamespace<GraphStore>;
	CRATE_REGISTRY?: DurableObjectNamespace<CrateRegistry>;
	CRATE_GRAPHS?: R2Bucket;
	PARSE_CRATE?: Workflow<{ ecosystem: Ecosystem; name: string; version: string }>;
	GITHUB_REPO?: string;
	GITHUB_REF?: string;
	GITHUB_TOKEN?: string;
}

export function createCloudflareProvider(env: CfEnv): DataProvider {
	const graphStub = env.GRAPH_STORE.get(env.GRAPH_STORE.idFromName('default'));

	const registryStub = env.CRATE_REGISTRY
		? env.CRATE_REGISTRY.get(env.CRATE_REGISTRY.idFromName('global'))
		: null;

	let cachedWorkspace: Workspace | null = null;

	return {
		async loadWorkspace() {
			if (cachedWorkspace) return cachedWorkspace;
			const json = await graphStub.getGraph();
			if (!json) return null;
			try {
				cachedWorkspace = parseWorkspace(json) as Workspace;
			} catch (err) {
				console.error('Failed to parse workspace:', err);
				return null;
			}
			return cachedWorkspace;
		},

		async loadSourceFile(relativePath: string) {
			// Check DO cache first
			const cachedFile = await graphStub.getSourceFile(relativePath);
			if (cachedFile) return { error: null, content: cachedFile };

			// Resolve repo info from env or workspace metadata
			const workspace = await this.loadWorkspace();
			const repo = env.GITHUB_REPO ?? workspace?.repo;
			const ref_ = env.GITHUB_REF ?? workspace?.ref ?? 'main';

			if (!repo) {
				return { error: 'No GitHub repo configured for source viewing', content: null };
			}

			// Fetch from GitHub API
			const url = `https://api.github.com/repos/${repo}/contents/${relativePath}?ref=${ref_}`;
			const headers: Record<string, string> = {
				Accept: 'application/vnd.github.raw+json',
				'User-Agent': 'codeview'
			};
			if (env.GITHUB_TOKEN) {
				headers['Authorization'] = `Bearer ${env.GITHUB_TOKEN}`;
			}

			try {
				const response = await fetch(url, { headers });
				if (!response.ok) {
					return { error: `GitHub API returned ${response.status}`, content: null };
				}

				const content = await response.text();

				// Cache in DO (fire-and-forget)
				graphStub.cacheSourceFile(relativePath, content).catch(() => {});

				return { error: null, content };
			} catch {
				return { error: 'Failed to fetch source from GitHub', content: null };
			}
		},

		async loadCrateGraph(name: string, version: string) {
			if (!env.CRATE_GRAPHS) return null;

			const key = `rust/${name}/${version}/graph.json`;
			const obj = await env.CRATE_GRAPHS.get(key);
			if (!obj) return null;

			try {
				return await obj.json<CrateGraph>();
			} catch (err) {
				console.error(`Failed to parse crate graph from R2 (${key}):`, err);
				return null;
			}
		},

		async loadCrateIndex(name: string, version: string): Promise<CrateIndex | null> {
			if (!env.CRATE_GRAPHS) return null;
			const key = `rust/${name}/${version}/index.json`;
			const obj = await env.CRATE_GRAPHS.get(key);
			if (!obj) return null;
			try {
				return await obj.json<CrateIndex>();
			} catch (err) {
				console.error(`Failed to parse crate index from R2 (${key}):`, err);
				return null;
			}
		},

		async getCrossEdgeData(nodeId: string): Promise<CrossEdgeData> {
			if (!registryStub) return { edges: [], nodes: [] };
			const result = await registryStub.getCrossEdgeData('rust', nodeId);
			return {
				edges: result.edges.map((edge) => ({
					...edge,
					kind: edge.kind as EdgeKind,
					confidence: edge.confidence as Confidence
				})),
				nodes: result.nodes.map((node) => ({
					...node,
					kind: node.kind as NodeKind,
					visibility: node.visibility as Visibility
				}))
			};
		},

		async getCrateStatus(name: string, version: string) {
			if (!registryStub) return { status: 'unknown' as const };
			return await registryStub.getStatus('rust', name, version);
		},

		async triggerParse(name: string, version: string) {
			if (!env.PARSE_CRATE) {
				throw new Error('Workflow binding PARSE_CRATE not available');
			}
			if (!registryStub) {
				throw new Error('CRATE_REGISTRY binding not available');
			}
			if (!isValidCrateName(name) || !isValidVersion(version)) {
				throw new Error('Invalid crate name or version');
			}

			const current = await registryStub.getStatus('rust', name, version);
			if (current.status === 'processing' || current.status === 'ready') return;

			// Set status to processing immediately for fast feedback
			await registryStub.setStatus('rust', name, version, 'processing');

			// Trigger the workflow
			await env.PARSE_CRATE.create({
				params: { ecosystem: 'rust', name, version }
			});
		},

		async searchRegistry(query: string) {
			const registry = getRegistry('rust');
			const results = await registry.search(query);
			return results.map((r) => ({
				name: r.name,
				version: r.version,
				description: r.description
			}));
		},

		async getTopCrates(limit = 10) {
			const registry = getRegistry('rust');
			const results = await registry.listTop(limit);
			return results.map((r) => ({
				name: r.name,
				version: r.version,
				description: r.description
			}));
		},

		async getProcessingCrates(limit = 20) {
			if (!registryStub) return [];
			return await registryStub.getProcessingCrates('rust', limit);
		},

		async getCrateVersions(name: string, limit = 20): Promise<string[]> {
			const registry = getRegistry('rust');
			const direct = await registry.listVersions(name, limit);
			if (direct.length > 0) return direct;
			// Try hyphen/underscore normalization for Rust crate names
			const fallbackName = name.includes('_') ? name.replace(/_/g, '-') : name.replace(/-/g, '_');
			return await registry.listVersions(fallbackName, limit);
		}
	};
}
