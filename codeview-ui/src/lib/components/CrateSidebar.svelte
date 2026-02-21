<script lang="ts">
	import type { NodeKind } from '$lib/graph';
	import type { NodeSummary, TreeNodeDTO } from '$lib/schema';
	import type { CrateStatusValue } from '$lib/context';
	import { kindLabels, nodeKindOrder } from '$lib/display-names';
	import CrateHeader from './CrateHeader.svelte';
	import SearchResults from './SearchResults.svelte';
	import GraphTree from './GraphTree.svelte';
	import SkeletonTree from './SkeletonTree.svelte';
	import { SearchIcon } from '@lucide/svelte';
	import { getLogger } from '$lib/log';

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
		filter,
		kindParams,
		searchQuery,
		selectedNodeId,
		treeRoots,
		canonicalCrateName,
		kindCountMap,
		activeKinds,
		kindFilter,
		rootChildren,
		status,
		progressNodeCount,
		getNodeUrl,
		onToggleKind,
		onRetryTree,
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
		filter: string;
		kindParams: string[];
		searchQuery: Promise<NodeSummary[]> | null;
		selectedNodeId: string;
		treeRoots: TreeNodeDTO[] | null;
		canonicalCrateName: string | undefined;
		kindCountMap: Map<NodeKind, number>;
		activeKinds: Set<NodeKind>;
		kindFilter: Set<NodeKind>;
		rootChildren?: { id: string; children: TreeNodeDTO[] } | null;
		status: CrateStatusValue;
		progressNodeCount: number;
		getNodeUrl: (id: string) => string;
		onToggleKind: (kind: NodeKind) => void;
		onRetryTree?: (reset: () => void) => void;
	} = $props();

	const log = getLogger('crate-sidebar');
	const orderedKinds = $derived.by(() => Array.from(new Set(nodeKindOrder)));
</script>

<div class="flex w-80 flex-col border-r border-(--panel-border) bg-(--panel)">
	<CrateHeader
		{crateName}
		{version}
		{workspaceCrateCount}
		{externalCrateCount}
		{crateVersionOptions}
		{workspaceCrates}
		{externalCrates}
		{loadingWorkspaceCrates}
		{loadingExternalCrates}
		{onVersionChange}
		{debugInfo}
	/>

	<form
		method="get"
		class="border-b border-(--panel-border) p-2"
		data-sveltekit-replacestate
		data-sveltekit-keepfocus
		data-sveltekit-noscroll
	>
		<div class="relative">
			<SearchIcon class="absolute top-1/2 left-3 -translate-y-1/2 text-(--muted)" size={14} />
			<input
				type="search"
				name="q"
				placeholder="Search items..."
				value={filter}
				class="corner-squircle w-full rounded-(--radius-control) border border-(--panel-border) bg-(--panel-solid) py-2 pr-3 pl-9 text-sm outline-none focus:border-(--accent) focus:ring-1 focus:ring-(--accent)"
			/>
			{#if kindParams.length > 0}
				{#each kindParams as kind}
					<input type="hidden" name="k" value={kind} />
				{/each}
			{/if}
		</div>
	</form>

	<svelte:boundary>
		<div class="flex flex-wrap items-center gap-1 border-b border-(--panel-border) px-2 py-1.5">
			{#each orderedKinds as kind (kind)}
				{@const count = kindCountMap.get(kind) ?? 0}
				{@const isActive = activeKinds.has(kind)}
				{@const isEmpty = count === 0}
				<button
					type="button"
					data-kind={kind}
					data-active={isActive ? 'true' : undefined}
					disabled={isEmpty}
					class="badge badge-sm transition-colors {isActive
						? 'badge-accent'
						: isEmpty
							? 'cursor-default opacity-40'
							: 'hover:bg-(--panel-strong) hover:text-(--ink)'}"
					onclick={() => !isEmpty && onToggleKind(kind)}
				>
					{kindLabels[kind]}{count > 0 ? ` (${count})` : ''}
				</button>
			{/each}
		</div>

		<div class="flex-1 overflow-auto">
			{#if filter && searchQuery}
				<SearchResults
					searchQuery={searchQuery as Promise<NodeSummary[]>}
					{filter}
					{selectedNodeId}
					{getNodeUrl}
				/>
			{:else if treeRoots && treeRoots.length > 0}
				<GraphTree
					roots={treeRoots}
					crateName={canonicalCrateName}
					crateVersion={version}
					{status}
					selectedId={selectedNodeId}
					{getNodeUrl}
					filter=""
					{kindFilter}
					{rootChildren}
				/>
			{:else if status === 'processing' || status === 'unknown'}
				<SkeletonTree count={progressNodeCount || 24} showKindBadges={false} />
			{:else}
				<div class="flex flex-col items-center justify-center gap-1 p-8 text-center">
					<div class="text-sm font-medium text-(--ink)">No data available</div>
					<div class="text-xs text-(--muted)">This crate's tree hasn't loaded yet.</div>
				</div>
			{/if}
		</div>
		{#snippet failed(error, reset)}
			{@const _ = log.error`CrateSidebar tree boundary: ${error instanceof Error ? error.stack ?? error.message : String(error)} crate=${crateName}@${version}`}
			<div class="p-4 text-sm text-(--danger)">
				<p class="font-medium">Failed to load tree</p>
				<button
					type="button"
					class="mt-2 text-(--accent) hover:underline"
					onclick={() => (onRetryTree ? onRetryTree(reset) : reset())}
				>
					Try again
				</button>
			</div>
		{/snippet}
	</svelte:boundary>
</div>
