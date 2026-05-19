<script lang="ts">
	import { probeAvailableDocsVersion, triggerCrateParseForm } from '$lib/rpc/crate.remote';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { LoaderCircleIcon } from '@lucide/svelte';
	import { isHosted } from '$lib/platform';
	import { isStdCrate } from '$lib/std';

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

	const retryForm = triggerCrateParseForm;
	let lastFormKey = '';
	$effect(() => {
		if (!crateName || !version) return;
		const key = `${crateName}@${version}`;
		if (key === lastFormKey) return;
		lastFormKey = key;
		retryForm.fields.set({ name: crateName, version, force: true });
	});

	const canRetry = $derived(!!crateName && !!version);

	const isStd = $derived(!!crateName && isStdCrate(crateName));
	const externalDocsHref = $derived.by(() => {
		if (!crateName || !version) return null;
		return isStd
			? `https://doc.rust-lang.org/${version}/${crateName}/`
			: `https://docs.rs/crate/${crateName}/${version}`;
	});
	const externalDocsLabel = $derived(isStd ? 'View on doc.rust-lang.org' : 'View on docs.rs');

	function goBack() {
		void goto(resolve('/'));
	}

	let suggestedVersion = $derived(
		crateName && version && crateVersionOptions.length > 1
			? await probeAvailableDocsVersion({
					name: crateName,
					currentVersion: version,
					candidates: crateVersionOptions,
				})
			: null,
	);
</script>

<div class="flex flex-1 items-center justify-center">
	<div
		class="corner-squircle max-w-md animate-[float-in_0.5s_ease-out] rounded-(--radius-panel) border border-(--panel-border) bg-(--panel) p-8 text-center shadow-(--shadow-soft)"
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
				Codeview has not published a static graph for
				<code class="rounded-sm bg-(--panel-strong) px-1 py-0.5 text-xs">
					{crateName}
					{version}
				</code>
				yet.
			{:else}
				docs.rs hasn't published rustdoc JSON for
				<code class="rounded-sm bg-(--panel-strong) px-1 py-0.5 text-xs">
					{crateName}
					{version}
				</code>
				. This usually takes a few minutes after a new release.
			{/if}
		</div>

		<svelte:boundary>
			{#snippet pending()}
				<div class="mb-4 flex items-center justify-center gap-2 text-sm text-(--muted)">
					<LoaderCircleIcon class="size-3.5 animate-spin" />
					<span>Checking other versions...</span>
				</div>
			{/snippet}
			{#snippet failed(error, reset)}
				<div class="mb-4 text-sm text-(--danger)">
					Failed to check alternate versions.
					<button type="button" class="ml-2 text-(--accent) hover:underline" onclick={reset}>
						Try again
					</button>
				</div>
			{/snippet}

			{#if suggestedVersion && crateName}
				<a
					href={resolve(`/${crateName}/${suggestedVersion}`)}
					class="corner-squircle mb-4 inline-block rounded-(--radius-control) border border-(--panel-border) bg-(--panel-solid) px-4 py-2 text-sm text-(--accent) transition-colors hover:bg-(--panel-strong)"
				>
					Try version {suggestedVersion} instead
				</a>
			{/if}
		</svelte:boundary>

		<div class="mt-2 flex items-center justify-center gap-3">
			{#if externalDocsHref}
				<a
					href={externalDocsHref}
					target="_blank"
					rel="noopener noreferrer"
					class="corner-squircle rounded-(--radius-control) border border-(--panel-border) bg-(--panel-solid) px-4 py-2 text-sm text-(--muted) transition-colors hover:text-(--ink)"
				>
					{externalDocsLabel}
				</a>
			{/if}
			{#if !isHosted}
				<form
					{...retryForm.enhance(async ({ submit }) => {
						if (!canRetry) return;
						onRetryStart?.();
						try {
							await submit();
						} catch (err) {
							onRetryError?.(err instanceof Error ? err.message : String(err));
						}
					})}
				>
					<button
						type="submit"
						disabled={!canRetry}
						class="corner-squircle rounded-(--radius-control) bg-(--accent) px-4 py-2 text-sm font-medium text-(--on-accent) transition-opacity enabled:hover:opacity-90 disabled:opacity-60"
					>
						Retry
					</button>
				</form>
			{/if}
			<button
				type="button"
				class="corner-squircle rounded-(--radius-control) border border-(--panel-border) bg-(--panel-solid) px-4 py-2 text-sm text-(--muted) transition-colors hover:text-(--ink)"
				onclick={goBack}
			>
				Go back
			</button>
		</div>
	</div>
</div>
