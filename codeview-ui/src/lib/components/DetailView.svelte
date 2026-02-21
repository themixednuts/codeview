<script lang="ts">
	import type { Node, NodeKind, Graph } from '$lib/graph';
	import type { Edge } from '$lib/graph';
	import type { LayoutMode } from '$lib/components/LayoutSwitcher.svelte';
	import type { VizMode } from '$lib/components/VizSwitcher.svelte';
	import type { GraphRenderMode } from '$lib/components/CrateGraph.svelte';
	import type { NodeView } from '$lib/schema';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { browser } from '$app/environment';
	import { getNodeView } from '$lib/rpc/nodeView.remote';
	import { getCrateMap } from '$lib/rpc/crateMap.remote';
	import { Memo } from '$lib/reactivity.svelte';
	import { perf } from '$lib/perf';
	import { kindLabels, visibilityLabels, edgeLabels } from '$lib/display-names';

	type SelectedEdges = {
		incoming: Edge[];
		outgoing: Edge[];
	};
	import Breadcrumbs from '$lib/components/Breadcrumbs.svelte';
	import { LoaderCircleIcon } from '@lucide/svelte';
	import RelationshipGraph from '$lib/components/RelationshipGraph.svelte';
	import VizSwitcher from '$lib/components/VizSwitcher.svelte';
	import CrateTreemap from '$lib/components/CrateTreemap.svelte';
	import CrateSunburst from '$lib/components/CrateSunburst.svelte';
	import CrateGrid from '$lib/components/CrateGrid.svelte';
	import CrateGraph from '$lib/components/CrateGraph.svelte';
	import LayoutSwitcher from '$lib/components/LayoutSwitcher.svelte';
	import NodeDetails from '$lib/components/NodeDetails.svelte';
	import Skeleton from '$lib/components/Skeleton.svelte';
	import { getLogger } from '$lib/log';

	import {
		resolvedThemeCtx,
		getNodeUrlCtx,
		crateVersionsCtx,
		crateStatusCtx,
		parseProgressCtx,
		setExpandPathCtx,
		type ExpandPath,
	} from '$lib/context';

	let { nodeId } = $props<{
		nodeId: string;
	}>();

	const theme = $derived(resolvedThemeCtx.get());
	const getNodeUrl = $derived(getNodeUrlCtx.get());
	const crateVersions = $derived(crateVersionsCtx.get());
	const crateStatus = $derived(crateStatusCtx.getOr('unknown'));
	const progressConn = $derived(parseProgressCtx.getOr(null));
	const setExpandPath = $derived(setExpandPathCtx.getOr((_: ExpandPath) => {}));
	const crateName = $derived(page.params.crate);
	const crateVersion = $derived(page.params.version);
	// SSR data: layout streams nodeView as an unresolved promise so the page
	// shell renders immediately. The outer <svelte:boundary pending={…}>
	// shows a loading spinner during SSR; once the promise resolves on the
	// client, the actual content replaces it.
	// Guard with !browser: during client-side navigation the query proxy
	// handles everything. Re-awaiting the streamed promise on the client
	// causes _Batch.revive reconcile crashes during cross-crate navigation.
	const loadNodeView = $derived(
		!browser && page.data?.nodeId === nodeId && page.data?.nodeView
			? ((await page.data.nodeView) as NodeView | null)
			: null,
	);
	const nodeViewQuery = $derived(
		crateName && crateVersion
			? getNodeView({
					name: crateName,
					version: crateVersion,
					nodeId,
				})
			: null,
	);
	const nodeViewLoading = $derived(nodeViewQuery?.loading ?? false);
	const nodeView = $derived(
		(nodeViewQuery?.current as NodeView | null | undefined) ?? loadNodeView ?? null,
	);
	const rawDetail = $derived(nodeView?.detail ?? null);
	const ancestors = $derived(nodeView?.ancestors ?? []);
	// Accept the detail even if the node ID differs from the URL-derived nodeId.
	// The server resolves re-exported items (e.g. "syn::Item" → "syn::item::Item"),
	// so the returned node may have a different canonical ID.
	const detail = $derived(rawDetail ?? null);
	const log = getLogger('detail-view');

	// ── Crate map: always fetched (not just for Crate nodes) ──
	const crateMapQuery = $derived(
		crateName && crateVersion
			? getCrateMap({
					name: crateName,
					version: crateVersion,
				})
			: null,
	);
	const crateMapLoading = $derived(crateMapQuery?.loading ?? false);
	const crateMap = $derived(crateMapQuery?.current ?? null);

	// Refresh both queries when parsing completes
	$effect(() => {
		if (crateStatus !== 'ready') return;
		if (!crateName || !crateVersion) return;
		if (!nodeViewQuery) return;
		log.debug`status ready: refreshing nodeView+crateMap ${crateName}@${crateVersion} nodeId="${nodeId}"`;
		void nodeViewQuery.refresh().catch((error: unknown) => {
			log.warn`nodeView refresh failed for ${crateName}@${crateVersion} nodeId="${nodeId}": ${String(error)}`;
		});
		void crateMapQuery?.refresh().catch((error: unknown) => {
			log.warn`crateMap refresh failed for ${crateName}@${crateVersion}: ${String(error)}`;
		});
	});

	// Redirect to canonical URL when server resolves a re-exported node ID.
	$effect(() => {
		if (!rawDetail?.node || !getNodeUrl) return;
		if (rawDetail.node.id === nodeId) return;
		log.info`re-export redirect: "${nodeId}" → "${rawDetail.node.id}"`;
		goto(resolve(getNodeUrl(rawDetail.node.id) as `/${string}`), { replaceState: true });
	});
	$effect(() => {
		log.debug`nodeView changed: nodeId="${nodeId}" selected="${selected?.id ?? 'null'}" ancestors=${ancestors.length} detail=${detail ? 'yes' : 'null'} graph=${relationshipGraph ? `${relationshipGraph.nodes.length}n` : 'null'}`;
	});

	// Push ancestor path to GraphTree via context — tells tree which nodes to expand
	$effect(() => {
		if (nodeView?.ancestors) {
			setExpandPath({ ancestors: nodeView.ancestors });
		} else {
			setExpandPath(null);
		}
	});

	// ── Viz mode (crate overview — 3 modes, graph is standalone) ──
	const VALID_VIZ_MODES: VizMode[] = ['treemap', 'sunburst', 'grid'];
	const vizParam = $derived(page.url.searchParams.get('viz'));
	const vizMode: VizMode = $derived(
		VALID_VIZ_MODES.includes(vizParam as VizMode) ? (vizParam as VizMode) : 'treemap',
	);

	function setVizMode(mode: VizMode) {
		const url = new URL(page.url);
		if (mode === 'treemap') {
			url.searchParams.delete('viz');
		} else {
			url.searchParams.set('viz', mode);
		}
		goto(resolve((url.pathname + url.search) as `/${string}`), {
			replaceState: true,
			noScroll: true,
			keepFocus: true,
		});
	}

	// ── Graph render mode (standalone module graph) ──
	const graphModeParam = $derived(page.url.searchParams.get('gm'));
	const graphRenderMode: GraphRenderMode = $derived(
		graphModeParam === 'dots' ? 'dots' : 'normal',
	);

	function setGraphRenderMode(mode: GraphRenderMode) {
		updateSearchParam('gm', mode === 'normal' ? null : mode);
	}

	// ── Treemap drill state ──
	const treemapDrillId = $derived(page.url.searchParams.get('td'));

	function setTreemapDrill(id: string | null) {
		updateSearchParam('td', id);
	}

	// ── Sunburst drill state ──
	const sunburstDrillId = $derived(page.url.searchParams.get('sd'));

	function setSunburstDrill(id: string | null) {
		updateSearchParam('sd', id);
	}

	// ── Layout mode (relationship graph) ──
	const VALID_LAYOUTS: LayoutMode[] = ['ego', 'force', 'hierarchical', 'radial'];
	const layoutParam = $derived(page.url.searchParams.get('layout'));
	const layoutMode: LayoutMode = $derived(
		VALID_LAYOUTS.includes(layoutParam as LayoutMode) ? (layoutParam as LayoutMode) : 'ego',
	);

	function setLayoutMode(mode: LayoutMode) {
		const url = new URL(page.url);
		if (mode === 'ego') {
			url.searchParams.delete('layout');
		} else {
			url.searchParams.set('layout', mode);
		}
		goto(resolve((url.pathname + url.search) as `/${string}`), {
			replaceState: true,
			noScroll: true,
			keepFocus: true,
		});
	}

	// Edge filter toggles — default: structural=off, semantic=on
	const showStructural = $derived(page.url.searchParams.get('structural') === '1');
	const showSemantic = $derived(page.url.searchParams.get('semantic') !== '0');

	// Internal: bypass projection to show raw graph for side-by-side comparison
	const bypassProjection = $derived(page.url.searchParams.get('raw') === '1');

	function updateSearchParam(key: string, value: string | null) {
		const url = new URL(page.url);
		if (value === null) {
			url.searchParams.delete(key);
		} else {
			url.searchParams.set(key, value);
		}
		goto(resolve((url.pathname + url.search) as `/${string}`), {
			replaceState: true,
			noScroll: true,
			keepFocus: true,
		});
	}

	function toggleStructural() {
		updateSearchParam('structural', showStructural ? null : '1');
	}

	function toggleSemantic() {
		updateSearchParam('semantic', showSemantic ? '0' : null);
	}

	const selected = $derived(detail?.node ?? null);
	const isOnCrateRoot = $derived(selected?.kind === 'Crate');

	const selectedEdges = $derived.by<SelectedEdges>(() => {
		if (!detail) return { incoming: [], outgoing: [] };
		return perf.time(
			'derived',
			'selectedEdges',
			() => ({
				incoming: detail!.edges.filter((e) => e.to === detail!.node.id),
				outgoing: detail!.edges.filter((e) => e.from === detail!.node.id),
			}),
			{ detail: (r) => `${r.incoming.length}in ${r.outgoing.length}out` },
		);
	});

	// Pre-built lookup maps — O(1) instead of O(n) per call
	const relatedNodeMap = $derived.by(() => {
		if (!detail) return new Map<string, Node>();
		return new Map(detail.relatedNodes.map((n) => [n.id, n as Node]));
	});

	function displayNode(id: string) {
		return relatedNodeMap.get(id)?.name ?? id.split('::').pop() ?? id;
	}

	function nodeExists(nodeId: string): boolean {
		return relatedNodeMap.has(nodeId);
	}

	function nodeMeta(nodeId: string): { is_external?: boolean; kind?: NodeKind } | undefined {
		return relatedNodeMap.get(nodeId);
	}

	// Build a mini-graph for the relationship graph visualization
	const relationshipGraphMemo = new Memo(
		() => {
			if (!detail) return null;
			return perf.time(
				'derived',
				'relationshipGraph',
				() => {
					const allNodes: Node[] = [detail!.node];
					for (const n of relatedNodeMap.values()) {
						allNodes.push({
							...n,
							span: undefined,
							attrs: [],
							fields: undefined,
							variants: undefined,
							signature: undefined,
							generics: undefined,
							docs: undefined,
						} as Node);
					}
					return { nodes: allNodes, edges: detail!.edges } as Graph;
				},
				{
					detail: (r) => `${r.nodes.length}n ${r.edges.length}e`,
				},
			);
		},
		(a, b) =>
			a === b ||
			(a != null && b != null && a.nodes.length === b.nodes.length && a.edges === b.edges),
	);
	const relationshipGraph = $derived(relationshipGraphMemo.current);

	function isTraitImpl(node: Node): boolean {
		if (node.kind !== 'Impl') return false;
		return node.impl_type === 'Trait' || node.name.includes(' for ');
	}

	function isInherentImpl(node: Node): boolean {
		if (node.kind !== 'Impl') return false;
		return (
			node.impl_type === 'Inherent' || (!node.name.includes(' for ') && node.impl_type !== 'Trait')
		);
	}

	type MethodGroup = { impl: Node; methods: Node[] };

	const implBlocks = $derived.by(() => {
		if (!detail || !selected) return [] as Node[];
		return perf.time(
			'derived',
			'implBlocks',
			() => {
				const blocks: Node[] = [];
				for (const edge of detail!.edges) {
					if (edge.kind === 'Defines' && edge.from === selected!.id) {
						const target = relatedNodeMap.get(edge.to);
						if (target && isTraitImpl(target)) blocks.push(target);
					}
				}
				return blocks;
			},
			{ detail: (r) => `${r.length} impls` },
		);
	});

	// Split trait impls into source (user-written) and blanket/auto-trait
	const sourceImpls = $derived(implBlocks.filter((b) => !b.is_external));
	const blanketImpls = $derived(implBlocks.filter((b) => b.is_external));

	// Build a set of impl block IDs for edge filtering
	const implBlockIds = $derived(new Set(implBlocks.map((b) => b.id)));

	// Filter out redundant edges: Defines→impl and incoming UsesType←impl
	const filteredEdges = $derived.by<SelectedEdges>(() => {
		if (!detail) return { incoming: [], outgoing: [] };
		const isTypeNode = ['Struct', 'Enum', 'Union', 'Trait', 'TraitAlias', 'TypeAlias'].includes(
			selected?.kind ?? '',
		);
		if (!isTypeNode) return selectedEdges;
		return perf.time(
			'derived',
			'detailFilteredEdges',
			() => ({
				outgoing: selectedEdges.outgoing.filter((e) => {
					if (e.kind === 'Defines' && implBlockIds.has(e.to)) return false;
					return true;
				}),
				incoming: selectedEdges.incoming.filter((e) => {
					if (e.kind === 'UsesType' && implBlockIds.has(e.from)) return false;
					return true;
				}),
			}),
			{ detail: (r) => `${r.incoming.length}in ${r.outgoing.length}out` },
		);
	});

	const methodGroups = $derived.by(() => {
		if (!detail || !selected) return [] as MethodGroup[];
		return perf.time(
			'derived',
			'methodGroups',
			() => {
				const inherentImpls: Node[] = [];
				for (const edge of detail!.edges) {
					if (edge.kind === 'Defines' && edge.from === selected!.id) {
						const target = relatedNodeMap.get(edge.to);
						if (target && isInherentImpl(target)) inherentImpls.push(target);
					}
				}

				// eslint-disable-next-line svelte/prefer-svelte-reactivity -- local computation in derived
				const groups = new Map<string, MethodGroup>();
				for (const impl of inherentImpls) {
					groups.set(impl.id, { impl, methods: [] });
				}

				for (const edge of detail!.edges) {
					if ((edge.kind === 'Contains' || edge.kind === 'Defines') && groups.has(edge.from)) {
						const target = relatedNodeMap.get(edge.to);
						if (target && target.kind === 'Function') {
							groups.get(edge.from)?.methods.push(target);
						}
					}
				}

				return Array.from(groups.values())
					.filter((g) => g.methods.length > 0)
					.map((g) => {
						g.methods.sort((a, b) => a.name.localeCompare(b.name));
						return g;
					});
			},
			{
				detail: (r) => `${r.length} groups, ${r.reduce((s, g) => s + g.methods.length, 0)} methods`,
			},
		);
	});
</script>

<svelte:boundary>
	{#if selected && detail}
		<div class="space-y-6">
			<!-- Breadcrumbs -->
			<svelte:boundary>
				<Breadcrumbs {ancestors} {selected} {getNodeUrl} />
				{#snippet failed(error: unknown, _reset: () => void)}
					{@const _ = log.error`Breadcrumbs boundary error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)} nodeId="${nodeId}" selected="${selected?.id}" ancestors=${ancestors.length}`}
					<div class="text-xs text-(--danger)">Failed to load breadcrumbs</div>
				{/snippet}
			</svelte:boundary>

			<!-- Standalone Module Graph (crate root only) -->
			{#if isOnCrateRoot && crateMap}
				<svelte:boundary>
					<CrateGraph
						data={crateMap}
						selectedNodeId={nodeId}
						{getNodeUrl}
						renderMode={graphRenderMode}
						onRenderModeChange={setGraphRenderMode}
					/>
					{#snippet failed(error: unknown, reset: () => void)}
						{@const _ = log.error`CrateGraph boundary: ${error instanceof Error ? (error.stack ?? error.message) : String(error)} nodeId="${nodeId}"`}
						<div
							class="corner-squircle rounded-(--radius-card) border border-(--danger-border) bg-(--danger-bg) p-4 text-sm text-(--danger)"
						>
							<p class="font-medium">Failed to render module graph</p>
							<button type="button" class="mt-2 text-(--accent) hover:underline" onclick={reset}>
								Try again
							</button>
						</div>
					{/snippet}
				</svelte:boundary>
			{/if}

			<!-- Crate Overview: VizSwitcher + selected visualization (always visible) -->
			<svelte:boundary>
				{#if crateMap}
					<div class="space-y-3">
						<div class="flex items-center justify-between">
							<VizSwitcher mode={vizMode} onModeChange={setVizMode} />
						</div>
						{#if vizMode === 'treemap'}
							<CrateTreemap data={crateMap} selectedNodeId={nodeId} {getNodeUrl} drillId={treemapDrillId} onDrillChange={setTreemapDrill} />
						{:else if vizMode === 'sunburst'}
							<CrateSunburst data={crateMap} selectedNodeId={nodeId} {getNodeUrl} drillId={sunburstDrillId} onDrillChange={setSunburstDrill} />
						{:else if vizMode === 'grid'}
							<CrateGrid data={crateMap} selectedNodeId={nodeId} {getNodeUrl} />
						{/if}
					</div>
				{:else if crateMapLoading}
					<div
						class="corner-squircle flex min-h-[340px] items-center justify-center rounded-(--radius-card) border border-(--panel-border) bg-(--panel-solid) p-4"
					>
						<p class="text-sm text-(--muted)">Building crate module map…</p>
					</div>
				{/if}
				{#snippet failed(error: unknown, reset: () => void)}
					{@const _ = log.error`CrateViz boundary: ${error instanceof Error ? (error.stack ?? error.message) : String(error)} nodeId="${nodeId}"`}
					<div
						class="corner-squircle rounded-(--radius-card) border border-(--danger-border) bg-(--danger-bg) p-4 text-sm text-(--danger)"
					>
						<p class="font-medium">Failed to render crate visualization</p>
						<button type="button" class="mt-2 text-(--accent) hover:underline" onclick={reset}>
							Try again
						</button>
					</div>
				{/snippet}
			</svelte:boundary>

			<!-- Relationship Graph (only for non-crate nodes — adds detail on top of overview) -->
			{#if !isOnCrateRoot && relationshipGraph}
				<div class="flex items-center justify-end">
					<LayoutSwitcher mode={layoutMode} onModeChange={setLayoutMode} />
				</div>
				<svelte:boundary>
					<RelationshipGraph
						graph={relationshipGraph}
						{selected}
						{getNodeUrl}
						{layoutMode}
						{showStructural}
						{showSemantic}
						{bypassProjection}
						onToggleStructural={toggleStructural}
						onToggleSemantic={toggleSemantic}
					/>
					{#snippet failed(error: unknown, reset: () => void)}
						{@const _ = log.error`RelationshipGraph boundary: ${error instanceof Error ? (error.stack ?? error.message) : String(error)} nodeId="${nodeId}"`}
						<div
							class="corner-squircle rounded-(--radius-card) border border-(--danger-border) bg-(--danger-bg) p-4 text-sm text-(--danger)"
						>
							<p class="font-medium">Failed to render relationship graph</p>
							<button type="button" class="mt-2 text-(--accent) hover:underline" onclick={reset}>
								Try again
							</button>
						</div>
					{/snippet}
				</svelte:boundary>
			{/if}

			<!-- Node Details -->
			<svelte:boundary>
				<NodeDetails
					{selected}
					selectedEdges={filteredEdges}
					{sourceImpls}
					{blanketImpls}
					{methodGroups}
					{kindLabels}
					{visibilityLabels}
					{edgeLabels}
					{displayNode}
					{theme}
					{getNodeUrl}
					{nodeExists}
					{nodeMeta}
					{crateName}
					{crateVersion}
					{crateVersions}
				/>
				{#snippet failed(error: unknown, reset: () => void)}
					{@const _ = log.error`NodeDetails boundary: ${error instanceof Error ? (error.stack ?? error.message) : String(error)} nodeId="${nodeId}"`}
					<div
						class="corner-squircle rounded-(--radius-card) border border-(--danger-border) bg-(--danger-bg) p-4 text-sm text-(--danger)"
					>
						<p class="font-medium">Failed to render node details</p>
						<button type="button" class="mt-2 text-(--accent) hover:underline" onclick={reset}>
							Try again
						</button>
					</div>
				{/snippet}
			</svelte:boundary>
		</div>
	{:else if crateStatus === 'processing' || crateStatus === 'unknown' || (crateStatus === 'ready' && !detail && nodeViewLoading)}
		<div class="flex h-full items-center justify-center">
			<div class="flex flex-col items-center gap-3 text-center text-(--muted)">
				<LoaderCircleIcon class="animate-spin" size={24} />
				<p class="text-sm">
					{crateStatus === 'ready' ? 'Loading node details…' : 'Parsing crate data…'}
				</p>
				{#if progressConn && progressConn.nodeCount > 0}
					<p class="font-mono text-xs tabular-nums">
						{progressConn.nodeCount.toLocaleString()} nodes discovered
					</p>
				{/if}
			</div>
		</div>
	{:else}
		<div class="flex h-full items-center justify-center">
			<div class="text-center text-(--muted)">
				<p class="text-lg">Node not found</p>
				<p class="mt-1 text-sm">The requested item could not be found in the graph.</p>
			</div>
		</div>
	{/if}
	{#snippet pending()}
		<div class="flex h-full items-center justify-center">
			<div class="flex flex-col items-center gap-3 text-center text-(--muted)">
				<LoaderCircleIcon class="animate-spin" size={24} />
				<p class="text-sm">Loading node details…</p>
			</div>
		</div>
	{/snippet}
	{#snippet failed(error, reset)}
		{@const _ = log.error`DetailView outer boundary: ${error instanceof Error ? (error.stack ?? error.message) : String(error)} nodeId="${nodeId}"`}
		<div class="flex h-full items-center justify-center p-6">
			<div
				class="corner-squircle max-w-md rounded-(--radius-card) border border-(--danger-border) bg-(--danger-bg) p-6 text-center"
			>
				<p class="font-medium text-(--danger)">Something went wrong</p>
				<p class="mt-2 text-sm text-(--muted)">An error occurred while loading this node.</p>
				<button
					type="button"
					class="corner-squircle mt-4 rounded-(--radius-control) bg-(--accent) px-4 py-2 text-sm text-(--on-accent) hover:opacity-90"
					onclick={reset}
				>
					Reload
				</button>
			</div>
		</div>
	{/snippet}
</svelte:boundary>
