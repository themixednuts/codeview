<script lang="ts">
	import '../app.css';
	import { browser } from '$app/environment';
	import { afterNavigate, onNavigate, replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page, updated } from '$app/state';
	import { authClient } from '$lib/auth-client';
	import { getProcessingCrates } from '$lib/rpc/crate.remote';
	import { ProcessingStatusConnection } from '$lib/realtime';
	import { onDestroy, onMount, untrack } from 'svelte';
	import { perf } from '$lib/perf';
	import { parseExplorerState, serializeExplorerState } from '$lib/url-state';
	import {
		ACCENT_KEY,
		ACCENT_VALUES,
		CODE_DARK_KEY,
		CODE_LIGHT_KEY,
		CODE_VALUES,
		DENSITY_KEY,
		DENSITY_VALUES,
		DOC_LAYOUT_KEY,
		DOC_LAYOUT_VALUES,
		EXT_LINK_KEY,
		EXT_LINK_VALUES,
		SOURCE_PROVIDER_KEY,
		SOURCE_PROVIDER_VALUES,
		THEME_KEY,
		THEME_VALUES,
		VCS_KEY,
		VCS_VALUES,
		VOICE_KEY,
		VOICE_VALUES,
		readStoredPref,
		writePref,
	} from '$lib/preferences';
	import {
		themeCtx,
		resolvedThemeCtx,
		accentModeCtx,
		densityModeCtx,
		voiceModeCtx,
		docLayoutCtx,
		codeThemeLightCtx,
		codeThemeDarkCtx,
		extLinkModeCtx,
		sourceProviderModeCtx,
		vcsModeCtx,
		editorSchemeCtx,
		type Theme,
		type ResolvedTheme,
		type AccentMode,
		type DensityMode,
		type VoiceMode,
		type DocLayoutMode,
		type CodeTheme,
		type ExternalLinkMode,
		type SourceProviderMode,
		type VcsMode,
	} from '$lib/context';
	import { LoaderCircleIcon, SettingsIcon } from '@lucide/svelte';
	import type { LayoutProps } from './$types';
	import SettingsDrawer from '$lib/components/SettingsDrawer.svelte';
	import GlobalCrateCommand from '$lib/components/GlobalCrateCommand.svelte';
	import { Icon } from '$lib/components/design';
	import { Toaster } from '$lib/shadcn/ui/sonner';
	import { toast } from 'svelte-sonner';
	import { forceRefreshClient } from '$lib/client/invalidation';

	type ProcessingCrateItem = {
		id?: string;
		name?: string;
		version: string;
	};

	type ProcessingCratesResource =
		| Promise<unknown>
		| {
				run?: () => Promise<unknown>;
				current?: unknown;
		  };

	let navSpan: ReturnType<typeof perf.begin> | null = null;

	onNavigate((navigation) => {
		const from = navigation.from?.url?.pathname ?? '';
		const to = navigation.to?.url?.pathname ?? '';
		navSpan = perf.begin('nav', `${from} → ${to}`);

		// View transitions disabled — they block on `navigation.complete` which includes
		// async data fetching (getNodeDetail). Cross-crate navs were taking 16+ seconds
		// because the browser held the old-page snapshot while waiting for the RPC.
		// The graph component has its own CSS transitions for smooth visual updates.
	});

	afterNavigate(() => {
		if (navSpan) {
			navSpan.end();
			navSpan = null;
		}
	});

	let { children, data }: LayoutProps = $props();

	const processingConn = new ProcessingStatusConnection();
	const processingCount = $derived(processingConn.count);
	let showProcessing = $state(false);
	let processingCrates = $state.raw<ProcessingCrateItem[]>([]);
	let processingCrateFetchSeq = 0;
	let lastProcessingCrateRefresh = 0;
	const visibleProcessingCount = $derived(Math.max(processingCount, processingCrates.length));
	let appUpdateToastVisible = false;
	let appRefreshStarted = false;
	let authPending = $state(false);
	let authError = $state<string | null>(null);
	const auth = $derived(data.auth);

	function openProcessingPopover() {
		showProcessing = true;
	}

	function closeProcessingPopover() {
		showProcessing = false;
	}

	function handleProcessingBlur(event: FocusEvent) {
		const next = event.relatedTarget;
		if (!(next instanceof Node)) {
			closeProcessingPopover();
			return;
		}
		const current = event.currentTarget;
		if (!(current instanceof HTMLElement)) {
			closeProcessingPopover();
			return;
		}
		if (!current.contains(next)) closeProcessingPopover();
	}

	function processingCrateName(crate: { id?: string; name?: string } | null | undefined): string {
		return crate?.name || crate?.id || '';
	}

	function isProcessingCrateItem(value: unknown): value is ProcessingCrateItem {
		if (!value || typeof value !== 'object') return false;
		const item = value as { id?: unknown; name?: unknown; version?: unknown };
		return (
			typeof item.version === 'string' &&
			(typeof item.name === 'string' || typeof item.id === 'string')
		);
	}

	function processingCrateItems(value: unknown): ProcessingCrateItem[] {
		return Array.isArray(value) ? value.filter(isProcessingCrateItem) : [];
	}

	async function resolveProcessingCrates(refresh: number): Promise<ProcessingCrateItem[]> {
		const resource = getProcessingCrates({ refresh }) as ProcessingCratesResource;
		const value =
			resource && typeof (resource as { run?: unknown }).run === 'function'
				? await (resource as { run: () => Promise<unknown> }).run()
				: await resource;
		return processingCrateItems(value);
	}

	async function refreshProcessingCrates(refresh: number) {
		const seq = ++processingCrateFetchSeq;
		try {
			const crates = await resolveProcessingCrates(refresh);
			if (seq === processingCrateFetchSeq) processingCrates = crates;
		} catch {
			if (seq === processingCrateFetchSeq) processingCrates = [];
		}
	}

	function refreshForAppUpdate() {
		if (appRefreshStarted) return;
		appRefreshStarted = true;
		void forceRefreshClient();
	}

	function currentAuthRedirect(): string {
		return `${page.url.pathname}${page.url.search}`;
	}

	function userLabel(): string {
		if (!auth.user) return '';
		return auth.user.githubLogin ? `@${auth.user.githubLogin}` : auth.user.email;
	}

	async function signInGithub() {
		authPending = true;
		authError = null;
		try {
			await authClient.signIn.social({
				provider: 'github',
				callbackURL: currentAuthRedirect(),
			});
		} catch (err) {
			authError = err instanceof Error ? err.message : String(err);
			authPending = false;
		}
	}

	async function signOut() {
		authPending = true;
		authError = null;
		try {
			await authClient.signOut();
			location.href = currentAuthRedirect();
		} catch (err) {
			authError = err instanceof Error ? err.message : String(err);
			authPending = false;
		}
	}

	function showAppUpdateToast(description = 'Reload to use the current build.') {
		if (appRefreshStarted || appUpdateToastVisible) return;
		appUpdateToastVisible = true;
		untrack(() =>
			toast.warning('New Codeview version available', {
				id: 'codeview-app-update',
				description,
				duration: Number.POSITIVE_INFINITY,
				dismissable: false,
				closeButton: false,
				action: {
					label: 'Reload',
					onClick: refreshForAppUpdate,
				},
			}),
		);
	}

	function isChunkLoadFailure(value: unknown): boolean {
		const message =
			value instanceof Error
				? value.message
				: typeof value === 'string'
					? value
					: typeof value === 'object' && value !== null && 'message' in value
						? String((value as { message?: unknown }).message ?? '')
						: '';
		return (
			message.includes('Failed to fetch dynamically imported module') ||
			message.includes('Importing a module script failed') ||
			message.includes('error loading dynamically imported module')
		);
	}

	$effect(() => {
		if (!browser) return;
		if (!updated.current) return;
		showAppUpdateToast();
	});

	function watchServiceWorkerRegistration(registration: ServiceWorkerRegistration): () => void {
		const notifyWaitingWorker = () => {
			if (registration.waiting) {
				showAppUpdateToast('A new app build is ready. Reload to switch to it.');
			}
		};
		const handleUpdateFound = () => {
			const worker = registration.installing;
			if (!worker) return;
			const handleStateChange = () => {
				if (worker.state === 'installed' && navigator.serviceWorker.controller) {
					showAppUpdateToast('A new app build is ready. Reload to switch to it.');
				}
			};
			worker.addEventListener('statechange', handleStateChange);
		};

		notifyWaitingWorker();
		registration.addEventListener('updatefound', handleUpdateFound);
		void registration.update().catch(() => {});
		return () => registration.removeEventListener('updatefound', handleUpdateFound);
	}

	function setupAppUpdateNotifications(): () => void {
		const cleanups: Array<() => void> = [];
		let disposed = false;

		const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
			if (!isChunkLoadFailure(event.reason)) return;
			showAppUpdateToast(
				'The current page is using stale app files. Reload to fetch the current build.',
			);
		};
		const handleResourceError = (event: Event) => {
			if (event instanceof ErrorEvent && isChunkLoadFailure(event.error ?? event.message)) {
				showAppUpdateToast(
					'The current page is using stale app files. Reload to fetch the current build.',
				);
				return;
			}
			const target = event.target;
			const url =
				target instanceof HTMLScriptElement
					? target.src
					: target instanceof HTMLLinkElement
						? target.href
						: '';
			if (!url.includes('/_app/immutable/')) return;
			showAppUpdateToast(
				'The current page is using stale app files. Reload to fetch the current build.',
			);
		};
		const checkForAppUpdate = () => {
			if (document.visibilityState === 'visible') void updated.check();
		};

		window.addEventListener('unhandledrejection', handleUnhandledRejection);
		window.addEventListener('error', handleResourceError, true);
		document.addEventListener('visibilitychange', checkForAppUpdate);
		cleanups.push(() => {
			window.removeEventListener('unhandledrejection', handleUnhandledRejection);
			window.removeEventListener('error', handleResourceError, true);
			document.removeEventListener('visibilitychange', checkForAppUpdate);
		});

		if ('serviceWorker' in navigator) {
			void navigator.serviceWorker.ready
				.then((registration) => {
					if (disposed) return;
					cleanups.push(watchServiceWorkerRegistration(registration));
				})
				.catch(() => {});
		}

		return () => {
			disposed = true;
			for (const cleanup of cleanups.splice(0)) cleanup();
		};
	}

	$effect(() => {
		if (!browser) return;

		const count = processingCount;
		if (count <= 0) {
			lastProcessingCrateRefresh = 0;
			processingCrateFetchSeq += 1;
			processingCrates = [];
			return;
		}

		if (count !== lastProcessingCrateRefresh) {
			lastProcessingCrateRefresh = count;
			void refreshProcessingCrates(count);
		}
	});

	onDestroy(() => {
		processingConn.destroy();
	});

	onMount(() => {
		if (!browser) return () => processingConn.destroy();
		let processingPollTimer: ReturnType<typeof setInterval> | null = null;
		const cleanupAppUpdates = setupAppUpdateNotifications();
		const pollProcessingCrates = () => {
			if (document.visibilityState !== 'visible') return;
			void refreshProcessingCrates(Date.now());
		};
		const syncProcessingStream = () => {
			if (document.visibilityState === 'visible') {
				processingConn.connect('rust');
				pollProcessingCrates();
			} else {
				processingConn.disconnect();
			}
		};
		syncProcessingStream();
		void updated.check();
		processingPollTimer = setInterval(pollProcessingCrates, 2_000);
		document.addEventListener('visibilitychange', syncProcessingStream);
		return () => {
			cleanupAppUpdates();
			if (processingPollTimer) clearInterval(processingPollTimer);
			document.removeEventListener('visibilitychange', syncProcessingStream);
			processingConn.destroy();
		};
	});

	function getInitialExtLinkMode(): ExternalLinkMode {
		if (!browser) return 'codeview';
		return readStoredPref(EXT_LINK_KEY, EXT_LINK_VALUES, 'codeview');
	}

	let extLinkMode = $state<ExternalLinkMode>('codeview');
	let sourceProviderMode = $state<SourceProviderMode>('auto');
	let vcsMode = $state<VcsMode>('git');
	let editorScheme = $state('vscode://file/{path}:{line}');

	extLinkModeCtx.set(() => extLinkMode);
	sourceProviderModeCtx.set(() => sourceProviderMode);
	vcsModeCtx.set(() => vcsMode);
	editorSchemeCtx.set(() => editorScheme);

	function setExtLinkMode(mode: ExternalLinkMode) {
		extLinkMode = mode;
		if (browser) writePref(EXT_LINK_KEY, mode);
	}

	function getInitialSourceProviderMode(): SourceProviderMode {
		if (!browser) return 'auto';
		return readStoredPref(SOURCE_PROVIDER_KEY, SOURCE_PROVIDER_VALUES, 'auto');
	}

	function setSourceProviderMode(mode: SourceProviderMode) {
		sourceProviderMode = mode;
		if (browser) writePref(SOURCE_PROVIDER_KEY, mode);
	}

	function getInitialVcsMode(): VcsMode {
		if (!browser) return 'git';
		return readStoredPref(VCS_KEY, VCS_VALUES, 'git');
	}

	function setVcsMode(mode: VcsMode) {
		vcsMode = mode;
		if (browser) writePref(VCS_KEY, mode);
	}

	function setEditorScheme(scheme: string) {
		editorScheme = scheme;
	}

	function resolveTheme(pref: Theme): 'light' | 'dark' {
		if (pref === 'system') {
			return browser && window.matchMedia('(prefers-color-scheme: dark)').matches
				? 'dark'
				: 'light';
		}
		return pref;
	}

	function getInitialTheme(): Theme {
		if (!browser) return 'light';
		return readStoredPref(THEME_KEY, THEME_VALUES, 'system');
	}

	let theme = $state<Theme>('light');
	let resolved = $state<ResolvedTheme>('light');

	// Expressive tweak axes — see app.css for the data-* contracts.
	let accentMode = $state<AccentMode>('orange');
	let densityMode = $state<DensityMode>('comfortable');
	let voiceMode = $state<VoiceMode>('editorial');
	let docLayout = $state<DocLayoutMode>('classic');
	let codeThemeLight = $state<CodeTheme>('solarized-light');
	let codeThemeDark = $state<CodeTheme>('solarized-dark');
	const explorerViewState = $derived(parseExplorerState(page.url));
	const activeDocLayout = $derived(explorerViewState.layout ?? docLayout);
	const isExplorerRoute = $derived(Boolean(page.params.crate && page.params.version));

	themeCtx.set(() => theme);
	resolvedThemeCtx.set(() => resolved);
	accentModeCtx.set(() => accentMode);
	densityModeCtx.set(() => densityMode);
	voiceModeCtx.set(() => voiceMode);
	docLayoutCtx.set(() => activeDocLayout);
	codeThemeLightCtx.set(() => codeThemeLight);
	codeThemeDarkCtx.set(() => codeThemeDark);

	function applyCodeTheme() {
		if (!browser) return;
		document.documentElement.dataset.codeTheme =
			resolved === 'dark' ? codeThemeDark : codeThemeLight;
	}

	function applyTheme(next: Theme) {
		theme = next;
		if (!browser) return;
		resolved = resolveTheme(next);
		document.documentElement.dataset.theme = resolved;
		writePref(THEME_KEY, next);
		applyCodeTheme();
	}

	function setAccent(next: AccentMode) {
		accentMode = next;
		if (!browser) return;
		document.documentElement.dataset.accent = next;
		writePref(ACCENT_KEY, next);
	}

	function setDensity(next: DensityMode) {
		densityMode = next;
		if (!browser) return;
		document.documentElement.dataset.density = next;
		writePref(DENSITY_KEY, next);
	}

	function setVoice(next: VoiceMode) {
		voiceMode = next;
		if (!browser) return;
		document.documentElement.dataset.voice = next;
		writePref(VOICE_KEY, next);
	}

	function setDocLayout(next: DocLayoutMode) {
		docLayout = next;
		if (!browser) return;
		writePref(DOC_LAYOUT_KEY, next);
		document.documentElement.dataset.docLayout = next;
		window.dispatchEvent(new CustomEvent('codeview-doc-layout-change', { detail: next }));
		if (isExplorerRoute) {
			replaceState(serializeExplorerState(page.url, { layout: next }), page.state);
		}
	}

	function setCodeThemeLight(next: CodeTheme) {
		codeThemeLight = next;
		if (!browser) return;
		writePref(CODE_LIGHT_KEY, next);
		applyCodeTheme();
	}

	function setCodeThemeDark(next: CodeTheme) {
		codeThemeDark = next;
		if (!browser) return;
		writePref(CODE_DARK_KEY, next);
		applyCodeTheme();
	}

	onMount(() => {
		applyTheme(getInitialTheme());
		extLinkMode = getInitialExtLinkMode();
		sourceProviderMode = getInitialSourceProviderMode();
		vcsMode = getInitialVcsMode();

		// Restore tweak axes from cookies/localStorage (app.html's inline script
		// set the initial dataset values; we sync our reactive state here).
		accentMode = readStoredPref(ACCENT_KEY, ACCENT_VALUES, 'orange');
		densityMode = readStoredPref(DENSITY_KEY, DENSITY_VALUES, 'comfortable');
		voiceMode = readStoredPref(VOICE_KEY, VOICE_VALUES, 'editorial');
		docLayout = readStoredPref(DOC_LAYOUT_KEY, DOC_LAYOUT_VALUES, 'classic');
		codeThemeLight = readStoredPref(CODE_LIGHT_KEY, CODE_VALUES, 'solarized-light');
		codeThemeDark = readStoredPref(CODE_DARK_KEY, CODE_VALUES, 'solarized-dark');
		document.documentElement.dataset.accent = accentMode;
		document.documentElement.dataset.density = densityMode;
		document.documentElement.dataset.voice = voiceMode;
		document.documentElement.dataset.docLayout = activeDocLayout;
		applyCodeTheme();

		// Listen for OS theme changes when in system mode
		const mql = window.matchMedia('(prefers-color-scheme: dark)');
		const onSystemChange = () => {
			if (theme === 'system') {
				resolved = resolveTheme('system');
				document.documentElement.dataset.theme = resolved;
				applyCodeTheme();
			}
		};
		mql.addEventListener('change', onSystemChange);
		return () => mql.removeEventListener('change', onSystemChange);
	});

	$effect(() => {
		if (!browser) return;
		document.documentElement.dataset.docLayout = activeDocLayout;
	});

	// ── Settings drawer ──
	let settingsOpen = $state(false);
	let commandOpen = $state(false);
	let shortcutModLabel = $state('Ctrl');
	const globalShortcutOptions = { capture: true };

	function isEditableTarget(target: EventTarget | null): boolean {
		if (!(target instanceof HTMLElement)) return false;
		const tag = target.tagName.toLowerCase();
		return (
			target.isContentEditable ||
			tag === 'input' ||
			tag === 'textarea' ||
			tag === 'select' ||
			target.closest('[role="textbox"]') !== null
		);
	}

	function handleGlobalShortcut(event: KeyboardEvent) {
		const isModified = event.metaKey || event.ctrlKey;
		const key = event.key.toLowerCase();
		if (!isModified) return;
		if (isEditableTarget(event.target) && key !== 'k') return;
		if (key === 'k') {
			event.preventDefault();
			commandOpen = true;
			return;
		}
		if (event.key === ',') {
			event.preventDefault();
			settingsOpen = true;
		}
	}

	onMount(() => {
		shortcutModLabel = navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl';
		window.addEventListener('keydown', handleGlobalShortcut, globalShortcutOptions);
		return () => window.removeEventListener('keydown', handleGlobalShortcut, globalShortcutOptions);
	});
</script>

<svelte:head>
	<title>Codeview</title>
</svelte:head>

<div class="flex h-screen flex-col bg-(--bg)">
	<header
		class="grid h-12 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 border-b border-(--panel-border) bg-(--panel-solid) px-3 text-sm text-(--muted) sm:px-4 md:gap-3 lg:px-6"
	>
		<div class="flex min-w-0 items-center">
			<a
				href={resolve('/')}
				class="group flex min-w-0 items-center gap-2 text-(--ink) transition-colors hover:text-(--accent)"
				aria-label="Codeview home"
			>
				<svg
					class="shrink-0"
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					aria-hidden="true"
				>
					<rect x="3" y="3" width="18" height="18" rx="4" fill="var(--accent)" />
					<path
						d="M8 12l3 3 5-6"
						stroke="var(--on-accent)"
						stroke-width="2.4"
						stroke-linecap="round"
						stroke-linejoin="round"
						fill="none"
					/>
				</svg>
				<span class="font-display truncate text-[15.5px] font-semibold tracking-tight">
					codeview
				</span>
			</a>
		</div>

		<button
			type="button"
			class="corner-squircle hidden min-w-0 max-w-[440px] justify-self-start rounded-(--radius-control) border border-(--panel-border) bg-(--panel) px-3 py-1.5 font-mono text-[11.5px] text-(--muted) shadow-(--shadow-soft) transition-colors hover:border-(--accent-ring) hover:bg-(--panel-strong) hover:text-(--ink) md:inline-flex md:w-full md:items-center md:justify-between md:gap-3"
			aria-label="Search crates and Rust items"
			title="Global search"
			onclick={() => (commandOpen = true)}
		>
			<span class="inline-flex min-w-0 items-center gap-2">
				<Icon name="search" size={12} />
				<span class="truncate">Search crates...</span>
			</span>
			<span class="hidden shrink-0 items-center gap-1 lg:inline-flex" aria-hidden="true">
				<span class="kbd">{shortcutModLabel}</span>
				<span class="kbd">K</span>
			</span>
		</button>

		<div class="flex min-w-0 items-center justify-end gap-1.5 sm:gap-2">
			{#if auth.authConfigured}
				{#if auth.user}
					<button
						type="button"
						class="corner-squircle inline-flex max-w-40 items-center gap-1.5 rounded-(--radius-control) border border-(--panel-border) bg-(--panel) px-2 py-1.5 text-xs text-(--ink) transition-colors hover:border-(--accent-ring) hover:bg-(--panel-strong) disabled:opacity-60"
						title={`Sign out ${userLabel()}`}
						disabled={authPending}
						onclick={signOut}
					>
						<Icon name="github" size={13} />
						<span class="hidden truncate sm:inline">{userLabel()}</span>
					</button>
				{:else}
					<button
						type="button"
						class="corner-squircle inline-flex items-center gap-1.5 rounded-(--radius-control) border border-(--panel-border) bg-(--panel) px-2 py-1.5 text-xs text-(--ink) transition-colors hover:border-(--accent-ring) hover:bg-(--panel-strong) disabled:opacity-60"
						title={authError ?? 'Sign in with GitHub'}
						disabled={authPending}
						onclick={signInGithub}
					>
						<Icon name="github" size={13} />
						<span class="hidden sm:inline">{authPending ? 'Opening...' : 'Sign in'}</span>
					</button>
				{/if}
			{/if}
			{#if auth.isAdmin}
				<a
					href={resolve('/admin')}
					class="corner-squircle inline-flex items-center gap-1.5 rounded-(--radius-control) border border-(--panel-border) bg-(--panel) px-2 py-1.5 text-xs text-(--ink) transition-colors hover:border-(--accent-ring) hover:bg-(--panel-strong)"
					title="Admin"
				>
					<Icon name="command" size={13} />
					<span class="hidden sm:inline">Admin</span>
				</a>
			{/if}
			<div
				class="relative"
				role="group"
				aria-label="Parse queue status"
				onmouseenter={openProcessingPopover}
				onmouseleave={closeProcessingPopover}
				onfocusin={openProcessingPopover}
				onfocusout={handleProcessingBlur}
			>
				<a
					href={resolve('/queue')}
					class={`inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs transition-colors ${
						visibleProcessingCount > 0
							? 'border border-(--accent-ring) bg-(--accent-soft) text-(--accent) hover:bg-(--panel-strong) hover:text-(--ink)'
							: 'text-(--muted) hover:bg-(--panel-strong) hover:text-(--ink)'
					}`}
					aria-label={visibleProcessingCount > 0
						? `Parse queue, ${visibleProcessingCount} active`
						: 'Parse queue'}
					aria-describedby={showProcessing && visibleProcessingCount > 0
						? 'parse-queue-popover'
						: undefined}
					title="Parse queue"
				>
					{#if visibleProcessingCount > 0}
						<LoaderCircleIcon class="animate-spin" size={13} />
						<span class="hidden sm:inline">Parsing</span>
						<span class="font-mono tabular-nums">{visibleProcessingCount}</span>
					{:else}
						<Icon name="clock" size={13} />
						<span class="hidden sm:inline">Queue</span>
					{/if}
				</a>
				{#if showProcessing && visibleProcessingCount > 0}
					<div
						id="parse-queue-popover"
						class="corner-squircle absolute right-0 z-20 mt-2 w-64 rounded-(--radius-card) border border-(--panel-border) bg-(--panel-solid) p-2 shadow-(--shadow-soft)"
						role="tooltip"
						aria-label="Background parses"
					>
						<div class="px-2 pb-1 text-[10px] tracking-wider text-(--muted) uppercase">
							Active parses
						</div>
						{#if processingCrates.length > 0}
							<div class="space-y-1">
								{#each processingCrates as crate (`${processingCrateName(crate)}@${crate.version}`)}
									<div
										class="corner-squircle flex items-center justify-between gap-2 rounded-(--radius-chip) bg-(--panel) px-2 py-1"
									>
										<span class="truncate text-xs font-medium text-(--ink)">
											{processingCrateName(crate)}
										</span>
										<span class="badge badge-sm">{crate.version}</span>
									</div>
								{/each}
							</div>
						{:else}
							<div class="flex items-center gap-2 p-2">
								<LoaderCircleIcon class="animate-spin" size={12} />
								<span class="text-xs text-(--muted)">Loading...</span>
							</div>
						{/if}
					</div>
				{/if}
			</div>
			<a
				href="https://github.com/themixednuts/codeview"
				target="_blank"
				rel="noopener noreferrer"
				class="grid size-7 place-items-center rounded-md text-(--muted) transition-colors hover:bg-(--panel-strong) hover:text-(--ink)"
				aria-label="GitHub"
				title="View on GitHub"
			>
				<Icon name="github" size={14} />
			</a>
			<button
				type="button"
				class="grid size-7 place-items-center rounded-md text-(--muted) transition-colors hover:bg-(--panel-strong) hover:text-(--ink)"
				title="Settings"
				aria-label="Open settings"
				onclick={() => (settingsOpen = true)}
			>
				<SettingsIcon size={14} />
			</button>
		</div>
	</header>

	{@render children()}
</div>

<GlobalCrateCommand bind:open={commandOpen} />

<SettingsDrawer
	bind:open={settingsOpen}
	{theme}
	{accentMode}
	{densityMode}
	{voiceMode}
	{docLayout}
	{codeThemeLight}
	{codeThemeDark}
	{extLinkMode}
	{sourceProviderMode}
	{vcsMode}
	onThemeChange={applyTheme}
	onAccentChange={setAccent}
	onDensityChange={setDensity}
	onVoiceChange={setVoice}
	onDocLayoutChange={setDocLayout}
	onCodeThemeLightChange={setCodeThemeLight}
	onCodeThemeDarkChange={setCodeThemeDark}
	onExtLinkModeChange={setExtLinkMode}
	onSourceProviderModeChange={setSourceProviderMode}
	onVcsModeChange={setVcsMode}
	onEditorSchemeChange={setEditorScheme}
/>

<Toaster position="bottom-right" expand={false} />
