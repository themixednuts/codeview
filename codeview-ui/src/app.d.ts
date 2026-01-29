/// <reference path="./cloudflare.d.ts" />
// See https://svelte.dev/docs/kit/types#app.d.ts

import type { GraphStore } from '$lib/server/graph-store';
import type { CrateRegistry } from '$lib/server/crate-registry';
import type { Ecosystem } from '$lib/server/registry/types';

declare global {
	namespace App {
		interface PageState {
			sourceSpanKey?: string;
		}
		interface Platform {
			env?: {
				GRAPH_STORE?: DurableObjectNamespace<GraphStore>;
				CRATE_REGISTRY?: DurableObjectNamespace<CrateRegistry>;
				CRATE_GRAPHS?: R2Bucket;
				PARSE_CRATE?: Workflow<{ ecosystem: Ecosystem; name: string; version: string }>;
				RATE_LIMIT_API?: RateLimit;
				RATE_LIMIT_API_ANON?: RateLimit;
				RATE_LIMIT_API_AUTH?: RateLimit;
				RATE_LIMIT_API_PAID?: RateLimit;
				RATE_LIMIT_PARSE?: RateLimit;
				RATE_LIMIT_PARSE_ANON?: RateLimit;
				RATE_LIMIT_PARSE_AUTH?: RateLimit;
				RATE_LIMIT_PARSE_PAID?: RateLimit;
				RATE_LIMIT_WS?: RateLimit;
				RATE_LIMIT_WS_ANON?: RateLimit;
				RATE_LIMIT_WS_AUTH?: RateLimit;
				RATE_LIMIT_WS_PAID?: RateLimit;
				RATE_LIMIT_TIER_OVERRIDE?: string;
				RATE_LIMIT_POLICY_API?: string;
				RATE_LIMIT_POLICY_PARSE?: string;
				RATE_LIMIT_POLICY_WS?: string;
				GITHUB_REPO?: string;
				GITHUB_REF?: string;
				GITHUB_TOKEN?: string;
			};
		}
	}
}

export {};
