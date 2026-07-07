<script lang="ts">
	import type { NodeKind } from '$lib/graph';
	import type { KindFacet, TreeNodeDTO } from '$lib/schema';
	import {
		getNodeUrlCtx,
		crateVersionsCtx,
		crateStatusCtx,
		parseProgressCtx,
		expandPathCtx,
		setExpandPathCtx,
		type CrateStatusValue,
		type ExpandPath,
	} from '$lib/context';
	import { page } from '$app/state';
	import { afterNavigate, beforeNavigate, goto, invalidate } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { browser } from '$app/environment';
	import type { Snippet } from 'svelte';
	import { getLocalCrates } from '$lib/rpc/crate.remote';
	import { getCrateMeta, getStaticCrateMeta } from '$lib/rpc/meta.remote';
	import { getStaticTreeRoots, getTreeRoots } from '$lib/rpc/roots.remote';
	import { searchNodes } from '$lib/rpc/search.remote';
	import { nodeIdFromPath, nodeUrl } from '$lib/url';
	import { hyphenateCrateName } from '$lib/crate-names';
	import { parseExplorerState, serializeExplorerState } from '$lib/url-state';
	import { onMount } from 'svelte';
	import CrateParseState from '$lib/components/CrateParseState.svelte';
	import LiveExplorer from '$lib/components/design/LiveExplorer.svelte';
	import { CrateStatusConnection, ParseProgressConnection } from '$lib/realtime';
	import { perf } from '$lib/perf';
	import { perfTick } from '$lib/perf.svelte';
	import { getLogger } from '$lib/log';
	import { nodeKindOrder } from '$lib/display-names';
	import { isValidCrateNameParam, isValidVersionParam } from '$lib/crate-ref';
	import { isHosted } from '$lib/platform';
	import {
		clearParseToastTarget,
		showParseToastTarget,
	} from '$lib/toast/parse-toast.svelte';

	const log = getLogger('layout');

	type LayoutData = import('./$types').LayoutData & {
		rootChildren?: { id: string; children: TreeNodeDTO[] } | null;
		prefetchedTreeChildren?: Array<{ id: string; children: TreeNodeDTO[] }>;
	};

	let { data, children } = $props<{ data: LayoutData; children: Snippet }>();

	const params = $derived(page.params);
	const crateName = $derived(params.crate);
	const version = $derived(params.version);
	const canonicalCrateName = $derived(hyphenateCrateName(crateName ?? ''));
	const hasValidCrateParam = $derived(isValidCrateNameParam(canonicalCrateName));
	const hasValidVersionParam = $derived(isValidVersionParam(version));
	const canQueryCrate = $derived(hasValidCrateParam && hasValidVersionParam);
	const viewState = $derived(parseExplorerState(page.url));

	// --- SSE connections for status and parse progress ---
	const statusConn = new CrateStatusConnection();
	const progressConn = new ParseProgressConnection();
	const loadStatus = $derived(data?.status ?? null);
	const effectiveCrateStatus: CrateStatusValue = $derived(
		statusConn.status === 'unknown' && loadStatus ? loadStatus.status : statusConn.status,
	);
	const effectiveCrateError = $derived(statusConn.error ?? loadStatus?.error ?? null);
	const effectiveCrateAction = $derived(statusConn.action ?? loadStatus?.action);
	const effectiveInstalledVersion = $derived(
		statusConn.installedVersion ?? loadStatus?.installedVersion,
	);
	let lastProgressKey = '';
	let activeRouteKey = '';
	let rafMonitor: number | null = null;
	let wasHidden = false;
	let metaRefreshInFlight: Promise<void> | null = null;
	let clientReady = $state(false);
	let routeParseToastKey = '';

	function refreshRemote(resource: unknown): Promise<unknown> {
		const refresh = (resource as { refresh?: () => Promise<unknown> } | null | undefined)?.refresh;
		return refresh ? refresh.call(resource) : Promise.resolve();
	}

	function startMainThreadMonitor() {
		if (!browser) return;
		if (!showPerfDebug) return;
		if (rafMonitor !== null) return;
		const onVisibility = () => {
			wasHidden = document.visibilityState !== 'visible';
		};
		onVisibility();
		document.addEventListener('visibilitychange', onVisibility);
		let last = performance.now();
		let lastWarnAt = 0;
		const tick = (now: number) => {
			const gap = now - last;
			if (!wasHidden && gap > 500 && gap < 10_000) {
				if (now - lastWarnAt >= 10_000) {
					lastWarnAt = now;
					log.warn`main-thread gap ${Math.round(gap)}ms route=${canonicalCrateName}@${version} status=${statusConn.status} step=${statusConn.step ?? 'none'}`;
				}
			}
			last = now;
			rafMonitor = requestAnimationFrame(tick);
		};
		rafMonitor = requestAnimationFrame(tick);
		return () => {
			document.removeEventListener('visibilitychange', onVisibility);
		};
	}

	function stopMainThreadMonitor() {
		if (rafMonitor === null) return;
		cancelAnimationFrame(rafMonitor);
		rafMonitor = null;
	}

	function refreshMeta(reason: string, force = false): Promise<void> {
		if (metaRefreshInFlight) return metaRefreshInFlight;
		if (!force && metaProxy?.current) return Promise.resolve();
		const t0 = performance.now();
		const routeLabel = `${canonicalCrateName}@${version}`;
		const metaResource = metaProxy;
		const rootsResource = rootsProxy;
		log.debug`meta refresh start ${routeLabel} reason=${reason}`;
		metaRefreshInFlight = Promise.all([refreshRemote(metaResource), refreshRemote(rootsResource)])
			.then(() => {
				const ms = Math.round(performance.now() - t0);
				log.debug`meta refresh done ${routeLabel} in ${ms}ms reason=${reason}`;
			})
			.catch((err: unknown) => {
				const errText = String(err);
				const cancelledPrimeRequest = reason === 'prime' && errText.includes('Failed to fetch');
				if (cancelledPrimeRequest) {
					log.debug`meta refresh cancelled ${routeLabel} reason=${reason}`;
					return;
				}
				log.warn`meta refresh failed ${routeLabel} reason=${reason}: ${errText}`;
			})
			.finally(() => {
				metaRefreshInFlight = null;
			});
		return metaRefreshInFlight;
	}

	function connectStatusForCurrentRoute() {
		if (!browser || !canonicalCrateName || !version || !canQueryCrate) return;
		const routeKey = `${canonicalCrateName}@${version}`;
		if (routeKey === activeRouteKey) return;
		progressConn.reset();
		lastProgressKey = '';
		activeRouteKey = routeKey;

		// Seed status from SSR data — if server returned a nodeView promise,
		// it means the server confirmed the crate is ready (not subject to withTimeout).
		if (data?.status) {
			statusConn.status = data.status.status;
			statusConn.error = data.status.error ?? null;
			statusConn.step = data.status.step ?? null;
			statusConn.action = data.status.action;
			statusConn.installedVersion = data.status.installedVersion;
			wasReady = data.status.status === 'ready';
		}
		if (data?.nodeView != null) {
			statusConn.status = 'ready';
			wasReady = true;
		}

		statusConn.connect(canonicalCrateName, version);
	}

	function connectProgressForCurrentRoute() {
		if (!browser || !canonicalCrateName || !version || !canQueryCrate) return;
		if (effectiveCrateStatus !== 'processing') return;
		const nextKey = `${canonicalCrateName}@${version}`;
		if (nextKey === lastProgressKey) return;
		lastProgressKey = nextKey;
		progressConn.connect(canonicalCrateName, version);
	}

	onMount(() => {
		clientReady = true;
		const stopMonitor = startMainThreadMonitor();
		connectStatusForCurrentRoute();
		beforeNavigate(({ to }) => {
			const leavingCrate =
				!to?.params?.crate ||
				!to?.params?.version ||
				to.params.crate !== crateName ||
				to.params.version !== version;
			if (leavingCrate) {
				activeRouteKey = '';
				lastProgressKey = '';
				progressConn.reset();
				statusConn.disconnect();
			}
		});
		afterNavigate(() => {
			connectStatusForCurrentRoute();
			connectProgressForCurrentRoute();
		});
		return () => {
			stopMonitor?.();
			stopMainThreadMonitor();
			statusConn.disconnect();
			progressConn.disconnect();
		};
	});

	// ── Expand path context (ancestor IDs from nodeView → explorer tree) ──
	const serverExpandPath: ExpandPath = $derived(
		data?.nodeView?.ancestors?.length ? { ancestors: data.nodeView.ancestors } : null,
	);
	let detailExpandPath = $state.raw<ExpandPath>(null);
	const currentExpandPath: ExpandPath = $derived(detailExpandPath ?? serverExpandPath);
	expandPathCtx.set(() => currentExpandPath);
	setExpandPathCtx.set(() => (path: ExpandPath) => {
		detailExpandPath = path;
	});

	// ── Context setup (must be before any $derived(await …) async boundary) ──
	// Getters are closures — called lazily by child components after init.
	getNodeUrlCtx.set(() => getNodeUrl);
	crateVersionsCtx.set(() => crateVersions);
	crateStatusCtx.set(() => effectiveCrateStatus);
	parseProgressCtx.set(() => progressConn);

	// Refresh roots once when first parse progress arrives (partial data becomes available)
	let hasRefreshedDuringParse = $state(false);
	$effect(() => {
		const nc = progressConn.nodeCount;
		const status = effectiveCrateStatus;
		const hasRoots = (rootsProxy?.current?.length ?? 0) > 0;
		if (status === 'processing' && nc >= 200 && !hasRefreshedDuringParse && !hasRoots) {
			hasRefreshedDuringParse = true;
			log.debug`partial data available (nodes=${nc}), refreshing roots`;
			void refreshMeta('partial-data', true);
		}
		// Reset flag on crate change
		if (status === 'unknown') hasRefreshedDuringParse = false;
	});

	// Status transitions
	let wasReady = $state(false);
	let hasObservedStatus = false;
	$effect(() => {
		const currentStatus = effectiveCrateStatus;
		const currentStep = statusConn.step;
		const hasRoots = (rootsProxy?.current?.length ?? 0) > 0;

		if (!crateName || !version) {
			wasReady = false;
			return;
		}

		connectProgressForCurrentRoute();

		log.debug`status: ${currentStatus} step=${currentStep ?? 'none'} for ${crateName}@${version}`;
		if (currentStatus === 'failed') {
			log.warn`status=failed ${crateName}@${version} error=${statusConn.error ?? '(none)'} action=${statusConn.action ?? 'none'}`;
		}

		// Query data arrived before status SSE — promote to ready
		if (currentStatus === 'unknown' && hasRoots) {
			statusConn.status = 'ready';
			statusConn.step = null;
			progressConn.reset();
		}

		const isReady = currentStatus === 'ready';
		if (!hasObservedStatus) {
			hasObservedStatus = true;
			wasReady = isReady;
			return;
		}
		if (isReady && !wasReady) {
			progressConn.disconnect();
			// Re-run server load to get fresh data now that the crate is ready.
			// This is the primary data path — invalidate() triggers +layout.server.ts
			// which fetches meta, roots, nodeView from the provider.
			log.debug`status→ready: invalidating server data`;
			void invalidate('app:crateData');
			// Also refresh query proxies for SWR cache warming
			void refreshMeta('ready', true);
		}

		wasReady = isReady;
	});

	// --- Queries ---

	// Local CLI workspace list. Hosted mode uses the crate index instead.
	const localCratesQuery = $derived(clientReady && !isHosted ? getLocalCrates() : null);
	const localCrates = $derived(localCratesQuery?.current ?? null);

	// Client-side remote resources. Hosted/static reads use prerender remotes for
	// browser cache persistence; local keeps queries so parse-progress refreshes work.
	// During SSR, data comes from the load function (data prop) — creating
	// query proxies during SSR makes the component implicitly async, which
	// causes <svelte:boundary> to render its pending snippet.
	const canClientQuery = $derived(clientReady && canQueryCrate);
	const metaProxy = $derived(
		canClientQuery
			? (isHosted ? getStaticCrateMeta : getCrateMeta)({
					name: canonicalCrateName,
					version,
					mode: 'structural',
					includeExternal: false,
				})
			: null,
	);

	const rootsProxy = $derived(
		canClientQuery
			? (isHosted ? getStaticTreeRoots : getTreeRoots)({
					name: canonicalCrateName,
					version,
					mode: 'structural',
					includeExternal: false,
				})
			: null,
	);

	const indexFromProxy = $derived(metaProxy?.current?.index ?? null);

	const crateVersions = $derived.by(() => {
		const map: Record<string, string> = {};
		if (localCrates && localCrates.length > 0) {
			for (const c of localCrates) {
				map[c.id] = c.version;
				if (c.name && c.name !== c.id) map[c.name] = c.version;
			}
		}
		if (indexFromProxy) {
			for (const c of indexFromProxy.crates) {
				if (!map[c.id]) map[c.id] = c.version;
				if (c.name && c.name !== c.id && !map[c.name]) map[c.name] = c.version;
			}
		}
		if (canonicalCrateName && version && !map[canonicalCrateName]) {
			map[canonicalCrateName] = version;
		}
		return map;
	});

	function onVersionChange(e: Event) {
		const target = e.currentTarget as HTMLSelectElement | null;
		if (!target) return;
		const nextVersion = target.value;
		if (!canonicalCrateName || !nextVersion || nextVersion === version) return;
		const nextPath = page.params.path ? `/${page.params.path}` : '';
		const search = page.url.search;
		goto(resolve(`/${canonicalCrateName}/${nextVersion}${nextPath}${search}`), {
			replaceState: false,
			noScroll: true,
			keepFocus: true,
		});
	}

	function getNodeUrl(id: string): string {
		const base = nodeUrl(id, crateVersions);
		const target = new URL(base, page.url);
		const currentCratePrefix = `/${canonicalCrateName}/${version}`;
		const sameCrateRoute =
			target.pathname === currentCratePrefix ||
			target.pathname.startsWith(`${currentCratePrefix}/`);
		const next = serializeExplorerState(target, {
			view: viewState.view,
			layout: viewState.layout,
			q: viewState.q,
			k: viewState.k,
			ex: sameCrateRoute ? viewState.ex : [],
			gbi: viewState.gbi,
			viz: viewState.viz,
			td: viewState.td,
			sd: viewState.sd,
			peek: viewState.peek,
			rel: viewState.rel,
		});
		return next.pathname + next.search + next.hash;
	}

	// Search / filter state from URL
	const filter = $derived(viewState.q);
	const showGraphBlanketImpls = $derived(viewState.gbi);
	// Server-side search when there's a query
	const searchQuery = $derived(
		filter ? searchNodes({ crate: crateName, version, q: filter }) : null,
	);

	const activeKinds = $derived.by(() => new Set<NodeKind>(viewState.k));
	const kindFilter = $derived(activeKinds);
	const kindParamList = $derived.by<NodeKind[]>(() => viewState.k);

	function updateExplorerState(patch: Parameters<typeof serializeExplorerState>[1]) {
		void goto(serializeExplorerState(page.url, patch), {
			replaceState: true,
			noScroll: true,
			keepFocus: true,
		});
	}

	function toggleKindFilter(kind: NodeKind) {
		const next = new Set<NodeKind>(viewState.k);
		if (next.has(kind)) next.delete(kind);
		else next.add(kind);
		updateExplorerState({ k: nodeKindOrder.filter((candidate) => next.has(candidate)) });
	}

	// Derive selected node ID from the current path
	const selectedNodeId = $derived.by(() => {
		const pathParam = page.params.path;
		return crateName ? nodeIdFromPath(crateName, pathParam) : '';
	});

	// Track crate change render timing
	let lastCrateName = '';
	$effect(() => {
		if (crateName && crateName !== lastCrateName) {
			lastCrateName = crateName;
			perfTick('render', `layout crate=${crateName} tick`);
		}
	});

	const showPerfDebug = $derived(browser ? page.url.searchParams.has('perf') : false);

	function buildCrateSwitcherItems(
		local: Array<{ id: string; name?: string; version: string }> | null,
		index: {
			crates: Array<{ id: string; name?: string; version: string; is_external?: boolean }>;
		} | null,
		currentCrate: string | undefined,
	): Array<{ id: string; name?: string; version: string }> {
		if (local && local.length > 0) {
			return local.filter((c) => c.id !== currentCrate && c.name !== currentCrate);
		}
		if (index?.crates) {
			return index.crates.filter(
				(c) => !c.is_external && c.id !== currentCrate && c.name !== currentCrate,
			);
		}
		return [];
	}

	function buildCrateSwitcherCount(
		local: Array<{ id: string; name?: string }> | null,
		index: { crates: Array<{ id: string; name?: string; is_external?: boolean }> } | null,
	): number | null {
		if (local && local.length > 0) return local.length;
		if (index?.crates) return index.crates.filter((c) => !c.is_external).length;
		return null;
	}

	function buildCrateSwitcherLabel(local: Array<{ id: string }> | null): string {
		return local && local.length > 0 ? 'Workspace' : 'Crate index';
	}

	function buildCrateVersionOptions(
		versions: string[],
		currentVersion: string | undefined,
	): string[] {
		if (currentVersion && !versions.includes(currentVersion)) {
			return [currentVersion, ...versions];
		}
		return versions;
	}

	const loadMeta = $derived(data?.meta ?? null);
	const loadRoots = $derived(data?.roots ?? null);
	const loadRootChildren = $derived(data?.rootChildren ?? null);
	const loadPrefetchedTreeChildren = $derived(data?.prefetchedTreeChildren ?? []);
	const meta = $derived(metaProxy?.current ?? loadMeta ?? null);
	const treeRoots = $derived(rootsProxy?.current ?? loadRoots ?? null);
	const rootChildren = $derived(filter || kindParamList.length > 0 ? null : loadRootChildren);
	const prefetchedTreeChildren = $derived(
		filter || kindParamList.length > 0 ? [] : loadPrefetchedTreeChildren,
	);
	const indexFromQuery = $derived(meta?.index ?? null);
	const versionsFromQuery = $derived(meta?.versions ?? []);
	const hasTreeData = $derived(treeRoots != null && treeRoots.length > 0);
	const kindFacets = $derived((meta?.kindFacets ?? []) as KindFacet[]);
	const crateSwitcherCount = $derived(buildCrateSwitcherCount(localCrates, indexFromQuery));
	const crateSwitcherItems = $derived(
		buildCrateSwitcherItems(localCrates, indexFromQuery, crateName),
	);
	const crateSwitcherLabel = $derived(buildCrateSwitcherLabel(localCrates));
	const crateVersionOptions = $derived(buildCrateVersionOptions(versionsFromQuery, version));
	const loadingCrateSwitcher = $derived(!isHosted && !localCrates && !indexFromQuery);

	$effect(() => {
		if (!browser || !canonicalCrateName || !version) return;
		const key = `${canonicalCrateName}@${version}`;
		const showProgress =
			effectiveCrateStatus === 'processing' ||
			(effectiveCrateStatus === 'unknown' && !hasTreeData);
		if (showProgress) {
			routeParseToastKey = key;
			showParseToastTarget(canonicalCrateName, version);
			return;
		}
		if (routeParseToastKey === key) {
			routeParseToastKey = '';
			clearParseToastTarget(canonicalCrateName, version);
		}
	});
</script>

<CrateParseState
	{crateName}
	{version}
	status={effectiveCrateStatus}
	action={effectiveCrateAction}
	error={effectiveCrateError}
	installedVersion={effectiveInstalledVersion}
	{crateVersionOptions}
	{hasTreeData}
	onInstallStart={() => {
		if (!crateName || !version) return;
		statusConn.status = 'processing';
		statusConn.step = 'resolving';
		statusConn.action = undefined;
		statusConn.error = null;
		statusConn.connect(crateName, version);
	}}
	onInstallError={(msg) => {
		log.warn`std install failed ${crateName}@${version}: ${msg}`;
		statusConn.status = 'failed';
		statusConn.error = msg;
	}}
	onRetryStart={() => {
		if (!crateName || !version) return;
		statusConn.status = 'processing';
		statusConn.step = 'resolving';
		statusConn.action = undefined;
		statusConn.error = null;
		statusConn.connect(crateName, version);
		log.info`retry parse ${crateName}@${version}`;
	}}
	onRetryError={(msg) => {
		log.warn`retry parse failed ${crateName}@${version}: ${msg}`;
		statusConn.status = 'failed';
		statusConn.error = msg;
	}}
>
	<div class="flex min-h-0 flex-1 overflow-hidden">
		<LiveExplorer
			{crateName}
			{version}
			crateListCount={crateSwitcherCount}
			{crateVersionOptions}
			crateList={crateSwitcherItems}
			{crateSwitcherLabel}
			{loadingCrateSwitcher}
			{onVersionChange}
			debugInfo={showPerfDebug && effectiveCrateStatus === 'processing'
				? {
						statusDebugKey: crateName && version ? `rust:${crateName}:${version}` : '-',
						progressDebugKey: crateName && version ? `progress:rust:${crateName}:${version}` : '-',
					}
				: null}
			{filter}
			kindParams={kindParamList}
			{searchQuery}
			{selectedNodeId}
			{treeRoots}
			{canonicalCrateName}
			{kindFacets}
			{activeKinds}
			{kindFilter}
			{rootChildren}
			{prefetchedTreeChildren}
			status={effectiveCrateStatus}
			progressNodeCount={progressConn.nodeCount || 0}
			{showGraphBlanketImpls}
			{getNodeUrl}
			nodeView={data?.nodeView ?? null}
			nodeId={selectedNodeId}
			onToggleKind={toggleKindFilter}
			onRetryTree={(reset) => {
				void refreshRemote(metaProxy);
				void refreshRemote(rootsProxy);
				reset();
			}}
		/>
		{@render children()}
	</div>
</CrateParseState>
