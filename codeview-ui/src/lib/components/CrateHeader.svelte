<script lang="ts">
	import { resolve } from '$app/paths';
	import { LoaderCircleIcon } from '@lucide/svelte';

	let {
		crateName,
		version,
		workspaceCrateCount,
		externalCrateCount,
		crateVersionOptions,
		workspaceCrates,
		externalCrates,
		loadingWorkspaceCrates,
		loadingExternalCrates,
		onVersionChange,
		debugInfo,
	}: {
		crateName: string | undefined;
		version: string | undefined;
		workspaceCrateCount: number | null;
		externalCrateCount: number | null;
		crateVersionOptions: string[];
		workspaceCrates: Array<{ id: string; name?: string; version: string }>;
		externalCrates: Array<{ id: string; name?: string; version: string }>;
		loadingWorkspaceCrates: boolean;
		loadingExternalCrates: boolean;
		onVersionChange: (e: Event) => void;
		debugInfo?: {
			statusDebugKey: string;
			progressDebugKey: string;
		} | null;
	} = $props();
</script>

<div class="border-b border-l-2 border-(--panel-border) border-l-(--accent) px-3 py-2">
	<div class="flex items-center justify-between gap-2">
		<div class="flex items-center gap-2">
			<div class="text-base font-semibold text-(--ink)">{crateName}</div>
			<span class="badge badge-sm">{version}</span>
		</div>
		{#if workspaceCrateCount !== null || externalCrateCount !== null}
			<div class="font-mono text-[10px] text-(--muted)">
				{#if workspaceCrateCount !== null}
					<span>{workspaceCrateCount} workspace</span>
				{/if}
				{#if workspaceCrateCount !== null && externalCrateCount !== null}
					<span> · </span>
				{/if}
				{#if externalCrateCount !== null}
					<span>{externalCrateCount} deps</span>
				{/if}
			</div>
		{/if}
	</div>

	{#if debugInfo}
		<div
			class="mt-2 rounded-sm border border-(--panel-border) bg-(--panel-solid) px-2 py-1.5 font-mono text-[10px] text-(--muted)"
		>
			<div>statusKey: {debugInfo.statusDebugKey}</div>
			<div>progressKey: {debugInfo.progressDebugKey}</div>
		</div>
	{/if}
	{#if crateVersionOptions.length > 0}
		<div class="mt-2">
			<select
				class="corner-squircle w-full rounded-(--radius-control) border border-(--panel-border) bg-(--panel-solid) px-2 py-1 text-xs outline-none focus:border-(--accent) focus:ring-1 focus:ring-(--accent)"
				value={version}
				onchange={onVersionChange}
			>
				{#each crateVersionOptions as ver (ver)}
					<option value={ver}>{ver}</option>
				{/each}
			</select>
		</div>
	{/if}
	{#if workspaceCrates.length > 0}
		<div class="mt-2">
			<div class="text-[10px] font-semibold uppercase tracking-wide text-(--muted)">
				Workspace
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
	{/if}

	{#if externalCrates.length > 0}
		<div class="mt-2">
			<div class="text-[10px] font-semibold uppercase tracking-wide text-(--muted)">
				Dependencies
			</div>
			<div class="mt-1 flex flex-wrap gap-1">
				{#each externalCrates as c (c.id)}
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
	{:else if (loadingWorkspaceCrates || loadingExternalCrates) && workspaceCrates.length === 0}
		<div class="mt-2 flex items-center gap-2 p-1 text-xs text-(--muted)">
			<LoaderCircleIcon class="size-3 animate-spin" />
			<span>Loading crate list...</span>
		</div>
	{/if}
</div>
