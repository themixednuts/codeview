import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Graph } from '$lib/graph';
import type { DataProvider } from './provider';

export function createLocalProvider(): DataProvider {
	let cachedGraph: Graph | null = null;

	return {
		async loadGraph() {
			if (cachedGraph) return cachedGraph;
			const graphPath = process.env.CODEVIEW_GRAPH;
			if (!graphPath) return null;
			try {
				const content = await readFile(graphPath, 'utf-8');
				cachedGraph = JSON.parse(content);
				return cachedGraph;
			} catch {
				return null;
			}
		},

		async loadSourceFile(file: string) {
			const workspaceRoot = process.env.CODEVIEW_WORKSPACE;
			if (!workspaceRoot) {
				return { error: 'CODEVIEW_WORKSPACE not set', content: null };
			}

			const fullPath = join(workspaceRoot, file);
			const resolved = resolve(fullPath);

			if (!resolved.startsWith(resolve(workspaceRoot))) {
				return { error: 'Path outside workspace', content: null };
			}

			try {
				const content = await readFile(resolved, 'utf-8');
				return { error: null, content };
			} catch {
				return { error: 'File not found', content: null };
			}
		}
	};
}
