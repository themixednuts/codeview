<script lang="ts">
	import type { Node, NodeKind, Graph } from '$lib/graph';
	import type { Edge } from '$lib/graph';
	import type { LayoutMode } from '$lib/components/LayoutSwitcher.svelte';
	import type { VizMode } from '$lib/components/VizSwitcher.svelte';
	import type { GraphRenderMode } from '$lib/components/CrateGraph.svelte';
	import type { NodeView } from '$lib/schema';
	import type { CrateMapData } from '$lib/graph/crate-map';
	import { browser } from '$app/environment';
	import { page } from '$app/state';
	import { goto, replaceState } from '$app/navigation';
	import { resolveAppPath } from '$lib/app-paths';
	import { getNodeView, getStaticNodeView } from '$lib/rpc/nodeView.remote';
	import { getCrateMap, getStaticCrateMap } from '$lib/rpc/crateMap.remote';
	import { Memo } from '$lib/reactivity.svelte';
	import { perf } from '$lib/perf';
	import { kindLabels, edgeLabels, isPublic } from '$lib/display-names';
	import { isHosted } from '$lib/platform';

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
	import DocToc from '$lib/components/DocToc.svelte';
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

	let { nodeId, embedded = false } = $props<{
		nodeId: string;
		embedded?: boolean;
	}>();

	const theme = $derived(resolvedThemeCtx.get());
	const getNodeUrl = $derived(getNodeUrlCtx.get());
	const crateVersions = $derived(crateVersionsCtx.get());
	const crateStatus = $derived(crateStatusCtx.getOr('unknown'));
	const progressConn = $derived(parseProgressCtx.getOr(null));
	const setExpandPath = $derived(setExpandPathCtx.getOr((_: ExpandPath) => {}));
	const crateName = $derived(page.params.crate);
	const crateVersion = $derived(page.params.version);
	// SSR data: nodeView is awaited by +layout.server.ts because it is primary
	// route content. Keeping this synchronous prevents the route from hydrating
	// a pending shell and shifting once the detail payload arrives.
	const loadNodeView = $derived(
		page.data?.nodeId === nodeId && page.data?.nodeView
			? (page.data.nodeView as NodeView | null)
			: null,
	);
	const nodeViewQuery = $derived(
		crateName && crateVersion && page.data?.nodeView == null
			? (isHosted ? getStaticNodeView : getNodeView)({
					name: crateName,
					version: crateVersion,
					nodeId,
				})
			: null,
	);
	const nodeViewLoading = $derived(nodeViewQuery?.loading ?? false);
	const nodeView = $derived(
		loadNodeView ?? (nodeViewQuery?.current as NodeView | null | undefined) ?? null,
	);
	const rawDetail = $derived(nodeView?.detail ?? null);
	const ancestors = $derived(nodeView?.ancestors ?? []);
	// Accept the detail even if the node ID differs from the URL-derived nodeId.
	// The server resolves re-exported items (e.g. "syn::Item" → "syn::item::Item"),
	// so the returned node may have a different canonical ID.
	const detail = $derived(rawDetail ?? null);
	const log = getLogger('detail-view');

	function refreshRemote(resource: unknown): Promise<unknown> {
		const refresh = (resource as { refresh?: () => Promise<unknown> } | null | undefined)?.refresh;
		return refresh ? refresh.call(resource) : Promise.resolve();
	}

	const loadCrateMap = $derived((page.data?.crateMap as CrateMapData | null | undefined) ?? null);

	// ── Crate map: fetched only when the server did not provide a static artifact ──
	const crateMapQuery = $derived(
		crateName && crateVersion && !loadCrateMap
			? (isHosted ? getStaticCrateMap : getCrateMap)({
					name: crateName,
					version: crateVersion,
				})
			: null,
	);
	const crateMapLoading = $derived(crateMapQuery?.loading ?? false);
	const crateMap = $derived(loadCrateMap ?? crateMapQuery?.current ?? null);

	// Refresh both queries when parsing completes (first parse only).
	// On revisit, SSR already returned data → query proxy's initial fetch is sufficient.
	$effect(() => {
		if (crateStatus !== 'ready') return;
		if (!crateName || !crateVersion) return;
		if (!nodeViewQuery) return;
		if (page.data?.nodeView != null) return;
		log.debug`status ready: refreshing nodeView+crateMap ${crateName}@${crateVersion} nodeId="${nodeId}"`;
		void refreshRemote(nodeViewQuery).catch((error: unknown) => {
			log.warn`nodeView refresh failed for ${crateName}@${crateVersion} nodeId="${nodeId}": ${String(error)}`;
		});
		void refreshRemote(crateMapQuery).catch((error: unknown) => {
			log.warn`crateMap refresh failed for ${crateName}@${crateVersion}: ${String(error)}`;
		});
	});

	// Redirect to canonical URL when server resolves a re-exported node ID,
	// but skip the redirect when the server's canonical is LONGER than the
	// URL the user came in on (an alias-expansion). Aliases come from the
	// graph's `aliases.json` and intentionally use the shorter public path
	// (e.g. `core::async_iter::AsyncIterator` aliases the canonical
	// `core::async_iter::async_iter::AsyncIterator`) — we want those URLs
	// to stick so links stay user-friendly.
	$effect(() => {
		if (!rawDetail?.node || !getNodeUrl) return;
		if (rawDetail.node.id === nodeId) return;
		const segCount = (id: string) => id.split('::').length;
		if (segCount(rawDetail.node.id) > segCount(nodeId)) return;
		log.info`re-export redirect: "${nodeId}" → "${rawDetail.node.id}"`;
		goto(resolveAppPath(getNodeUrl(rawDetail.node.id)), { replaceState: true });
	});
	$effect(() => {
		log.debug`nodeView: nodeId="${nodeId}" detail=${detail ? 'yes' : 'null'} via=${nodeViewQuery ? 'proxy' : 'ssr'}`;
	});

	// Push ancestor path to GraphTree via context — tells tree which nodes to expand
	$effect(() => {
		if (page.data?.nodeView != null) return;
		if (nodeView?.ancestors) {
			setExpandPath({ ancestors: nodeView.ancestors });
		} else {
			setExpandPath(null);
		}
	});

	// ── Viz mode (crate overview — 4 modes: graph, treemap, sunburst, grid) ──
	const VALID_VIZ_MODES: VizMode[] = ['graph', 'treemap', 'sunburst', 'grid'];
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
		goto(resolveAppPath(url.pathname + url.search), {
			replaceState: true,
			noScroll: true,
			keepFocus: true,
		});
	}

	// ── Graph render mode (module graph viz) ──
	const graphModeParam = $derived(page.url.searchParams.get('gm'));
	const graphRenderMode: GraphRenderMode = $derived(graphModeParam === 'dots' ? 'dots' : 'normal');

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
		goto(resolveAppPath(url.pathname + url.search), {
			replaceState: true,
			noScroll: true,
			keepFocus: true,
		});
	}

	// Edge filter toggles — default: structural=off, semantic=on
	const showStructural = $derived(page.url.searchParams.get('structural') === '1');
	const showSemantic = $derived(page.url.searchParams.get('semantic') !== '0');
	const showGraphBlanketImpls = $derived(page.url.searchParams.get('gbi') === '1');

	// Internal: bypass projection to show raw graph for side-by-side comparison
	const bypassProjection = $derived(page.url.searchParams.get('raw') === '1');

	function updateSearchParam(key: string, value: string | null) {
		if (!browser) return;
		const url = new URL(window.location.href);
		if (value === null) {
			url.searchParams.delete(key);
		} else {
			url.searchParams.set(key, value);
		}
		replaceState(url, page.state);
	}

	function toggleStructural() {
		updateSearchParam('structural', showStructural ? null : '1');
	}

	function toggleSemantic() {
		updateSearchParam('semantic', showSemantic ? '0' : null);
	}

	function toggleGraphBlanketImpls() {
		updateSearchParam('gbi', showGraphBlanketImpls ? null : '1');
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

	function nodeMeta(nodeId: string): Node | undefined {
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
		return (
			node.impl_type === 'Trait' ||
			node.impl_category === 'Trait' ||
			node.impl_category === 'Blanket' ||
			node.impl_category === 'Negative' ||
			node.impl_category === 'Synthetic' ||
			node.name.includes(' for ')
		);
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
	const sourceImpls = $derived(
		implBlocks.filter((b) => b.impl_category !== 'Blanket' && b.impl_category !== 'Synthetic'),
	);
	const blanketImpls = $derived(
		implBlocks.filter((b) => b.impl_category === 'Blanket' || b.impl_category === 'Synthetic'),
	);

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

	// ── Right-pane TOC entries ───────────────────────────────────────────
	const methodCount = $derived(methodGroups.reduce((sum, g) => sum + g.methods.length, 0));
	const totalImpls = $derived(sourceImpls.length + blanketImpls.length);

	type TocEntry = { anchor: string; title: string; count: number | null };
	const tocEntries = $derived.by<TocEntry[]>(() => {
		if (!selected || !detail) return [];
		const entries: TocEntry[] = [];
		if (selected.docs) entries.push({ anchor: 'documentation', title: 'Documentation', count: null });
		if (methodCount > 0) entries.push({ anchor: 'methods', title: 'Methods', count: methodCount });
		if (totalImpls > 0)
			entries.push({ anchor: 'trait-impls', title: 'Trait implementations', count: totalImpls });
		const relCount = filteredEdges.outgoing.length + filteredEdges.incoming.length;
		entries.push({ anchor: 'relationships', title: 'Relationships', count: relCount });
		if (selected.attrs && selected.attrs.length > 0)
			entries.push({ anchor: 'attributes', title: 'Attributes', count: selected.attrs.length });
		return entries;
	});

	// "Where used" — surface the top incoming-edge sources by node name.
	const whereUsed = $derived.by(() => {
		if (!detail || !selected) return [] as { id: string; name: string }[];
		const seen = new Set<string>();
		const refs: { id: string; name: string }[] = [];
		for (const edge of filteredEdges.incoming) {
			if (edge.from === selected.id || seen.has(edge.from)) continue;
			seen.add(edge.from);
			const meta = relatedNodeMap.get(edge.from);
			const name = meta?.name ?? edge.from.split('::').pop() ?? edge.from;
			refs.push({ id: edge.from, name });
			if (refs.length >= 8) break;
		}
		return refs;
	});

	function focusGraph() {
		if (!browser) return;
		const el = document.getElementById('relationships');
		if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}
</script>

<svelte:boundary>
	{#if selected && detail}
		<div class="space-y-6">
			<!-- ── Crate sub-nav ──────────────────────────────────────
				 doc-classic design: text breadcrumb + kind chip + pub
				 chip + crate-scoped search + version + View source. -->
			{#if !embedded}
				<div
					class="sub-nav -mx-4 -mt-4 mb-2 flex flex-wrap items-center gap-3 border-b border-(--panel-border-soft) bg-(--panel) px-6 py-2 md:-mx-6 md:-mt-6"
				>
					<svelte:boundary>
						<Breadcrumbs {ancestors} {selected} {getNodeUrl} />
						{#snippet failed(error: unknown, _reset: () => void)}
							{@const _ = log.error`Breadcrumbs boundary error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)} nodeId="${nodeId}" selected="${selected?.id}" ancestors=${ancestors.length}`}
							<div class="text-xs text-(--danger)">Failed to load breadcrumbs</div>
						{/snippet}
					</svelte:boundary>

					{#if selected.kind && !isOnCrateRoot}
						<span
							class="badge badge-sm inline-flex items-center gap-1.5 bg-(--panel-solid) text-(--ink)"
						>
							<span
								class="size-1.5 shrink-0 rounded-full"
								style="background-color: var(--kind-{selected.kind.toLowerCase()})"
							></span>
							{kindLabels[selected.kind] ?? selected.kind}
						</span>
					{/if}
					{#if isPublic(selected.visibility)}
						<span
							class="badge badge-sm font-mono font-semibold tracking-wider uppercase"
							style="background: var(--accent-soft); color: var(--accent-strong); border-color: transparent;"
						>
							pub
						</span>
					{/if}

					<div class="ml-auto flex flex-wrap items-center gap-2">
						{#if crateVersion}
							<span
								class="corner-squircle inline-flex items-center gap-1 rounded-(--radius-control) border border-(--panel-border) bg-(--panel-solid) px-2.5 py-1 font-mono text-[11.5px] text-(--ink-soft)"
								title="Crate version"
							>
								v{crateVersion}
							</span>
						{/if}
						{#if selected?.span?.file}
							<a
								href={resolveAppPath(getNodeUrl(selected.id))}
								class="corner-squircle rounded-(--radius-control) px-2.5 py-1 text-[12px] font-medium hover:underline"
								style="background: var(--accent-soft); color: var(--accent-strong);"
							>
								View source
							</a>
						{/if}
					</div>
				</div>
			{/if}

			<!-- Crate Overview: unified viz switcher (crate root only) -->
			{#if isOnCrateRoot}
				<svelte:boundary>
					{#if crateMap}
						<div class="space-y-3">
							<div class="flex items-center justify-between">
								<VizSwitcher mode={vizMode} onModeChange={setVizMode} />
							</div>
							{#if vizMode === 'graph'}
								<CrateGraph
									data={crateMap}
									selectedNodeId={nodeId}
									{getNodeUrl}
									renderMode={graphRenderMode}
									onRenderModeChange={setGraphRenderMode}
								/>
							{:else if vizMode === 'treemap'}
								<CrateTreemap
									data={crateMap}
									selectedNodeId={nodeId}
									{getNodeUrl}
									drillId={treemapDrillId}
									onDrillChange={setTreemapDrill}
								/>
							{:else if vizMode === 'sunburst'}
								<CrateSunburst
									data={crateMap}
									selectedNodeId={nodeId}
									{getNodeUrl}
									drillId={sunburstDrillId}
									onDrillChange={setSunburstDrill}
								/>
							{:else if vizMode === 'grid'}
								<CrateGrid data={crateMap} selectedNodeId={nodeId} {getNodeUrl} />
							{/if}
						</div>
					{:else if crateMapLoading}
						<div
							class="corner-squircle flex min-h-[200px] items-center justify-center rounded-(--radius-card) border border-(--panel-border) bg-(--panel-solid) p-4"
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
			{/if}

			<!-- doc-classic three-pane: body | TOC.
				 The left tree lives in [crate]/[version]/+layout.svelte.
				 Crate-root pages show the viz switcher above with no TOC. -->
			{#if isOnCrateRoot}
				<svelte:boundary>
					<NodeDetails
						{selected}
						selectedEdges={filteredEdges}
						{sourceImpls}
						{blanketImpls}
						{methodGroups}
						{kindLabels}
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
			{:else}
				<div class="doc-body-grid grid gap-8 xl:grid-cols-[1fr_220px]">
					<!-- Doc body — primary reading surface. -->
					<div class="min-w-0">
						<svelte:boundary>
							<NodeDetails
								{selected}
								selectedEdges={filteredEdges}
								{sourceImpls}
								{blanketImpls}
								{methodGroups}
								{kindLabels}
								{edgeLabels}
								{displayNode}
								{theme}
								{getNodeUrl}
								{nodeExists}
								{nodeMeta}
								{crateName}
								{crateVersion}
								{crateVersions}
							>
								<!-- belowTitle slot: relationship graph card lives right
									 below the title block so the visual context appears
									 ahead of the doc prose. -->
								{#snippet belowTitle()}
									{#if relationshipGraph}
										<div class="mt-5 mb-6">
											<div class="mb-2 flex items-center justify-end">
												<LayoutSwitcher mode={layoutMode} onModeChange={setLayoutMode} />
											</div>
											<div class="relationship-graph-cap">
												<svelte:boundary>
													<RelationshipGraph
														graph={relationshipGraph}
														{selected}
														{getNodeUrl}
														{layoutMode}
														{showStructural}
														{showSemantic}
														showBlanketImpls={showGraphBlanketImpls}
														{bypassProjection}
														onToggleStructural={toggleStructural}
														onToggleSemantic={toggleSemantic}
														onToggleBlanketImpls={toggleGraphBlanketImpls}
													/>
													{#snippet failed(error: unknown, reset: () => void)}
														{@const _ = log.error`RelationshipGraph boundary: ${error instanceof Error ? (error.stack ?? error.message) : String(error)} nodeId="${nodeId}"`}
														<div
															class="corner-squircle rounded-(--radius-card) border border-(--danger-border) bg-(--danger-bg) p-4 text-sm text-(--danger)"
														>
															<p class="font-medium">Failed to render relationship graph</p>
															<button
																type="button"
																class="mt-2 text-(--accent) hover:underline"
																onclick={reset}>Try again</button
															>
														</div>
													{/snippet}
												</svelte:boundary>
											</div>
										</div>
									{/if}
								{/snippet}
							</NodeDetails>
							{#snippet failed(error: unknown, reset: () => void)}
								{@const _ = log.error`NodeDetails boundary: ${error instanceof Error ? (error.stack ?? error.message) : String(error)} nodeId="${nodeId}"`}
								<div
									class="corner-squircle rounded-(--radius-card) border border-(--danger-border) bg-(--danger-bg) p-4 text-sm text-(--danger)"
								>
									<p class="font-medium">Failed to render node details</p>
									<button
										type="button"
										class="mt-2 text-(--accent) hover:underline"
										onclick={reset}>Try again</button
									>
								</div>
							{/snippet}
						</svelte:boundary>
					</div>

					<!-- TOC sidebar -->
					<div class="hidden xl:block">
						<DocToc
							entries={tocEntries}
							related={whereUsed}
							{getNodeUrl}
							onOpenGraph={focusGraph}
							{nodeId}
						/>
					</div>
				</div>
			{/if}
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

<style>
	/* Cap the relationship-graph card so it doesn't dominate the doc page.
	   Targets the inner graph container with !important so it overrides
	   the component's own min-h utility. */
	.relationship-graph-cap :global(.graph-container) {
		height: 360px !important;
		min-height: 0 !important;
	}
</style>
