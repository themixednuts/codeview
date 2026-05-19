<script lang="ts">
	import { resolve } from '$app/paths';
	import { LoaderCircleIcon } from '@lucide/svelte';

	let {
		crateName,
		version,
		workspaceCrateCount,
		crateVersionOptions,
		workspaceCrates,
		loadingWorkspaceCrates,
		onVersionChange,
		debugInfo,
		totalItems,
	}: {
		crateName: string | undefined;
		version: string | undefined;
		workspaceCrateCount: number | null;
		crateVersionOptions: string[];
		workspaceCrates: Array<{ id: string; name?: string; version: string }>;
		loadingWorkspaceCrates: boolean;
		onVersionChange: (e: Event) => void;
		debugInfo?: {
			statusDebugKey: string;
			progressDebugKey: string;
		} | null;
		totalItems?: number | null;
	} = $props();
</script>

<div class="border-b border-(--panel-border) px-3 pt-3 pb-2.5">
	<!-- doc-classic tree header: kicker label + crate name + version/items summary -->
	<div class="text-[10px] font-semibold tracking-[0.22em] text-(--muted-soft) uppercase">
		Module
	</div>
	<div class="mt-1 flex items-center justify-between gap-2">
		<a
			href={resolve(`/${crateName}/${version}`)}
			class="font-display text-[15px] font-semibold tracking-tight text-(--ink) hover:text-(--accent)"
		>
			{crateName}
		</a>
		{#if crateVersionOptions.length > 1}
			<select
				class="corner-squircle rounded-(--radius-chip) border border-(--panel-border) bg-(--panel-solid) px-1.5 py-0.5 font-mono text-[10.5px] font-medium text-(--muted) outline-none focus:border-(--accent) focus:ring-1 focus:ring-(--accent)"
				value={version}
				onchange={onVersionChange}
			>
				{#each crateVersionOptions as ver (ver)}
					<option value={ver}>{ver}</option>
				{/each}
			</select>
		{/if}
	</div>
	<div class="mt-0.5 font-mono text-[10.5px] text-(--muted-soft)">
		v{version}{#if totalItems != null} · {totalItems.toLocaleString()} items{/if}
	</div>

	{#if debugInfo}
		<div
			class="mt-2 rounded-sm border border-(--panel-border) bg-(--panel-solid) px-2 py-1.5 font-mono text-[10px] text-(--muted)"
		>
			<div>statusKey: {debugInfo.statusDebugKey}</div>
			<div>progressKey: {debugInfo.progressDebugKey}</div>
		</div>
	{/if}

	{#if workspaceCrates.length > 0}
		<div class="mt-3">
			<div class="text-[10px] font-semibold tracking-[0.18em] text-(--muted-soft) uppercase">
				{workspaceCrateCount !== null && workspaceCrateCount > 1
					? `Workspace · ${workspaceCrateCount}`
					: 'Workspace'}
			</div>
			<div class="mt-1 flex flex-wrap gap-1">
				{#each workspaceCrates as c (c.id)}
					{@const routeName = c.name ?? c.id}
					<a
						href={resolve(`/${routeName}/${c.version}`)}
						class="badge badge-sm transition-colors hover:bg-(--panel-strong) hover:text-(--ink)"
					>
						{c.name ?? c.id}
					</a>
				{/each}
			</div>
		</div>
	{:else if loadingWorkspaceCrates}
		<div class="mt-2 flex items-center gap-2 text-xs text-(--muted)">
			<LoaderCircleIcon class="size-3 animate-spin" />
			<span>Loading workspace...</span>
		</div>
	{/if}
</div>
