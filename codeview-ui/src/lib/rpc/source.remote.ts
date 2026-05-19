import { getRequestEvent, query } from '$app/server';
import { Data, Effect } from 'effect';
import { initProvider } from '$lib/server/provider';
import type { SourceResult } from '$lib/schema';
import { assertCrateName, assertCrateRef } from './remote-utils';
import { GetSourceInputSchema } from './schemas';

class SourceLoadError extends Data.TaggedError('SourceLoadError')<{
	readonly key: string;
	readonly cause: unknown;
	readonly message: string;
}> {}

function unknownMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

export const getSource = query.batch(
	GetSourceInputSchema,
	async (
		inputs,
	): Promise<
		(
			input: {
				file: string;
				crateName?: string;
				crateVersion?: string;
				sourceProvider?: 'auto' | 'crates-io' | 'github';
			},
			index: number,
		) => SourceResult
	> => {
		const provider = await initProvider(getRequestEvent());
		const inputKey = (input: (typeof inputs)[number]) =>
			`${input.sourceProvider ?? 'auto'}|${input.crateName ?? ''}|${input.crateVersion ?? ''}|${input.file}`;
		const uniqueInputs = new Map<string, (typeof inputs)[number]>();
		for (const input of inputs) {
			if (input.crateName && input.crateVersion) {
				assertCrateRef(input.crateName, input.crateVersion);
			} else if (input.crateName) {
				assertCrateName(input.crateName);
			}
			const key = inputKey(input);
			if (!uniqueInputs.has(key)) uniqueInputs.set(key, input);
		}

		const loaded = await Effect.runPromise(
			Effect.forEach(
				Array.from(uniqueInputs.entries()),
				([key, input]) =>
					Effect.tryPromise({
						try: async () =>
							[
								key,
								await provider.loadSourceFile(
									input.file,
									input.crateName,
									input.crateVersion,
									input.sourceProvider,
								),
							] as const,
						catch: (cause) =>
							new SourceLoadError({
								key,
								cause,
								message: `Failed to load source ${key}: ${unknownMessage(cause)}`,
							}),
					}),
				{ concurrency: 6 },
			),
		);
		const results = new Map<string, SourceResult>(loaded);
		return (_input, index) =>
			results.get(inputKey(inputs[index])) ?? {
				error: 'Failed to fetch source',
				content: null,
				absolutePath: null,
				repoUrl: null,
			};
	},
);
