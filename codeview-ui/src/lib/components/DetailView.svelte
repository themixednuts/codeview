<script lang="ts">
	import type { Node, NodeKind } from '$lib/graph';
	import type { VizMode } from '$lib/components/VizSwitcher.svelte';
	import type { NodeView } from '$lib/schema';
	import type { CrateMapData } from '$lib/graph/crate-map';
	import { browser } from '$app/environment';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { resolveAppPath } from '$lib/app-paths';
	import { getNodeView, getStaticNodeView } from '$lib/rpc/nodeView.remote';
	import { getCrateMap, getStaticCrateMap } from '$lib/rpc/crateMap.remote';
	import { kindLabels, edgeLabels, isPublic } from '$lib/display-names';
	import { materializeDetailDocModel } from '$lib/detail-model';
	import { isHosted } from '$lib/platform';
	import { parseExplorerState, serializeExplorerState } from '$lib/url-state';
	import Breadcrumbs from '$lib/components/Breadcrumbs.svelte';
	import { LoaderCircleIcon } from '@lucide/svelte';
	import FocusGraphFlow from '$lib/components/design/graph/FocusGraphFlow.svelte';
	import CrateOverviewFlow from '$lib/components/design/graph/CrateOverviewFlow.svelte';
	import VizSwitcher from '$lib/components/VizSwitcher.svelte';
	import CrateTreemap from '$lib/components/CrateTreemap.svelte';
	import CrateSunburst from '$lib/components/CrateSunburst.svelte';
	import CrateGrid from '$lib/components/CrateGrid.svelte';
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

	const LARGE_CRATE_GRAPH_DEFAULT_MODULES = 96;
	const LARGE_CRATE_GRAPH_DEFAULT_NODES = 5_000;

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
	const defaultVizMode: VizMode = $derived(isLargeCrateMap(crateMap) ? 'grid' : 'graph');
	const viewState = $derived(parseExplorerState(page.url));

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

	// Push ancestor path to explorer context so the tree expands to the selected node.
	$effect(() => {
		if (page.data?.nodeView != null) return;
		if (nodeView?.ancestors) {
			setExpandPath({ ancestors: nodeView.ancestors });
		} else {
			setExpandPath(null);
		}
	});

	// ── Viz mode (crate overview — 4 modes: graph, treemap, sunburst, grid) ──
	const vizMode: VizMode = $derived(viewState.viz ?? defaultVizMode);

	function setVizMode(mode: VizMode) {
		goto(serializeExplorerState(page.url, { viz: mode === defaultVizMode ? null : mode }), {
			replaceState: true,
			noScroll: true,
			keepFocus: true,
		});
	}

	function isLargeCrateMap(map: CrateMapData | null | undefined): boolean {
		return Boolean(
			map &&
				(map.moduleNodes.length > LARGE_CRATE_GRAPH_DEFAULT_MODULES ||
					map.totalNodeCount > LARGE_CRATE_GRAPH_DEFAULT_NODES),
		);
	}

	// ── Treemap drill state ──
	const treemapDrillId = $derived(viewState.td);

	function setTreemapDrill(id: string | null) {
		updateSearchParam('td', id);
	}

	// ── Sunburst drill state ──
	const sunburstDrillId = $derived(viewState.sd);

	function setSunburstDrill(id: string | null) {
		updateSearchParam('sd', id);
	}

	function updateSearchParam(key: 'td' | 'sd', value: string | null) {
		const patch = key === 'td' ? { td: value } : { sd: value };
		goto(serializeExplorerState(page.url, patch), {
			replaceState: true,
			noScroll: true,
			keepFocus: true,
		});
	}

	const selected = $derived(detail?.node ?? null);
	const isOnCrateRoot = $derived(selected?.kind === 'Crate');
	const detailModel = $derived(materializeDetailDocModel(nodeView?.docModel, detail));
	const selectedEdges = $derived(detailModel.selectedEdges);

	// Pre-built lookup maps — O(1) instead of O(n) per call
	const relatedNodeMap = $derived(detailModel.relatedNodeMap);

	function displayNode(id: string) {
		return relatedNodeMap.get(id)?.name ?? id.split('::').pop() ?? id;
	}

	function nodeExists(nodeId: string): boolean {
		return relatedNodeMap.has(nodeId);
	}

	function nodeMeta(nodeId: string): Node | undefined {
		return relatedNodeMap.get(nodeId);
	}

	// Split trait impls into source (user-written) and blanket/auto-trait
	const sourceImpls = $derived(detailModel.sourceImpls);
	const blanketImpls = $derived(detailModel.blanketImpls);

	// Filter out redundant edges: Defines→impl and incoming UsesType←impl
	const filteredEdges = $derived(detailModel.filteredEdges);

	const methodGroups = $derived(detailModel.methodGroups);

	// ── Right-pane TOC entries ───────────────────────────────────────────
	const tocEntries = $derived(detailModel.tocEntries);

	// "Where used" — surface the top incoming-edge sources by node name.
	const whereUsed = $derived(detailModel.whereUsed);

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
								<CrateOverviewFlow data={crateMap} selectedNodeId={nodeId} {getNodeUrl} />
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
									{#if detail}
										<div class="mt-5 mb-6">
											<svelte:boundary>
												<FocusGraphFlow
													{detail}
													{ancestors}
													crateName={crateName ?? ''}
													crateVersion={crateVersion ?? ''}
													{getNodeUrl}
													height={360}
													compact
												/>
												{#snippet failed(error: unknown, reset: () => void)}
													{@const _ = log.error`FocusGraphFlow boundary: ${error instanceof Error ? (error.stack ?? error.message) : String(error)} nodeId="${nodeId}"`}
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
