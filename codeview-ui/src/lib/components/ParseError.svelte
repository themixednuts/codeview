<script lang="ts">
	import { triggerCrateParseForm } from '$lib/rpc/crate.remote';

	let {
		crateName,
		version,
		error,
		onRetryStart,
		onRetryError,
	}: {
		crateName: string | undefined;
		version: string | undefined;
		error?: string | null;
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
</script>

<div class="flex flex-1 items-center justify-center">
	<div
		class="corner-squircle max-w-md animate-[float-in_0.5s_ease-out] rounded-(--radius-panel) border border-(--panel-border) bg-(--panel) p-8 text-center shadow-(--shadow-soft)"
	>
		<div class="mb-2 text-lg font-semibold text-(--danger)">
			Failed to parse {crateName}
		</div>
		{#if error}
			<div class="mb-4 text-sm text-(--muted)">
				{error}
			</div>
		{/if}
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
	</div>
</div>
