<script lang="ts">
	import { triggerCrateParse } from '$lib/rpc/crate.remote';

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

	let retrying = $state(false);
	let retryError = $state<string | null>(null);
	const canRetry = $derived(!!crateName && !!version);

	async function retryParse() {
		if (!crateName || !version || retrying) return;
		retrying = true;
		retryError = null;
		try {
			await triggerCrateParse({ name: crateName, version });
			onRetryStart?.();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			retryError = message;
			onRetryError?.(message);
		} finally {
			retrying = false;
		}
	}
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
		{#if retryError}
			<div
				class="mb-4 rounded-md border border-(--danger-border) bg-(--danger-bg) px-3 py-2 text-sm text-(--danger)"
			>
				{retryError}
			</div>
		{/if}
		<button
			type="button"
			disabled={!canRetry || retrying}
			class="corner-squircle rounded-(--radius-control) bg-(--accent) px-4 py-2 text-sm font-medium text-(--on-accent) transition-opacity enabled:hover:opacity-90 disabled:opacity-60"
			onclick={retryParse}
		>
			{retrying ? 'Retrying...' : 'Retry'}
		</button>
	</div>
</div>
