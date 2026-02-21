<script lang="ts">
	import { installStdDocs } from '$lib/rpc/crate.remote';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';

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
	let lastFormKey = '';
	$effect(() => {
		if (!crateName || !version) return;
		const key = `${crateName}@${version}`;
		if (key === lastFormKey) return;
		lastFormKey = key;
		installForm.fields.set({ name: crateName, version });
	});

	const canInstall = $derived(!!crateName && !!version);

	function goBack() {
		void goto(resolve('/'));
	}
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
			<button
				type="submit"
				disabled={!canInstall}
				class="corner-squircle rounded-(--radius-control) bg-(--accent) px-4 py-2 text-sm font-medium text-(--on-accent) transition-opacity enabled:hover:opacity-90 disabled:opacity-60"
			>
				Install
			</button>
			<button
				type="button"
				class="corner-squircle rounded-(--radius-control) border border-(--panel-border) bg-(--panel) px-4 py-2 text-sm text-(--muted) transition-colors hover:text-(--ink)"
				onclick={goBack}
			>
				Go back
			</button>
		</form>
	</div>
</div>
