<script lang="ts">
	import type { Node, NodeKind } from '$lib/graph';
	import type { TreeNodeDTO } from '$lib/schema';
	import {
		getNodeUrlCtx,
		crateVersionsCtx,
		crateStatusCtx,
		parseProgressCtx,
		expandPathCtx,
		setExpandPathCtx,
		treeParamsCtx,
		type ExpandPath,
	} from '$lib/context';
	import { page } from '$app/state';
	import { afterNavigate, beforeNavigate, goto, invalidate, replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { browser } from '$app/environment';
	import { SvelteURLSearchParams } from 'svelte/reactivity';
	import { getCrates } from '$lib/rpc/crate.remote';
	import { getCrateMeta } from '$lib/rpc/meta.remote';
	import { getTreeRoots } from '$lib/rpc/roots.remote';
	import { searchNodes } from '$lib/rpc/search.remote';
	import { nodeIdFromPath, nodeUrl } from '$lib/url';
	import { hyphenateCrateName } from '$lib/crate-names';
	import { onMount } from 'svelte';
	import CrateParseState from '$lib/components/CrateParseState.svelte';
	import CrateSidebar from '$lib/components/CrateSidebar.svelte';
	import { CrateStatusConnection, ParseProgressConnection } from '$lib/realtime';
	import { perf } from '$lib/perf';
	import { perfTick } from '$lib/perf.svelte';
	import { getLogger } from '$lib/log';
	import { nodeKindOrder } from '$lib/display-names';
	import { SvelteSet } from 'svelte/reactivity';
	import type { Snippet } from 'svelte';
	import { isValidCrateNameParam, isValidVersionParam } from '$lib/crate-ref';

	const log = getLogger('layout');

	type LayoutData = import('./$types').LayoutData & {
		rootChildren?: { id: string; children: TreeNodeDTO[] } | null;
	};

	let { children, data } = $props<{ children: Snippet; data: LayoutData }>();

	const params = $derived(page.params);
	const crateName = $derived(params.crate);
	const version = $derived(params.version);
	const canonicalCrateName = $derived(hyphenateCrateName(crateName ?? ''));
	const hasValidCrateParam = $derived(isValidCrateNameParam(canonicalCrateName));
	const hasValidVersionParam = $derived(isValidVersionParam(version));
	const canQueryCrate = $derived(hasValidCrateParam && hasValidVersionParam);

	// --- SSE connections for status and parse progress ---
	const statusConn = new CrateStatusConnection();
	const progressConn = new ParseProgressConnection();
	let lastProgressKey = '';
	let activeRouteKey = '';
	let rafMonitor: number | null = null;
	let wasHidden = false;
	let metaRefreshInFlight: Promise<void> | null = null;
	let clientReady = $state(false);

	function startMainThreadMonitor() {
		if (!browser) return;
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
		const refreshPath = page.url.pathname + page.url.search;
		log.debug`meta refresh start ${canonicalCrateName}@${version} reason=${reason}`;
		metaRefreshInFlight = Promise.all([metaProxy?.refresh(), rootsProxy?.refresh()])
			.then(() => {
				const ms = Math.round(performance.now() - t0);
				const metaCurrent = metaProxy?.current;
				const v = metaCurrent?.versions.length ?? 0;
				const k = metaCurrent ? Object.keys(metaCurrent.kindCounts).length : 0;
				const r = rootsProxy?.current?.length ?? 0;
				log.debug`meta refresh done ${canonicalCrateName}@${version} in ${ms}ms (${v}v ${k}k ${r}r) reason=${reason}`;
			})
			.catch((err: unknown) => {
				const errText = String(err);
				const currentPath = page.url.pathname + page.url.search;
				const cancelledPrimeRequest = reason === 'prime' && errText.includes('Failed to fetch');
				if (currentPath !== refreshPath || cancelledPrimeRequest) {
					log.debug`meta refresh cancelled ${canonicalCrateName}@${version} reason=${reason} from=${refreshPath} to=${currentPath}`;
					return;
				}
				log.warn`meta refresh failed ${canonicalCrateName}@${version} reason=${reason}: ${errText}`;
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
		statusConn.connect(canonicalCrateName, version);
	}

	function connectProgressForCurrentRoute() {
		if (!browser || !canonicalCrateName || !version || !canQueryCrate) return;
		if (statusConn.status !== 'processing') return;
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
			syncKindSelection(page.url.searchParams);
			// Seed treeParams from incoming URL on each navigation
			const urlEx = page.url.searchParams.get('ex') ?? '';
			const currentEx = treeParams.get('ex') ?? '';
			if (urlEx !== currentEx) {
				if (urlEx) treeParams.set('ex', urlEx);
				else treeParams.delete('ex');
			}
		});
		return () => {
			stopMonitor?.();
			stopMainThreadMonitor();
			statusConn.disconnect();
			progressConn.disconnect();
		};
	});

	// ── Expand path context (ancestor IDs from nodeView → GraphTree) ──
	let currentExpandPath = $state.raw<ExpandPath>(null);
	expandPathCtx.set(() => currentExpandPath);
	setExpandPathCtx.set(() => (path: ExpandPath) => { currentExpandPath = path; });

	// ── Reactive tree params singleton (shared with GraphTree via context) ──
	const treeParams = new SvelteURLSearchParams(page.url.search);
	treeParamsCtx.set(() => treeParams);

	// Sync treeParams → browser URL bar (genuine side effect)
	$effect(() => {
		if (!browser) return;
		const ex = treeParams.get('ex');
		// Use window.location to get the real browser URL (page.url may have SSR origin)
		const url = new URL(window.location.href);
		const currentEx = url.searchParams.get('ex') ?? '';
		const newEx = ex ?? '';
		if (newEx === currentEx) return;
		if (newEx) url.searchParams.set('ex', newEx);
		else url.searchParams.delete('ex');
		replaceState(url, page.state);
	});

	// ── Context setup (must be before any $derived(await …) async boundary) ──
	// Getters are closures — called lazily by child components after init.
	getNodeUrlCtx.set(() => getNodeUrl);
	crateVersionsCtx.set(() => crateVersions);
	crateStatusCtx.set(() => statusConn.status);
	parseProgressCtx.set(() => progressConn);

	// Refresh roots once when first parse progress arrives (partial data becomes available)
	let hasRefreshedDuringParse = $state(false);
	$effect(() => {
		const nc = progressConn.nodeCount;
		const status = statusConn.status;
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
	$effect(() => {
		const currentStatus = statusConn.status;
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

	// Load workspace crate list (for switcher + version map).
	// Load workspace crate list (client-only: getCrates is a query proxy).
	const workspaceCratesQuery = $derived(clientReady ? getCrates() : null);
	const workspaceCrates = $derived(workspaceCratesQuery?.current ?? null);

	// Query proxies for client-side reactivity (SWR revalidation, .refresh()).
	// During SSR, data comes from the load function (data prop) — creating
	// query proxies during SSR makes the component implicitly async, which
	// causes <svelte:boundary> to render its pending snippet.
	const canClientQuery = $derived(clientReady && canQueryCrate);
	const metaProxy = $derived(
		canClientQuery
			? getCrateMeta({
					name: canonicalCrateName,
					version,
					mode: 'structural',
					includeExternal: false,
				})
			: null,
	);

	const rootsProxy = $derived(
		canClientQuery
			? getTreeRoots({
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
		if (workspaceCrates && workspaceCrates.length > 0) {
			for (const c of workspaceCrates) {
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
		const params = new URLSearchParams();
		// Preserve params we care about from the current URL
		for (const key of ['layout', 'structural', 'semantic', 'q', 'raw']) {
			const val = page.url.searchParams.get(key);
			if (val) params.set(key, val);
		}
		for (const kind of kindParamList) {
			params.append('k', kind);
		}
		// Include current tree state from reactive singleton
		const ex = treeParams.get('ex');
		if (ex) params.set('ex', ex);
		const qs = params.toString();
		return qs ? `${base}?${qs}` : base;
	}

	// Search / filter state from URL
	const filter = $derived(page.url.searchParams.get('q') ?? '');
	// Server-side search when there's a query
	const searchQuery = $derived(
		filter ? searchNodes({ crate: crateName, version, q: filter }) : null,
	);

	let selectedKinds = $state<NodeKind[]>([]);
	const activeKinds = $derived.by(() => new Set<NodeKind>(selectedKinds));
	const kindFilter = $derived(activeKinds);
	const kindParamList = $derived.by<NodeKind[]>(() => selectedKinds.slice());

	function parseKindParams(params: URLSearchParams): Set<NodeKind> {
		const set = new Set<NodeKind>();
		const rawKinds = params.getAll('k');
		if (!rawKinds.length) return set;
		for (const raw of rawKinds) {
			const match = nodeKindOrder.find((kind) => kind.toLowerCase() === raw.toLowerCase());
			if (match) set.add(match);
		}
		return set;
	}

	function syncKindSelection(params: URLSearchParams) {
		const next = Array.from(parseKindParams(params));
		if (next.length === selectedKinds.length) {
			let matches = true;
			for (const kind of next) {
				if (!selectedKinds.includes(kind)) {
					matches = false;
					break;
				}
			}
			if (matches) return;
		}
		selectedKinds = next;
	}

	syncKindSelection(page.url.searchParams);

	function updateKindParams(nextKinds: Set<NodeKind>) {
		if (!browser) return;
		const url = new URL(window.location.href);
		url.searchParams.delete('k');
		for (const kind of nodeKindOrder) {
			if (nextKinds.has(kind)) url.searchParams.append('k', kind);
		}
		replaceState(url, page.state);
	}

	function toggleKindFilter(kind: NodeKind) {
		const next = selectedKinds.slice();
		const idx = next.indexOf(kind);
		if (idx >= 0) next.splice(idx, 1);
		else next.push(kind);
		selectedKinds = next;
		updateKindParams(new Set<NodeKind>(next));
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

	function buildKindCountMap(kindCounts: Record<string, number> | null): Map<NodeKind, number> {
		const counts = new Map<NodeKind, number>();
		for (const kind of nodeKindOrder) counts.set(kind, 0);
		if (kindCounts) {
			for (const [kind, count] of Object.entries(kindCounts)) {
				counts.set(kind as NodeKind, count);
			}
		}
		return counts;
	}

	function buildWorkspaceCrates(
		workspace: Array<{ id: string; name?: string; version: string }> | null,
		index: { crates: Array<{ id: string; name?: string; version: string; is_external?: boolean }> } | null,
		currentCrate: string | undefined,
	): Array<{ id: string; name?: string; version: string }> {
		if (workspace && workspace.length > 0) {
			return workspace.filter((c) => c.id !== currentCrate && c.name !== currentCrate);
		}
		if (index?.crates) {
			return index.crates.filter(
				(c) => !c.is_external && c.id !== currentCrate && c.name !== currentCrate,
			);
		}
		return [];
	}

	function buildExternalCrates(
		index: { crates: Array<{ id: string; name?: string; version: string; is_external?: boolean }> } | null,
		currentCrate: string | undefined,
	): Array<{ id: string; name?: string; version: string }> {
		if (!index?.crates) return [];
		return index.crates.filter(
			(c) => c.is_external && c.id !== currentCrate && c.name !== currentCrate,
		);
	}

	function buildWorkspaceCount(
		workspace: Array<{ id: string; name?: string }> | null,
		index: { crates: Array<{ id: string; name?: string; is_external?: boolean }> } | null,
	): number | null {
		if (workspace && workspace.length > 0) return workspace.length;
		if (index?.crates) return index.crates.filter((c) => !c.is_external).length;
		return null;
	}

	function buildExternalCount(
		index: { crates: Array<{ id: string; name?: string; is_external?: boolean }> } | null,
	): number | null {
		if (!index?.crates) return null;
		return index.crates.filter((c) => c.is_external).length;
	}

	function buildCrateVersionOptions(versions: string[], currentVersion: string | undefined): string[] {
		if (currentVersion && !versions.includes(currentVersion)) {
			return [currentVersion, ...versions];
		}
		return versions;
	}

	const loadMeta = $derived(data?.meta ?? null);
	const loadRoots = $derived(data?.roots ?? null);
	const loadRootChildren = $derived(data?.rootChildren ?? null);
	const meta = $derived(metaProxy?.current ?? loadMeta ?? null);
	const treeRoots = $derived(rootsProxy?.current ?? loadRoots ?? null);
	const rootChildren = $derived(filter || kindParamList.length > 0 ? null : loadRootChildren);
	const indexFromQuery = $derived(meta?.index ?? null);
	const versionsFromQuery = $derived(meta?.versions ?? []);
	const kindCountsFromMeta = $derived(meta?.kindCounts ?? null);
	const hasTreeData = $derived(treeRoots != null && treeRoots.length > 0);
	const kindCountMap = $derived(buildKindCountMap(kindCountsFromMeta));
	const workspaceCrateCount = $derived(buildWorkspaceCount(workspaceCrates, indexFromQuery));
	const externalCrateCount = $derived(buildExternalCount(indexFromQuery));
	const workspaceCratesList = $derived(
		buildWorkspaceCrates(workspaceCrates, indexFromQuery, crateName),
	);
	const externalCratesList = $derived(buildExternalCrates(indexFromQuery, crateName));
	const crateVersionOptions = $derived(buildCrateVersionOptions(versionsFromQuery, version));
	const loadingWorkspaceCrates = $derived(!workspaceCrates && !indexFromQuery);
	const loadingExternalCrates = $derived(!indexFromQuery);
</script>

<CrateParseState
	{crateName}
	{version}
	status={statusConn.status}
	action={statusConn.action}
	error={statusConn.error}
	installedVersion={statusConn.installedVersion}
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
	showProgress={statusConn.status === 'processing'}
	progressStep={statusConn.step}
	progressNodeCount={progressConn.nodeCount}
	progressEdgeCount={progressConn.edgeCount}
	progressTotalItems={progressConn.totalItems}
>
	<div class="flex flex-1 overflow-hidden">
		<CrateSidebar
			{crateName}
			{version}
			{workspaceCrateCount}
			{externalCrateCount}
			{crateVersionOptions}
			workspaceCrates={workspaceCratesList}
			externalCrates={externalCratesList}
			{loadingWorkspaceCrates}
			{loadingExternalCrates}
			{onVersionChange}
			debugInfo={showPerfDebug && statusConn.status === 'processing'
				? {
						statusDebugKey: crateName && version ? `rust:${crateName}:${version}` : '-',
						progressDebugKey: crateName && version ? `progress:rust:${crateName}:${version}` : '-',
					}
				: null}
			{filter}
			kindParams={kindParamList}
			{searchQuery}
			{selectedNodeId}
			treeRoots={treeRoots}
			canonicalCrateName={canonicalCrateName}
			{kindCountMap}
			{activeKinds}
			{kindFilter}
			{rootChildren}
			status={statusConn.status}
			progressNodeCount={progressConn.nodeCount || 0}
			{getNodeUrl}
			onToggleKind={toggleKindFilter}
			onRetryTree={(reset) => {
				metaProxy?.refresh();
				rootsProxy?.refresh();
				reset();
			}}
		/>

		<div class="relative flex-1 overflow-auto bg-(--bg) p-6">
			{@render children()}
		</div>
	</div>
</CrateParseState>
