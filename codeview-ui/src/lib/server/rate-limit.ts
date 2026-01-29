import type { RateLimit } from '@cloudflare/workers-types';
import type { RequestEvent } from '@sveltejs/kit';

export type RateLimitTier = 'anon' | 'auth' | 'paid';
export type RateLimitScope = 'api' | 'parse' | 'ws';

export interface RateLimitEnv {
	RATE_LIMIT_API?: RateLimit;
	RATE_LIMIT_PARSE?: RateLimit;
	RATE_LIMIT_WS?: RateLimit;
	RATE_LIMIT_API_ANON?: RateLimit;
	RATE_LIMIT_API_AUTH?: RateLimit;
	RATE_LIMIT_API_PAID?: RateLimit;
	RATE_LIMIT_PARSE_ANON?: RateLimit;
	RATE_LIMIT_PARSE_AUTH?: RateLimit;
	RATE_LIMIT_PARSE_PAID?: RateLimit;
	RATE_LIMIT_WS_ANON?: RateLimit;
	RATE_LIMIT_WS_AUTH?: RateLimit;
	RATE_LIMIT_WS_PAID?: RateLimit;
	RATE_LIMIT_TIER_OVERRIDE?: string;
	RATE_LIMIT_POLICY_API?: string;
	RATE_LIMIT_POLICY_PARSE?: string;
	RATE_LIMIT_POLICY_WS?: string;
}

const POLICY_KEYS: Record<RateLimitScope, keyof RateLimitEnv> = {
	api: 'RATE_LIMIT_POLICY_API',
	parse: 'RATE_LIMIT_POLICY_PARSE',
	ws: 'RATE_LIMIT_POLICY_WS'
};

function coerceTier(value: string | undefined): RateLimitTier | null {
	if (!value) return null;
	const normalized = value.toLowerCase();
	if (normalized === 'anon' || normalized === 'anonymous') return 'anon';
	if (normalized === 'auth' || normalized === 'authenticated') return 'auth';
	if (normalized === 'paid') return 'paid';
	return null;
}

export async function checkRateLimit(
	limiter: RateLimit | undefined,
	key: string
): Promise<boolean> {
	if (!limiter) return true;
	try {
		const { success } = await limiter.limit({ key });
		return success;
	} catch (err) {
		console.warn('Rate limit check failed', err);
		return true;
	}
}

export function resolveRateLimitTier(
	event: RequestEvent,
	env: RateLimitEnv | undefined,
	scope: RateLimitScope
): RateLimitTier {
	const policyKey = POLICY_KEYS[scope];
	const override = coerceTier((env?.[policyKey] as string | undefined) ?? env?.RATE_LIMIT_TIER_OVERRIDE);
	if (override) return override;

	const locals = event.locals as { user?: { plan?: string } };
	if (locals.user?.plan === 'paid') return 'paid';
	if (locals.user) return 'auth';
	return 'anon';
}

export function resolveRateLimiter(
	env: RateLimitEnv | undefined,
	scope: RateLimitScope,
	tier: RateLimitTier
): RateLimit | undefined {
	if (!env) return undefined;
	if (scope === 'api') {
		if (tier === 'paid') return env.RATE_LIMIT_API_PAID ?? env.RATE_LIMIT_API;
		if (tier === 'auth') return env.RATE_LIMIT_API_AUTH ?? env.RATE_LIMIT_API;
		return env.RATE_LIMIT_API_ANON ?? env.RATE_LIMIT_API;
	}
	if (scope === 'parse') {
		if (tier === 'paid') return env.RATE_LIMIT_PARSE_PAID ?? env.RATE_LIMIT_PARSE;
		if (tier === 'auth') return env.RATE_LIMIT_PARSE_AUTH ?? env.RATE_LIMIT_PARSE;
		return env.RATE_LIMIT_PARSE_ANON ?? env.RATE_LIMIT_PARSE;
	}
	if (tier === 'paid') return env.RATE_LIMIT_WS_PAID ?? env.RATE_LIMIT_WS ?? env.RATE_LIMIT_API;
	if (tier === 'auth') return env.RATE_LIMIT_WS_AUTH ?? env.RATE_LIMIT_WS ?? env.RATE_LIMIT_API;
	return env.RATE_LIMIT_WS_ANON ?? env.RATE_LIMIT_WS ?? env.RATE_LIMIT_API;
}

function getActorKey(event: RequestEvent): string {
	const locals = event.locals as { user?: { id?: string | number; login?: string; username?: string } };
	const userId = locals.user?.id ?? locals.user?.login ?? locals.user?.username;
	if (userId !== undefined && userId !== null && `${userId}`.trim()) {
		return `user:${userId}`;
	}
	const ip = event.request.headers.get('cf-connecting-ip') ?? event.getClientAddress();
	return `ip:${ip}`;
}

export function buildRateLimitKey(
	event: RequestEvent,
	scope: RateLimitScope,
	suffix?: string
): string {
	const parts = [getActorKey(event), scope];
	if (suffix) parts.push(suffix);
	return parts.join(':');
}

export async function checkRateLimitPolicy(
	event: RequestEvent,
	scope: RateLimitScope,
	options?: { key?: string; keySuffix?: string }
): Promise<boolean> {
	const env = event.platform?.env as RateLimitEnv | undefined;
	const tier = resolveRateLimitTier(event, env, scope);
	const limiter = resolveRateLimiter(env, scope, tier);
	const key = options?.key ?? buildRateLimitKey(event, scope, options?.keySuffix ?? tier);
	return checkRateLimit(limiter, key);
}
