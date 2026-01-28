import type { RequestEvent } from '@sveltejs/kit';
import type { Graph } from '$lib/graph';

export interface DataProvider {
	loadGraph(): Promise<Graph | null>;
	loadSourceFile(relativePath: string): Promise<{
		error: string | null;
		content: string | null;
	}>;
}

let _provider: DataProvider | null = null;

export async function initProvider(event: RequestEvent): Promise<DataProvider> {
	if (_provider) return _provider;

	if (event.platform?.env?.GRAPH_STORE) {
		const mod = await import('./provider.cloudflare');
		_provider = mod.createCloudflareProvider(event.platform.env);
	} else {
		const mod = await import('./provider.local');
		_provider = mod.createLocalProvider();
	}

	return _provider;
}
