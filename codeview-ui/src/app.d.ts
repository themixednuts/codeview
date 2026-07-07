/// <reference path="./cloudflare.d.ts" />
// See https://svelte.dev/docs/kit/types#app.d.ts
import type { AuthSession, AuthState, AuthUser } from '$lib/server/auth';

declare global {
	namespace App {
		interface Locals {
			auth: AuthState;
			user: AuthUser | null;
			session: AuthSession | null;
		}

		interface Platform {
			/** Bun server instance for WebSocket upgrades (local mode only) */
			server?: import('bun').Server;
			env?: {
				AUTH_DB?: D1Database;
				CRATE_GRAPHS?: R2Bucket;
				PARSE_REQUESTS?: Queue;
				PARSE_STATUS?: DurableObjectNamespace;
				RATE_LIMIT_API?: RateLimit;
				RATE_LIMIT_API_ANON?: RateLimit;
				RATE_LIMIT_API_AUTH?: RateLimit;
				RATE_LIMIT_PARSE_ANON?: RateLimit;
				RATE_LIMIT_PARSE_AUTH?: RateLimit;
				RATE_LIMIT_API_PAID?: RateLimit;
				RATE_LIMIT_WS?: RateLimit;
				RATE_LIMIT_WS_ANON?: RateLimit;
				RATE_LIMIT_WS_AUTH?: RateLimit;
				RATE_LIMIT_WS_PAID?: RateLimit;
				RATE_LIMIT_TIER_OVERRIDE?: string;
				RATE_LIMIT_POLICY_API?: string;
				RATE_LIMIT_POLICY_WS?: string;
				GITHUB_REPO?: string;
				GITHUB_REF?: string;
				GITHUB_TOKEN?: string;
				BETTER_AUTH_SECRET?: string;
				BETTER_AUTH_URL?: string;
				GITHUB_OAUTH_CLIENT_ID?: string;
				GITHUB_OAUTH_CLIENT_SECRET?: string;
				GITHUB_ADMIN_LOGINS?: string;
			};
		}
	}
}

declare module '$env/static/public' {
	export const PUBLIC_CODEVIEW_PLATFORM: string;
}

export {};
