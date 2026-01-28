import type { Graph } from '$lib/graph';
import type { DataProvider } from './provider';
import type { GraphStore } from './graph-store';

interface CfEnv {
	GRAPH_STORE: DurableObjectNamespace<GraphStore>;
	GITHUB_REPO?: string;
	GITHUB_REF?: string;
	GITHUB_TOKEN?: string;
}

export function createCloudflareProvider(env: CfEnv): DataProvider {
	const stub = env.GRAPH_STORE.get(env.GRAPH_STORE.idFromName('default'));
	let cachedGraph: Graph | null = null;

	return {
		async loadGraph() {
			if (cachedGraph) return cachedGraph;
			const json = await stub.getGraph();
			if (!json) return null;
			cachedGraph = JSON.parse(json);
			return cachedGraph;
		},

		async loadSourceFile(relativePath: string) {
			// Check DO cache first
			const cached = await stub.getSourceFile(relativePath);
			if (cached) return { error: null, content: cached };

			// Resolve repo info from env or graph metadata
			const graph = await this.loadGraph();
			const repo = env.GITHUB_REPO ?? graph?.repo;
			const ref = env.GITHUB_REF ?? graph?.ref ?? 'main';

			if (!repo) {
				return { error: 'No GitHub repo configured for source viewing', content: null };
			}

			// Fetch from GitHub API
			const url = `https://api.github.com/repos/${repo}/contents/${relativePath}?ref=${ref}`;
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
				stub.cacheSourceFile(relativePath, content).catch(() => {});

				return { error: null, content };
			} catch {
				return { error: 'Failed to fetch source from GitHub', content: null };
			}
		}
	};
}
