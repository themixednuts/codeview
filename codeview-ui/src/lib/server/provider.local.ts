import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Workspace, CrateGraph } from '$lib/graph';
import type { CrateIndex } from '$lib/schema';
import { parseWorkspace } from '$lib/schema';
import type { CrossEdgeData, DataProvider, CrateStatus, CrateSummaryResult } from './provider';

export function createLocalProvider(): DataProvider {
	let cached: Workspace | null = null;

	return {
		async loadWorkspace() {
			if (cached) return cached;
			const graphPath = process.env.CODEVIEW_GRAPH;
			if (!graphPath) return null;
			try {
				const content = await readFile(graphPath, 'utf-8');
				const raw = JSON.parse(content);
				cached = parseWorkspace(raw) as Workspace;
				return cached;
			} catch (err) {
				console.error('Failed to load workspace:', err);
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
		},

		async loadCrateGraph(name: string, _version: string) {
			// In local mode, graphs come from the workspace
			const ws = await this.loadWorkspace();
			if (!ws) return null;
			return ws.crates.find((c) => c.name === name || c.id === name) ?? null;
		},

		async loadCrateIndex(name: string, version: string): Promise<CrateIndex | null> {
			const ws = await this.loadWorkspace();
			if (!ws) return null;
			const crates = ws.crates.map((c) => ({
				id: c.id,
				name: c.name,
				version: c.version
			}));
			const current = crates.find((c) => c.id === name || c.name === name);
			return {
				name: current?.name ?? name,
				version: current?.version ?? version,
				crates
			};
		},

		async getCrossEdgeData(_nodeId: string): Promise<CrossEdgeData> {
			return { edges: [], nodes: [] };
		},

		async getCrateStatus(name: string, _version: string): Promise<CrateStatus> {
			// In local mode, if the workspace has the crate, it's ready
			const ws = await this.loadWorkspace();
			if (!ws) return { status: 'unknown' };
			const found = ws.crates.some((c) => c.name === name || c.id === name);
			return { status: found ? 'ready' : 'unknown' };
		},

		async triggerParse(_name: string, _version: string) {
			throw new Error('Parse triggering is not supported in local mode');
		},

		async searchRegistry(_query: string): Promise<CrateSummaryResult[]> {
			// No registry search in local mode
			return [];
		},

		async getTopCrates(limit = 10): Promise<CrateSummaryResult[]> {
			const ws = await this.loadWorkspace();
			if (!ws) return [];
			return ws.crates.slice(0, limit).map((c) => ({
				name: c.name,
				version: c.version
			}));
		},

		async getProcessingCrates(_limit = 20): Promise<CrateSummaryResult[]> {
			return [];
		},

		async getCrateVersions(name: string): Promise<string[]> {
			const ws = await this.loadWorkspace();
			if (!ws) return [];
			const crate = ws.crates.find((c) => c.id === name || c.name === name);
			return crate ? [crate.version] : [];
		}
	};
}
