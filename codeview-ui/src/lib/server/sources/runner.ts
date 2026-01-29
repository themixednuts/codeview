import type {
	SourceFetchContext,
	SourceFetchOutcome,
	SourceProvider,
	SourceProviderGroup
} from './types';
import type { SourceFetchPolicy } from './types';
import { defaultSourcePolicy } from './policy';

export async function fetchSourcesWithProviders(
	group: SourceProviderGroup,
	request: Parameters<SourceProvider['fetch']>[0],
	context: SourceFetchContext
): Promise<Map<string, string> | null> {
	const policy = group.policy ?? defaultSourcePolicy;

	let mainFailures = 0;
	let mainAttempts = 0;

	for (let index = 0; index < group.main.length; index++) {
		const provider = group.main[index];
		const result = await attemptProvider(provider, request, context, policy, group, 'main');
		const outcome = result.outcome;
		if (outcome.status === 'ok') return outcome.files;
		if (outcome.status === 'over-limit') return null;

		mainFailures += result.failures;
		mainAttempts += result.attempts;
		const state = {
			phase: 'main',
			providerIndex: index,
			mainFailures,
			mainAttempts,
			lastOutcome: outcome
		} as const;
		if (group.fallbacks.length > 0 && policy.shouldRaceFallbacks(state, group)) {
			const fallback = await raceFallbacks(group.fallbacks, request, context, policy, group);
			if (fallback) return fallback;
		}
	}

	if (group.fallbacks.length > 0) {
		return raceFallbacks(group.fallbacks, request, context, policy, group);
	}

	return null;
}

async function attemptProvider(
	provider: SourceProvider,
	request: Parameters<SourceProvider['fetch']>[0],
	context: SourceFetchContext,
	policy: SourceFetchPolicy,
	group: SourceProviderGroup,
	phase: 'main' | 'fallback'
): Promise<{ outcome: SourceFetchOutcome; attempts: number; failures: number }> {
	let attempt = 0;
	let lastError: SourceFetchOutcome | null = null;
	let failures = 0;
	const retries = policy.getRetries(phase, provider, group);

	while (attempt <= retries) {
		const outcome = await provider.fetch(request, context);
		if (outcome.status === 'ok' || outcome.status === 'over-limit') {
			return { outcome, attempts: attempt + 1, failures };
		}
		lastError = outcome;
		failures += 1;
		if (!policy.shouldRetry(outcome, attempt, phase, provider, group)) {
			break;
		}
		attempt += 1;
		if (attempt <= retries) {
			await delay(policy.getRetryDelayMs(attempt - 1, phase));
		}
	}

	return {
		outcome: lastError ?? { status: 'error', message: 'Source provider failed' },
		attempts: attempt + 1,
		failures
	};
}

async function raceFallbacks(
	providers: SourceProvider[],
	request: Parameters<SourceProvider['fetch']>[0],
	context: SourceFetchContext,
	policy: SourceFetchPolicy,
	group: SourceProviderGroup
): Promise<Map<string, string> | null> {
	if (providers.length === 0) return null;

	const attempts = providers.map((provider) =>
		attemptProvider(provider, request, context, policy, group, 'fallback').then((result) => {
			if (result.outcome.status === 'ok') return result.outcome.files;
			if (result.outcome.status === 'over-limit') {
				throw new OverLimitError();
			}
			throw new Error(
				result.outcome.status === 'error' ? result.outcome.message : 'Source not found'
			);
		})
	);

	try {
		return await Promise.any(attempts);
	} catch (err) {
		if (isOverLimitError(err)) return null;
		return null;
	}
}

class OverLimitError extends Error {
	constructor() {
		super('Source fetch exceeded size limit');
		this.name = 'OverLimitError';
	}
}

function isOverLimitError(err: unknown): boolean {
	if (err instanceof OverLimitError) return true;
	if (err instanceof AggregateError) {
		for (const inner of err.errors) {
			if (inner instanceof OverLimitError) return true;
		}
	}
	return false;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
