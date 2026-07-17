<script lang="ts">
	import type {
		CrateMapData,
		CrateMapModuleNode,
		CrateMapSemanticKind,
	} from '$lib/graph/crate-map';
	import { resolveAppPath } from '$lib/app-paths';
	import { findContainingModule, moduleDepthColor } from '$lib/graph/crate-map';
	import { edgeLabels } from '$lib/display-names';

	let {
		data,
		selectedNodeId = null,
		getNodeUrl,
	} = $props<{
		data: CrateMapData;
		selectedNodeId?: string | null;
		getNodeUrl: (id: string) => string;
	}>();

	const highlightedModuleId = $derived(
		selectedNodeId ? findContainingModule(selectedNodeId, data.moduleNodes) : null,
	);

	// Build edge summary per module (outgoing semantic edge count by kind)
	const edgeSummaryByModule = $derived.by(() => {
		const summaries = new Map<
			string,
			{ total: number; topKinds: Array<[CrateMapSemanticKind, number]> }
		>();
		const outgoing = new Map<string, Map<CrateMapSemanticKind, number>>();

		for (const edge of data.moduleEdges) {
			let byKind = outgoing.get(edge.from);
			if (!byKind) {
				byKind = new Map();
				outgoing.set(edge.from, byKind);
			}
			for (const [kind, count] of Object.entries(edge.kindCounts) as [string, number][]) {
				if (count > 0) {
					byKind.set(
						kind as CrateMapSemanticKind,
						(byKind.get(kind as CrateMapSemanticKind) ?? 0) + count,
					);
				}
			}
		}

		for (const [moduleId, byKind] of outgoing) {
			const entries = Array.from(byKind.entries()).sort((a, b) => b[1] - a[1]);
			const total = entries.reduce((s, [, c]) => s + c, 0);
			summaries.set(moduleId, { total, topKinds: entries.slice(0, 3) });
		}

		return summaries;
	});

	// Sort modules: root first, then by totalNodeCount descending
	const sortedModules = $derived.by(() => {
		const root = data.moduleNodes.find((m: CrateMapModuleNode) => m.parentId === null);
		const rest = data.moduleNodes
			.filter((m: CrateMapModuleNode) => m.parentId !== null)
			.sort(
				(a: CrateMapModuleNode, b: CrateMapModuleNode) =>
					b.totalNodeCount - a.totalNodeCount || a.name.localeCompare(b.name),
			);
		return root ? [root, ...rest] : rest;
	});

	// Group by depth
	const groupedByDepth = $derived.by(() => {
		const groups = new Map<number, CrateMapModuleNode[]>();
		for (const m of sortedModules) {
			let list = groups.get(m.depth);
			if (!list) {
				list = [];
				groups.set(m.depth, list);
			}
			list.push(m);
		}
		return Array.from(groups.entries()).sort((a, b) => a[0] - b[0]);
	});

	function moduleLabel(m: CrateMapModuleNode): string {
		if (m.depth <= 1) return m.name;
		const parts = m.id.split('::');
		return parts.length >= 2 ? `${parts[parts.length - 2]}::${parts[parts.length - 1]}` : m.name;
	}

	const depthColor = moduleDepthColor;

	function sizeBar(count: number, maxCount: number): number {
		if (maxCount <= 0) return 0;
		return Math.max(4, Math.round((count / maxCount) * 100));
	}

	const maxNodeCount = $derived(
		data.moduleNodes.reduce(
			(max: number, m: CrateMapModuleNode) => Math.max(max, m.totalNodeCount),
			1,
		),
	);
</script>

<div
	class="corner-squircle overflow-hidden rounded-(--radius-card) border border-(--panel-border) bg-(--panel-solid)"
>
	<div
		class="flex flex-wrap items-center justify-between gap-3 border-b border-(--panel-border) bg-(--panel) px-4 py-2"
	>
		<div>
			<p class="text-sm font-medium text-(--ink)">Module Grid</p>
			<p class="text-xs text-(--muted)">
				{data.moduleNodes.length} modules · {data.totalNodeCount.toLocaleString()} items
			</p>
		</div>
	</div>

	<div class="space-y-4 p-4">
		{#each groupedByDepth as [depth, modules] (depth)}
			<div>
				<h3 class="mb-2 text-xs font-semibold tracking-wide text-(--muted) uppercase">
					{depth === 0 ? 'Root' : `Depth ${depth}`}
					<span class="font-normal">({modules.length})</span>
				</h3>
				<div
					class="grid gap-2"
					style="grid-template-columns: repeat(auto-fill, minmax(220px, 1fr))"
				>
					{#each modules as m (m.id)}
						{@const isHighlighted = highlightedModuleId === m.id}
						{@const summary = edgeSummaryByModule.get(m.id)}
						<a
							href={resolveAppPath(getNodeUrl(m.id))}
							data-sveltekit-noscroll
							class="corner-squircle group relative flex flex-col gap-1.5 rounded-(--radius-control) border p-3 transition-all hover:shadow-sm {isHighlighted
								? 'border-(--accent) bg-(--panel-strong) shadow-sm'
								: 'border-(--panel-border) bg-(--panel-solid) hover:border-(--accent)/40'}"
						>
							<!-- Color bar -->
							<div
								class="absolute top-0 left-0 h-full w-1 rounded-l-(--radius-control)"
								style="background: {depthColor(m.depth)}"
							></div>

							<div class="ml-2 flex items-start justify-between gap-2">
								<span
									class="text-sm leading-tight font-medium text-(--ink) group-hover:text-(--accent)"
								>
									{moduleLabel(m)}
								</span>
								<span class="badge badge-sm shrink-0 tabular-nums">
									{m.totalNodeCount.toLocaleString()}
								</span>
							</div>

							<!-- Size bar -->
							<div class="ml-2">
								<div class="h-1.5 w-full overflow-hidden rounded-full bg-(--panel-muted)">
									<div
										class="h-full rounded-full transition-all"
										style="width: {sizeBar(
											m.totalNodeCount,
											maxNodeCount,
										)}%; background: {depthColor(m.depth)}; opacity: 0.6"
									></div>
								</div>
							</div>

							<div class="ml-2 flex flex-wrap items-center gap-1.5 text-2xs text-(--muted)">
								{#if m.childModuleCount > 0}
									<span>{m.childModuleCount} submodules</span>
								{/if}
								{#if m.directNodeCount > 0}
									<span>{m.directNodeCount} direct</span>
								{/if}
							</div>

							{#if summary && summary.topKinds.length > 0}
								<div class="ml-2 flex flex-wrap gap-1">
									{#each summary.topKinds as [kind, count] (kind)}
										<span class="badge badge-sm text-2xs">
											{edgeLabels[kind]}
											{count}
										</span>
									{/each}
								</div>
							{/if}
						</a>
					{/each}
				</div>
			</div>
		{/each}
	</div>
</div>
