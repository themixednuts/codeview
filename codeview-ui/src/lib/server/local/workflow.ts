/** Mirrors Cloudflare's retry config shape */
export type WorkflowRetryConfig = {
	limit: number;
	delayMs: number;
	backoff: 'linear' | 'exponential';
};

export type WorkflowStepConfig = {
	retries?: WorkflowRetryConfig;
};

/** Mirrors Cloudflare's WorkflowStep interface */
export interface WorkflowStep {
	do<T>(name: string, callback: () => Promise<T>): Promise<T>;
	do<T>(name: string, config: WorkflowStepConfig, callback: () => Promise<T>): Promise<T>;
}

/** Mirrors Cloudflare's WorkflowEvent */
export interface WorkflowEvent<TParams> {
	payload: TParams;
}

/** Mirrors Cloudflare's WorkflowEntrypoint */
export abstract class WorkflowEntrypoint<TParams = unknown> {
	abstract run(event: WorkflowEvent<TParams>, step: WorkflowStep): Promise<void>;
}

/** Lifecycle hooks for the local runner */
export interface WorkflowRunnerOptions {
	onStepStart?: (stepName: string) => void;
	onStepComplete?: (stepName: string) => void;
	onStepError?: (stepName: string, error: Error, attempt: number) => void;
}

export type WorkflowResult =
	| { ok: true }
	| { ok: false; error: string; failedStep: string };

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeDelay(config: WorkflowRetryConfig, attempt: number): number {
	if (config.backoff === 'exponential') {
		return config.delayMs * Math.pow(2, attempt);
	}
	// linear
	return config.delayMs * (attempt + 1);
}

/** Run a workflow definition locally with retry + step tracking */
export async function runWorkflow<TParams>(
	workflow: WorkflowEntrypoint<TParams>,
	params: TParams,
	options?: WorkflowRunnerOptions
): Promise<WorkflowResult> {
	let currentStep = '';

	const step: WorkflowStep = {
		async do<T>(
			name: string,
			configOrCallback: WorkflowStepConfig | (() => Promise<T>),
			maybeCallback?: () => Promise<T>
		): Promise<T> {
			const config: WorkflowStepConfig | undefined =
				typeof configOrCallback === 'function' ? undefined : configOrCallback;
			const callback: () => Promise<T> =
				typeof configOrCallback === 'function' ? configOrCallback : maybeCallback!;

			currentStep = name;
			options?.onStepStart?.(name);

			const maxAttempts = (config?.retries?.limit ?? 0) + 1;

			for (let attempt = 0; attempt < maxAttempts; attempt++) {
				try {
					const result = await callback();
					options?.onStepComplete?.(name);
					return result;
				} catch (err) {
					const error = err instanceof Error ? err : new Error(String(err));
					options?.onStepError?.(name, error, attempt);

					if (attempt + 1 >= maxAttempts) {
						throw error;
					}

					const waitMs = computeDelay(config!.retries!, attempt);
					await delay(waitMs);
				}
			}

			// Unreachable, but TS needs it
			throw new Error(`Step "${name}" exhausted retries`);
		}
	};

	try {
		await workflow.run({ payload: params }, step);
		return { ok: true };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, error: msg, failedStep: currentStep };
	}
}
