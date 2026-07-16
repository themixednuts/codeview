<script lang="ts">
	import { requestCrateParse } from '$lib/rpc/crate.remote';
	import { Button } from '$lib/shadcn/ui/button';

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
	const retryForm = requestCrateParse;
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
		<form
			{...retryForm.enhance(async ({ submit }) => {
				if (!canRetry || retrying) return;
				retrying = true;
				retryError = null;
				try {
					await submit();
					onRetryStart?.();
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					retryError = message;
					onRetryError?.(message);
				} finally {
					retrying = false;
				}
			})}
		>
			<input type="hidden" name="name" value={crateName ?? ''} />
			<input type="hidden" name="version" value={version ?? ''} />
			<Button type="submit" disabled={!canRetry || retrying}>
				{retrying ? 'Retrying...' : 'Retry'}
			</Button>
		</form>
	</div>
</div>
