<script lang="ts">
	import '../app.css';
	import { browser } from '$app/environment';
	import { afterNavigate, onNavigate } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { getProcessingCrates } from '$lib/rpc/crate.remote';
	import { ProcessingStatusConnection } from '$lib/realtime';
	import { onMount } from 'svelte';
	import { perf } from '$lib/perf';
	import {
		themeCtx,
		resolvedThemeCtx,
		accentModeCtx,
		densityModeCtx,
		voiceModeCtx,
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
		type CodeTheme,
		type ExternalLinkMode,
		type SourceProviderMode,
		type VcsMode,
	} from '$lib/context';
	import { LoaderCircleIcon, SettingsIcon } from '@lucide/svelte';
	import SettingsDrawer from '$lib/components/SettingsDrawer.svelte';
	import { Icon } from '$lib/components/design';
	import { Toaster } from '$lib/shadcn/ui/sonner';
	import { isHosted } from '$lib/platform';

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

	let { children } = $props();

	const processingConn = new ProcessingStatusConnection();
	const processingCount = $derived(processingConn.count);
	let showProcessing = $state(false);
	const processingListQuery = $derived(
		showProcessing ? getProcessingCrates({ refresh: processingCount }) : null,
	);

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

	onMount(() => {
		if (!browser || isHosted) return () => processingConn.destroy();
		const syncProcessingStream = () => {
			if (document.visibilityState === 'visible') {
				processingConn.connect('rust');
			} else {
				processingConn.disconnect();
			}
		};
		syncProcessingStream();
		document.addEventListener('visibilitychange', syncProcessingStream);
		return () => {
			document.removeEventListener('visibilitychange', syncProcessingStream);
			processingConn.destroy();
		};
	});

	const THEME_KEY = 'codeview-theme';
	const ACCENT_KEY = 'codeview-accent';
	const DENSITY_KEY = 'codeview-density';
	const VOICE_KEY = 'codeview-voice';
	const CODE_LIGHT_KEY = 'codeview-code-light';
	const CODE_DARK_KEY = 'codeview-code-dark';
	const EXT_LINK_KEY = 'codeview-ext-link-mode';
	const SOURCE_PROVIDER_KEY = 'codeview-source-provider-mode';
	const VCS_KEY = 'codeview-vcs';

	const ACCENT_VALUES: AccentMode[] = ['orange', 'cobalt', 'forest', 'plum', 'char'];
	const DENSITY_VALUES: DensityMode[] = ['compact', 'comfortable', 'spacious'];
	const VOICE_VALUES: VoiceMode[] = ['editorial', 'technical', 'geometric'];
	const CODE_VALUES: CodeTheme[] = [
		'solarized-light',
		'solarized-dark',
		'catppuccin-latte',
		'catppuccin-mocha',
		'one-light',
		'one-dark',
		'github-light',
		'github-dark',
	];

	function readEnum<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
		if (!browser) return fallback;
		const stored = localStorage.getItem(key);
		return stored && (allowed as readonly string[]).includes(stored) ? (stored as T) : fallback;
	}

	function getInitialExtLinkMode(): ExternalLinkMode {
		if (!browser) return 'codeview';
		const stored = localStorage.getItem(EXT_LINK_KEY);
		if (stored === 'codeview' || stored === 'docs') return stored;
		return 'codeview';
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
		if (browser) localStorage.setItem(EXT_LINK_KEY, mode);
	}

	function getInitialSourceProviderMode(): SourceProviderMode {
		if (!browser) return 'auto';
		const stored = localStorage.getItem(SOURCE_PROVIDER_KEY);
		if (stored === 'auto' || stored === 'crates-io' || stored === 'github') return stored;
		return 'auto';
	}

	function setSourceProviderMode(mode: SourceProviderMode) {
		sourceProviderMode = mode;
		if (browser) localStorage.setItem(SOURCE_PROVIDER_KEY, mode);
	}

	function getInitialVcsMode(): VcsMode {
		if (!browser) return 'git';
		const stored = localStorage.getItem(VCS_KEY);
		if (stored === 'git' || stored === 'jj') return stored;
		return 'git';
	}

	function setVcsMode(mode: VcsMode) {
		vcsMode = mode;
		if (browser) localStorage.setItem(VCS_KEY, mode);
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
		const stored = localStorage.getItem(THEME_KEY);
		if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
		return 'system';
	}

	let theme = $state<Theme>('light');
	let resolved = $state<ResolvedTheme>('light');

	// Expressive tweak axes — see app.css for the data-* contracts.
	let accentMode = $state<AccentMode>('orange');
	let densityMode = $state<DensityMode>('comfortable');
	let voiceMode = $state<VoiceMode>('editorial');
	let codeThemeLight = $state<CodeTheme>('solarized-light');
	let codeThemeDark = $state<CodeTheme>('solarized-dark');

	themeCtx.set(() => theme);
	resolvedThemeCtx.set(() => resolved);
	accentModeCtx.set(() => accentMode);
	densityModeCtx.set(() => densityMode);
	voiceModeCtx.set(() => voiceMode);
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
		localStorage.setItem(THEME_KEY, next);
		applyCodeTheme();
	}

	function setAccent(next: AccentMode) {
		accentMode = next;
		if (!browser) return;
		document.documentElement.dataset.accent = next;
		localStorage.setItem(ACCENT_KEY, next);
	}

	function setDensity(next: DensityMode) {
		densityMode = next;
		if (!browser) return;
		document.documentElement.dataset.density = next;
		localStorage.setItem(DENSITY_KEY, next);
	}

	function setVoice(next: VoiceMode) {
		voiceMode = next;
		if (!browser) return;
		document.documentElement.dataset.voice = next;
		localStorage.setItem(VOICE_KEY, next);
	}

	function setCodeThemeLight(next: CodeTheme) {
		codeThemeLight = next;
		if (!browser) return;
		localStorage.setItem(CODE_LIGHT_KEY, next);
		applyCodeTheme();
	}

	function setCodeThemeDark(next: CodeTheme) {
		codeThemeDark = next;
		if (!browser) return;
		localStorage.setItem(CODE_DARK_KEY, next);
		applyCodeTheme();
	}

	onMount(() => {
		applyTheme(getInitialTheme());
		extLinkMode = getInitialExtLinkMode();
		sourceProviderMode = getInitialSourceProviderMode();
		vcsMode = getInitialVcsMode();

		// Restore tweak axes from localStorage (app.html's inline script set
		// the initial dataset values; we sync our reactive state here).
		accentMode = readEnum(ACCENT_KEY, ACCENT_VALUES, 'orange');
		densityMode = readEnum(DENSITY_KEY, DENSITY_VALUES, 'comfortable');
		voiceMode = readEnum(VOICE_KEY, VOICE_VALUES, 'editorial');
		codeThemeLight = readEnum(CODE_LIGHT_KEY, CODE_VALUES, 'solarized-light');
		codeThemeDark = readEnum(CODE_DARK_KEY, CODE_VALUES, 'solarized-dark');
		document.documentElement.dataset.accent = accentMode;
		document.documentElement.dataset.density = densityMode;
		document.documentElement.dataset.voice = voiceMode;
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

	// ── Settings drawer ──
	let settingsOpen = $state(false);
</script>

<svelte:head>
	<title>Codeview</title>
</svelte:head>

<div class="flex h-screen flex-col bg-(--bg)">
	<header
		class="grid h-12 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center border-b border-(--panel-border) bg-(--panel-solid) px-4 text-sm text-(--muted) sm:px-6"
	>
		<div class="flex min-w-0 items-center gap-3">
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
				<span class="font-display truncate text-[15.5px] font-semibold tracking-tight">codeview</span>
			</a>
		</div>

		<a
			href={resolve('/')}
			class="corner-squircle hidden w-[min(42vw,440px)] items-center justify-between gap-3 rounded-(--radius-control) border border-(--panel-border) bg-(--panel) px-3 py-1.5 font-mono text-[11.5px] text-(--muted) shadow-(--shadow-soft) transition-colors hover:border-(--accent-ring) hover:bg-(--panel-strong) hover:text-(--ink) md:inline-flex"
			aria-label="Search crates and Rust items"
			title="Global search"
		>
			<span class="inline-flex min-w-0 items-center gap-2">
				<Icon name="search" size={12} />
				<span class="truncate">Search crates, types, functions...</span>
			</span>
			<span class="inline-flex shrink-0 items-center gap-1" aria-hidden="true">
				<span class="kbd">⌘</span>
				<span class="kbd">K</span>
			</span>
		</a>

		<div class="flex items-center justify-end gap-2">
			<a
				href="https://github.com/jonfontaine/codeview"
				target="_blank"
				rel="noopener noreferrer"
				class="grid size-7 place-items-center rounded-md text-(--muted) transition-colors hover:bg-(--panel-strong) hover:text-(--ink)"
				aria-label="GitHub"
				title="View on GitHub"
			>
				<Icon name="github" size={14} />
			</a>
			{#if processingCount > 0}
				<div class="relative" onfocusin={openProcessingPopover} onfocusout={handleProcessingBlur}>
					<button
						type="button"
						class="badge badge-sm inline-flex items-center gap-1.5 border border-(--accent-ring) bg-(--accent-soft) text-(--accent)"
						title="Background parses running"
						aria-expanded={showProcessing}
						aria-haspopup="dialog"
						onclick={() => (showProcessing = !showProcessing)}
					>
						Parsing {processingCount}
					</button>
					{#if showProcessing}
						<div
							class="corner-squircle absolute right-0 z-20 mt-2 w-64 rounded-(--radius-card) border border-(--panel-border) bg-(--panel-solid) p-2 shadow-(--shadow-soft)"
							role="dialog"
							aria-label="Background parses"
						>
							<div class="px-2 pb-1 text-[10px] tracking-wider text-(--muted) uppercase">
								Background parses
							</div>
							{#if processingListQuery}
								<svelte:boundary>
									{@const crates = await processingListQuery}
									{#if crates && crates.length > 0}
										<div class="space-y-1">
											{#each crates as crate (crate.name)}
												<div
													class="corner-squircle flex items-center justify-between gap-2 rounded-(--radius-chip) bg-(--panel) px-2 py-1"
												>
													<span class="truncate text-xs font-medium text-(--ink)">
														{crate.name}
													</span>
													<span class="badge badge-sm">{crate.version}</span>
												</div>
											{/each}
										</div>
									{:else}
										<div class="p-2 text-xs text-(--muted)">No active parses</div>
									{/if}
									{#snippet pending()}
										<div class="flex items-center gap-2 p-2">
											<LoaderCircleIcon class="animate-spin" size={12} />
											<span class="text-xs text-(--muted)">Loading...</span>
										</div>
									{/snippet}
								</svelte:boundary>
							{:else}
								<div class="p-2 text-xs text-(--muted)">No active parses</div>
							{/if}
						</div>
					{/if}
				</div>
			{/if}
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

<SettingsDrawer
	bind:open={settingsOpen}
	{theme}
	{accentMode}
	{densityMode}
	{voiceMode}
	{codeThemeLight}
	{codeThemeDark}
	{extLinkMode}
	{sourceProviderMode}
	{vcsMode}
	onThemeChange={applyTheme}
	onAccentChange={setAccent}
	onDensityChange={setDensity}
	onVoiceChange={setVoice}
	onCodeThemeLightChange={setCodeThemeLight}
	onCodeThemeDarkChange={setCodeThemeDark}
	onExtLinkModeChange={setExtLinkMode}
	onSourceProviderModeChange={setSourceProviderMode}
	onVcsModeChange={setVcsMode}
	onEditorSchemeChange={setEditorScheme}
/>

<Toaster position="bottom-right" expand={false} />
