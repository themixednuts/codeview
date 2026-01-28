// See https://svelte.dev/docs/kit/types#app.d.ts

import type { GraphStore } from '$lib/server/graph-store';

declare global {
	namespace App {
		interface PageState {
			sourceSpanKey?: string;
		}
		interface Platform {
			env?: {
				GRAPH_STORE?: DurableObjectNamespace<GraphStore>;
				GITHUB_REPO?: string;
				GITHUB_REF?: string;
				GITHUB_TOKEN?: string;
			};
		}
	}
}

export {};
