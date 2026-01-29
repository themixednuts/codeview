import type {
	SourceFetchPolicy,
	SourceFetchOutcome,
	SourcePhase,
	SourceProvider,
	SourceProviderGroup,
	SourceFetchState
} from './types';

export interface ThresholdPolicyOptions {
	name: string;
	maxMainFailures: number;
	mainRetries: number;
	fallbackRetries: number;
	baseDelayMs: number;
	maxDelayMs: number;
}

export function createThresholdPolicy(options: ThresholdPolicyOptions): SourceFetchPolicy {
	return {
		name: options.name,
		getRetries(phase, _provider, group) {
			if (phase === 'main') {
				return group.mainRetries ?? options.mainRetries;
			}
			return group.fallbackRetries ?? options.fallbackRetries;
		},
		shouldRetry(outcome, attempt, phase, provider, group) {
			if (outcome.status === 'ok' || outcome.status === 'over-limit') return false;
			const retries = this.getRetries(phase, provider, group);
			return attempt < retries;
		},
		getRetryDelayMs(attempt) {
			const delay = options.baseDelayMs * Math.min(2 ** attempt, 8);
			return Math.min(delay, options.maxDelayMs);
		},
		shouldRaceFallbacks(state: SourceFetchState, group: SourceProviderGroup) {
			const threshold = group.maxMainFailures ?? options.maxMainFailures;
			return state.mainFailures >= threshold;
		}
	};
}

export const defaultSourcePolicy = createThresholdPolicy({
	name: 'threshold',
	maxMainFailures: 2,
	mainRetries: 2,
	fallbackRetries: 1,
	baseDelayMs: 500,
	maxDelayMs: 4000
});

export interface FailureRatePolicyOptions {
	name: string;
	minSamples: number;
	failureRateThreshold: number;
	maxMainFailures: number;
	mainRetries: number;
	fallbackRetries: number;
	baseDelayMs: number;
	maxDelayMs: number;
}

export function createFailureRatePolicy(options: FailureRatePolicyOptions): SourceFetchPolicy {
	return {
		name: options.name,
		getRetries(phase, _provider, group) {
			if (phase === 'main') {
				return group.mainRetries ?? options.mainRetries;
			}
			return group.fallbackRetries ?? options.fallbackRetries;
		},
		shouldRetry(outcome, attempt, phase, provider, group) {
			if (outcome.status === 'ok' || outcome.status === 'over-limit') return false;
			const retries = this.getRetries(phase, provider, group);
			return attempt < retries;
		},
		getRetryDelayMs(attempt) {
			const delay = options.baseDelayMs * Math.min(2 ** attempt, 8);
			return Math.min(delay, options.maxDelayMs);
		},
		shouldRaceFallbacks(state: SourceFetchState, group: SourceProviderGroup) {
			const maxFailures = group.maxMainFailures ?? options.maxMainFailures;
			if (state.mainFailures >= maxFailures) return true;
			if (state.mainAttempts < options.minSamples) return false;
			const rate = state.mainFailures / state.mainAttempts;
			return rate >= options.failureRateThreshold;
		}
	};
}

export function shouldRetryNetwork(outcome: SourceFetchOutcome): boolean {
	return outcome.status === 'error';
}

export function shouldRetryNotFound(outcome: SourceFetchOutcome): boolean {
	return outcome.status === 'not-found';
}
