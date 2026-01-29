import type { PackageMetadata, Ecosystem } from '../registry/types';

export interface SourceFetchContext {
	maxBytes: number;
	userAgent: string;
	githubToken?: string;
}

export interface SourceRequest {
	ecosystem: Ecosystem;
	name: string;
	version: string;
	metadata: PackageMetadata;
}

export type SourceFetchOutcome =
	| { status: 'ok'; files: Map<string, string> }
	| { status: 'over-limit' }
	| { status: 'not-found' }
	| { status: 'error'; message: string };

export interface SourceProvider {
	id: string;
	fetch(request: SourceRequest, context: SourceFetchContext): Promise<SourceFetchOutcome>;
}

export type SourcePhase = 'main' | 'fallback';

export interface SourceFetchState {
	phase: SourcePhase;
	providerIndex: number;
	mainFailures: number;
	mainAttempts: number;
	lastOutcome?: SourceFetchOutcome;
}

export interface SourceFetchPolicy {
	name: string;
	getRetries(phase: SourcePhase, provider: SourceProvider, group: SourceProviderGroup): number;
	shouldRetry(
		outcome: SourceFetchOutcome,
		attempt: number,
		phase: SourcePhase,
		provider: SourceProvider,
		group: SourceProviderGroup
	): boolean;
	getRetryDelayMs(attempt: number, phase: SourcePhase): number;
	shouldRaceFallbacks(state: SourceFetchState, group: SourceProviderGroup): boolean;
}

export interface SourceProviderGroup {
	main: SourceProvider[];
	fallbacks: SourceProvider[];
	maxMainFailures?: number;
	mainRetries?: number;
	fallbackRetries?: number;
	policy?: SourceFetchPolicy;
}

export interface SourceAdapter {
	getProviders(request: SourceRequest): SourceProviderGroup;
}
