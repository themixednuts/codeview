<script lang="ts">
	import { installStdDocs } from '$lib/rpc/crate.remote';
	import { resolve } from '$app/paths';
	import { Button } from '$lib/shadcn/ui/button';

	let {
		crateName,
		version,
		installedVersion,
		onInstallStart,
		onInstallError,
	}: {
		crateName: string | undefined;
		version: string | undefined;
		installedVersion?: string;
		onInstallStart?: () => void;
		onInstallError?: (message: string) => void;
	} = $props();

	const installForm = installStdDocs;
	const canInstall = $derived(!!crateName && !!version);
</script>

<div class="flex flex-1 items-center justify-center">
	<div class="max-w-md text-center">
		<div class="mb-2 text-lg font-semibold text-(--ink)">
			Install std docs for {crateName}?
		</div>
		<div class="mb-4 text-sm text-(--muted)">
			The rustdoc JSON for <code class="rounded-sm bg-(--panel-strong) px-1 py-0.5 text-xs">
				{crateName}
				{version}
			</code>
			is not installed locally.
			{#if installedVersion}
				Your current toolchain has version <code
					class="rounded-sm bg-(--panel-strong) px-1 py-0.5 text-xs"
				>
					{installedVersion}
				</code>
				.
			{/if}
			This will run
			<code class="rounded-sm bg-(--panel-strong) px-1 py-0.5 text-xs">
				rustup component add rust-docs-json
			</code>
			.
		</div>
		<form
			{...installForm.enhance(async ({ submit }) => {
				if (!canInstall) return;
				onInstallStart?.();
				try {
					await submit();
				} catch (err) {
					onInstallError?.(err instanceof Error ? err.message : String(err));
				}
			})}
			class="flex items-center justify-center gap-3"
		>
			<input type="hidden" name="name" value={crateName ?? ''} />
			<input type="hidden" name="version" value={version ?? ''} />
			<Button type="submit" disabled={!canInstall}>Install</Button>
			<Button href={resolve('/')} variant="outline">Go back</Button>
		</form>
	</div>
</div>
