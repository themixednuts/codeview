<script lang="ts">
	import { requestCrateParse } from '$lib/rpc/crate.remote';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { isHosted } from '$lib/platform';
	import { isStdCrate } from '$lib/std';
	import { normalizeCrateName } from '$lib/crate-names';
	import { Button } from '$lib/shadcn/ui/button';
	import * as NativeSelect from '$lib/shadcn/ui/native-select';

	let {
		crateName,
		version,
		crateVersionOptions,
		onRetryStart,
		onRetryError,
	}: {
		crateName: string | undefined;
		version: string | undefined;
		crateVersionOptions: string[];
		onRetryStart?: () => void;
		onRetryError?: (message: string) => void;
	} = $props();

	let queueing = $state(false);
	let queueError = $state<string | null>(null);
	const canRetry = $derived(!!crateName && !!version);
	const normalizedCrateName = $derived(crateName ? normalizeCrateName(crateName) : '');
	const isStd = $derived(!!normalizedCrateName && isStdCrate(normalizedCrateName));
	const retryLabel = $derived(isHosted ? 'Queue parse' : 'Retry');
	const canQueueParse = $derived(!isStd || isHosted);
	const externalDocsHref = $derived.by(() => {
		if (!crateName || !version) return null;
		return isStd
			? `https://doc.rust-lang.org/${version}/${normalizedCrateName}/`
			: `https://docs.rs/crate/${crateName}/${version}`;
	});
	const externalDocsLabel = $derived(isStd ? 'View on doc.rust-lang.org' : 'View on docs.rs');
	const versionChoices = $derived(crateVersionOptions.filter((candidate) => candidate !== version));
	const parseForm = requestCrateParse;
</script>

<div class="flex flex-1 items-center justify-center">
	<div
		class="corner-squircle mx-3 w-full max-w-md animate-[float-in_0.5s_ease-out] rounded-(--radius-panel) border border-(--panel-border) bg-(--panel) p-5 text-center shadow-(--shadow-soft) sm:p-8"
	>
		<div class="mb-2 text-lg font-semibold text-(--ink)">Documentation not available yet</div>
		<div class="mb-4 text-sm text-(--muted)">
			{#if isStd}
				Codeview doesn't have a parsed graph for the standard library crate
				<code class="rounded-sm bg-(--panel-strong) px-1 py-0.5 text-xs">
					{crateName}
					{version}
				</code>
				. The official rustdoc is available on doc.rust-lang.org.
			{:else if isHosted}
				Codeview has not parsed a graph for
				<code class="rounded-sm bg-(--panel-strong) px-1 py-0.5 text-xs">
					{crateName}
					{version}
				</code>
				yet. Queue a parse to generate the graph artifacts.
			{:else}
				docs.rs hasn't published rustdoc JSON for
				<code class="rounded-sm bg-(--panel-strong) px-1 py-0.5 text-xs">
					{crateName}
					{version}
				</code>
				. This usually takes a few minutes after a new release.
			{/if}
		</div>

		{#if crateName && versionChoices.length > 0}
			<form
				method="GET"
				action="/go/crate-version"
				class="mb-4 flex items-center justify-center gap-2"
			>
				<input type="hidden" name="crate" value={crateName} />
				<input type="hidden" name="path" value={page.params.path ?? ''} />
				<input type="hidden" name="query" value={page.url.search} />
				<label for="unavailable-version" class="sr-only">Try another version</label>
				<NativeSelect.Root id="unavailable-version" name="version" class="w-36 font-mono">
					{#each versionChoices as candidate (candidate)}
						<NativeSelect.Option value={candidate}>v{candidate}</NativeSelect.Option>
					{/each}
				</NativeSelect.Root>
				<Button type="submit" variant="outline">Open version</Button>
			</form>
		{/if}

		{#if queueError}
			<div
				class="mb-4 rounded-md border border-(--danger-border) bg-(--danger-bg) px-3 py-2 text-sm text-(--danger)"
			>
				{queueError}
			</div>
		{/if}

		<div class="mt-2 flex flex-wrap items-center justify-center gap-3">
			{#if externalDocsHref}
				<Button href={externalDocsHref} target="_blank" rel="noopener noreferrer" variant="outline">
					{externalDocsLabel}
				</Button>
			{/if}
			{#if canQueueParse}
				<form
					{...parseForm.enhance(async ({ submit }) => {
						if (!canRetry || queueing) return;
						queueing = true;
						queueError = null;
						try {
							await submit();
							onRetryStart?.();
						} catch (err) {
							const message = err instanceof Error ? err.message : String(err);
							queueError = message;
							onRetryError?.(message);
						} finally {
							queueing = false;
						}
					})}
				>
					<input type="hidden" name="name" value={crateName ?? ''} />
					<input type="hidden" name="version" value={version ?? ''} />
					<Button type="submit" disabled={!canRetry || queueing}>
						{queueing ? 'Queueing...' : retryLabel}
					</Button>
				</form>
			{/if}
			<Button href={resolve('/')} variant="outline">Go back</Button>
		</div>
	</div>
</div>
