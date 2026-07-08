<script lang="ts">
	import { browser } from '$app/environment';
	import { untrack } from 'svelte';
	import * as Sheet from '$lib/shadcn/ui/sheet/index.js';
	import {
		CUSTOM_EDITOR_KEY,
		EDITOR_KEY,
		EDITOR_VALUES,
		readClientPref,
		readStoredPref,
		type EditorId,
		writePref,
	} from '$lib/preferences';
	import {
		SunIcon,
		MoonIcon,
		MonitorIcon,
		ExternalLinkIcon,
		LinkIcon,
		DatabaseIcon,
		GlobeIcon,
		ZapIcon,
		SettingsIcon,
		GitBranchIcon,
		GitForkIcon,
		BookOpenIcon,
		PanelRightIcon,
		Columns2Icon,
	} from '@lucide/svelte';
	import type {
		Theme,
		AccentMode,
		DensityMode,
		VoiceMode,
		DocLayoutMode,
		CodeTheme,
		ExternalLinkMode,
		SourceProviderMode,
		VcsMode,
	} from '$lib/context';

	interface Props {
		open: boolean;
		theme: Theme;
		accentMode: AccentMode;
		densityMode: DensityMode;
		voiceMode: VoiceMode;
		docLayout: DocLayoutMode;
		codeThemeLight: CodeTheme;
		codeThemeDark: CodeTheme;
		extLinkMode: ExternalLinkMode;
		sourceProviderMode: SourceProviderMode;
		vcsMode: VcsMode;
		onThemeChange: (theme: Theme) => void;
		onAccentChange: (mode: AccentMode) => void;
		onDensityChange: (mode: DensityMode) => void;
		onVoiceChange: (mode: VoiceMode) => void;
		onDocLayoutChange: (mode: DocLayoutMode) => void;
		onCodeThemeLightChange: (theme: CodeTheme) => void;
		onCodeThemeDarkChange: (theme: CodeTheme) => void;
		onExtLinkModeChange: (mode: ExternalLinkMode) => void;
		onSourceProviderModeChange: (mode: SourceProviderMode) => void;
		onVcsModeChange: (mode: VcsMode) => void;
		onEditorSchemeChange?: (scheme: string) => void;
		onOpenChange?: (open: boolean) => void;
	}

	let {
		open = $bindable(false),
		theme,
		accentMode,
		densityMode,
		voiceMode,
		docLayout,
		codeThemeLight,
		codeThemeDark,
		extLinkMode,
		sourceProviderMode,
		vcsMode,
		onThemeChange,
		onAccentChange,
		onDensityChange,
		onVoiceChange,
		onDocLayoutChange,
		onCodeThemeLightChange,
		onCodeThemeDarkChange,
		onExtLinkModeChange,
		onSourceProviderModeChange,
		onVcsModeChange,
		onEditorSchemeChange,
		onOpenChange,
	}: Props = $props();

	// ── Editor + ligatures (kept from previous drawer) ──
	const LIGATURES_KEY = 'codeview-ligatures';

	const editors: { id: EditorId; label: string; scheme: string }[] = [
		{ id: 'vscode', label: 'VS Code', scheme: 'vscode://file/{path}:{line}' },
		{ id: 'cursor', label: 'Cursor', scheme: 'cursor://file/{path}:{line}' },
		{ id: 'zed', label: 'Zed', scheme: 'zed://file/{path}:{line}' },
		{ id: 'neovim', label: 'Neovim', scheme: 'nvim://open?file={path}&line={line}' },
		{ id: 'custom', label: 'Custom', scheme: '' },
	];

	const themeOptions: { id: Theme; label: string; Icon: typeof SunIcon }[] = [
		{ id: 'light', label: 'Light', Icon: SunIcon },
		{ id: 'dark', label: 'Dark', Icon: MoonIcon },
		{ id: 'system', label: 'System', Icon: MonitorIcon },
	];

	const sourceProviders: { id: SourceProviderMode; label: string }[] = [
		{ id: 'auto', label: 'Auto' },
		{ id: 'crates-io', label: 'crates.io' },
		{ id: 'github', label: 'GitHub' },
	];

	const linkOptions: { id: ExternalLinkMode; label: string; Icon: typeof LinkIcon }[] = [
		{ id: 'codeview', label: 'Codeview', Icon: LinkIcon },
		{ id: 'docs', label: 'docs.rs', Icon: ExternalLinkIcon },
	];

	const vcsOptions: { id: VcsMode; label: string; Icon: typeof GitBranchIcon }[] = [
		{ id: 'git', label: 'git', Icon: GitBranchIcon },
		{ id: 'jj', label: 'jj', Icon: GitForkIcon },
	];

	// Each accent option is a 3-color strip so the user previews the family
	// (accent / paper / ink) — same swatch model as the design canvas.
	const accentOptions: {
		id: AccentMode;
		label: string;
		swatch: [string, string, string];
	}[] = [
		{ id: 'orange', label: 'Orange', swatch: ['#cb4b16', '#fdf6e3', '#586e75'] },
		{ id: 'cobalt', label: 'Cobalt', swatch: ['#1f6fa5', '#fdf6e3', '#586e75'] },
		{ id: 'forest', label: 'Forest', swatch: ['#4f7d2f', '#fdf6e3', '#586e75'] },
		{ id: 'plum', label: 'Plum', swatch: ['#8c3a76', '#fdf6e3', '#586e75'] },
		{ id: 'char', label: 'Charcoal', swatch: ['#2b323a', '#fdf6e3', '#586e75'] },
	];

	const densityOptions: { id: DensityMode; label: string; hint: string }[] = [
		{ id: 'compact', label: 'Compact', hint: '13px' },
		{ id: 'comfortable', label: 'Comfort', hint: '14px' },
		{ id: 'spacious', label: 'Spacious', hint: '15px' },
	];

	const voiceOptions: { id: VoiceMode; label: string; hint: string }[] = [
		{ id: 'editorial', label: 'Editorial', hint: 'Fraunces · Inter' },
		{ id: 'technical', label: 'Technical', hint: 'IBM Plex Sans' },
		{ id: 'geometric', label: 'Geometric', hint: 'Space Grotesk' },
	];

	const docLayoutOptions: {
		id: DocLayoutMode;
		label: string;
		hint: string;
		Icon: typeof BookOpenIcon;
	}[] = [
		{ id: 'classic', label: 'Classic', hint: 'Docs + TOC', Icon: PanelRightIcon },
		{ id: 'reading', label: 'Reading', hint: 'Single column', Icon: BookOpenIcon },
		{ id: 'split', label: 'Split', hint: 'Docs + source', Icon: Columns2Icon },
	];

	const lightCodeOptions: { id: CodeTheme; label: string }[] = [
		{ id: 'solarized-light', label: 'Solarized Light' },
		{ id: 'catppuccin-latte', label: 'Catppuccin Latte' },
		{ id: 'one-light', label: 'One Light' },
		{ id: 'github-light', label: 'GitHub Light' },
	];

	const darkCodeOptions: { id: CodeTheme; label: string }[] = [
		{ id: 'solarized-dark', label: 'Solarized Dark' },
		{ id: 'catppuccin-mocha', label: 'Catppuccin Mocha' },
		{ id: 'one-dark', label: 'One Dark' },
		{ id: 'github-dark', label: 'GitHub Dark' },
	];

	let editor = $state<EditorId>('vscode');
	let customScheme = $state('');
	let ligatures = $state(false);
	let sheetContentRef = $state<HTMLDivElement | null>(null);

	const activeEditorScheme = $derived(
		editor === 'custom'
			? customScheme || 'scheme://file/{path}:{line}'
			: (editors.find((e) => e.id === editor)?.scheme ?? ''),
	);

	function activeIndex<T extends string>(items: readonly { id: T }[], active: T): number {
		const index = items.findIndex((item) => item.id === active);
		return index < 0 ? 0 : index;
	}

	function indicatorStyle(index: number, count: number): string {
		return `left: calc(${(index * 100) / count}% + 0.25rem); width: calc(${100 / count}% - 0.5rem)`;
	}

	const themeIndex = $derived(activeIndex(themeOptions, theme));
	const densityIndex = $derived(activeIndex(densityOptions, densityMode));
	const voiceIndex = $derived(activeIndex(voiceOptions, voiceMode));
	const docLayoutIndex = $derived(activeIndex(docLayoutOptions, docLayout));
	const editorIndex = $derived(activeIndex(editors, editor));
	const linkIndex = $derived(activeIndex(linkOptions, extLinkMode));
	const sourceIndex = $derived(activeIndex(sourceProviders, sourceProviderMode));
	const vcsIndex = $derived(activeIndex(vcsOptions, vcsMode));

	// ── Persistence (editor + ligatures only — tweak axes persisted in +layout) ──
	function loadSettings() {
		if (!browser) return;
		editor = readStoredPref(EDITOR_KEY, EDITOR_VALUES, 'vscode');
		customScheme = readClientPref(CUSTOM_EDITOR_KEY, '');

		const storedLigatures = localStorage.getItem(LIGATURES_KEY);
		if (storedLigatures !== null) {
			ligatures = storedLigatures === 'true';
		}
		applyLigatures(ligatures);
	}

	function setEditor(id: EditorId) {
		editor = id;
		if (browser) writePref(EDITOR_KEY, id);
	}

	function setCustomScheme(value: string) {
		customScheme = value;
		if (browser) writePref(CUSTOM_EDITOR_KEY, value);
	}

	function setLigatures(value: boolean) {
		ligatures = value;
		if (browser) localStorage.setItem(LIGATURES_KEY, String(value));
		applyLigatures(value);
	}

	function applyLigatures(value: boolean) {
		if (!browser) return;
		document.documentElement.style.setProperty('--font-ligatures', value ? 'normal' : 'none');
	}

	function handleOpenAutoFocus(event: Event) {
		event.preventDefault();
		requestAnimationFrame(() => sheetContentRef?.focus({ preventScroll: true }));
	}

	// Notify parent whenever editor scheme changes
	$effect(() => {
		onEditorSchemeChange?.(activeEditorScheme);
	});

	let loadedForOpen = false;

	$effect(() => {
		if (!open) {
			loadedForOpen = false;
			return;
		}
		if (loadedForOpen) return;
		loadedForOpen = true;
		untrack(loadSettings);
	});
</script>

<Sheet.Root bind:open onOpenChange={(v) => onOpenChange?.(v)}>
	<Sheet.Content
		bind:ref={sheetContentRef}
		preventScroll={false}
		onOpenAutoFocus={handleOpenAutoFocus}
		side="right"
		class="settings-sheet !gap-0 overflow-y-auto border-l border-(--panel-border) bg-(--bg) !p-0 sm:!max-w-[26rem]"
	>
		<!-- ── Header ─────────────────────────────────────────────
			 px-5 pr-12 reserves room for the shadcn-rendered X close
			 button which sits absolute at top-4 right-4. Sheet.Header
			 is wrapped in a div with consistent vertical rhythm. -->
		<div class="border-b border-(--panel-border-soft) px-5 pt-5 pr-12 pb-4">
			<Sheet.Header class="!gap-1 !p-0">
				<div class="flex items-center gap-2.5">
					<div
						class="corner-squircle flex h-7 w-7 items-center justify-center rounded-(--radius-chip) bg-(--accent)"
					>
						<SettingsIcon size={14} class="text-(--on-accent)" />
					</div>
					<Sheet.Title
						class="font-display text-[17px] leading-none font-semibold tracking-tight text-(--ink)"
					>
						Settings
					</Sheet.Title>
				</div>
				<Sheet.Description class="text-[11px] text-(--muted)">
					Theme, type, density &amp; integration preferences.
				</Sheet.Description>
			</Sheet.Header>
		</div>

		<!-- ── Scrollable sections ── -->
		<div class="flex flex-col gap-1.5 px-4 pb-8">
			<!-- ════════════════════════════════════════════
			     UI MODE
			     ════════════════════════════════════════════ -->
			<section class="corner-squircle rounded-(--radius-card) bg-(--panel-solid) p-4">
				<h3
					class="font-display mb-3 text-[13px] font-semibold tracking-wide text-(--muted) uppercase"
				>
					UI mode
				</h3>

				<div class="flex flex-col gap-1">
					<div
						class="corner-squircle relative grid grid-cols-3 items-stretch rounded-(--radius-control) border border-(--panel-border) bg-(--panel) p-1"
					>
						<div
							class="corner-squircle absolute top-1 bottom-1 rounded-(--radius-chip) bg-(--accent) transition-all duration-200 ease-out"
							style={indicatorStyle(themeIndex, themeOptions.length)}
						></div>
						{#each themeOptions as opt (opt.id)}
							<button
								type="button"
								class="relative z-10 inline-flex items-center justify-center gap-1.5 rounded-(--radius-chip) px-3 py-1.5 text-xs font-medium transition-colors {theme ===
								opt.id
									? 'text-(--on-accent)'
									: 'text-(--muted) hover:text-(--ink)'}"
								onclick={() => onThemeChange(opt.id)}
							>
								<opt.Icon
									size={13}
									class="transition-transform duration-200 {theme === opt.id ? 'scale-110' : ''}"
								/>
								{opt.label}
							</button>
						{/each}
					</div>
				</div>
			</section>

			<!-- ════════════════════════════════════════════
			     ACCENT
			     ════════════════════════════════════════════ -->
			<section class="corner-squircle rounded-(--radius-card) bg-(--panel-solid) p-4">
				<h3
					class="font-display mb-3 text-[13px] font-semibold tracking-wide text-(--muted) uppercase"
				>
					Accent
				</h3>

				<div class="flex flex-col gap-2">
					<div class="grid grid-cols-5 gap-1.5">
						{#each accentOptions as opt (opt.id)}
							<button
								type="button"
								title={opt.label}
								aria-label={opt.label}
								aria-pressed={accentMode === opt.id}
								class="accent-chip corner-squircle relative h-10 overflow-hidden rounded-(--radius-chip) border-2 transition-all {accentMode ===
								opt.id
									? 'border-(--ink) shadow-(--shadow-toggle)'
									: 'border-transparent hover:scale-105'}"
								style="background: linear-gradient(90deg, {opt.swatch[0]} 0%, {opt
									.swatch[0]} 60%, {opt.swatch[1]} 60%, {opt.swatch[1]} 80%, {opt
									.swatch[2]} 80%, {opt.swatch[2]} 100%)"
								onclick={() => onAccentChange(opt.id)}
							></button>
						{/each}
					</div>
					<span class="text-[10.5px] text-(--muted)">
						{accentOptions.find((a) => a.id === accentMode)?.label} — accent, paper, ink
					</span>
				</div>
			</section>

			<!-- ════════════════════════════════════════════
			     DENSITY
			     ════════════════════════════════════════════ -->
			<section class="corner-squircle rounded-(--radius-card) bg-(--panel-solid) p-4">
				<h3
					class="font-display mb-3 text-[13px] font-semibold tracking-wide text-(--muted) uppercase"
				>
					Density
				</h3>

				<div class="flex flex-col gap-1">
					<div
						class="corner-squircle relative grid grid-cols-3 items-stretch rounded-(--radius-control) border border-(--panel-border) bg-(--panel) p-1"
					>
						<div
							class="corner-squircle absolute top-1 bottom-1 rounded-(--radius-chip) bg-(--accent) transition-all duration-200 ease-out"
							style={indicatorStyle(densityIndex, densityOptions.length)}
						></div>
						{#each densityOptions as opt (opt.id)}
							<button
								type="button"
								class="relative z-10 inline-flex flex-col items-center justify-center gap-0.5 rounded-(--radius-chip) px-3 py-1.5 text-xs font-medium transition-colors {densityMode ===
								opt.id
									? 'text-(--on-accent)'
									: 'text-(--muted) hover:text-(--ink)'}"
								onclick={() => onDensityChange(opt.id)}
							>
								<span>{opt.label}</span>
								<span class="font-mono text-[9px] opacity-70">{opt.hint}</span>
							</button>
						{/each}
					</div>
				</div>
			</section>

			<!-- ════════════════════════════════════════════
			     VOICE
			     ════════════════════════════════════════════ -->
			<section class="corner-squircle rounded-(--radius-card) bg-(--panel-solid) p-4">
				<h3
					class="font-display mb-3 text-[13px] font-semibold tracking-wide text-(--muted) uppercase"
				>
					Voice
				</h3>

				<div class="flex flex-col gap-2">
					<div
						class="corner-squircle relative grid grid-cols-3 items-stretch rounded-(--radius-control) border border-(--panel-border) bg-(--panel) p-1"
					>
						<div
							class="corner-squircle absolute top-1 bottom-1 rounded-(--radius-chip) bg-(--accent) transition-all duration-200 ease-out"
							style={indicatorStyle(voiceIndex, voiceOptions.length)}
						></div>
						{#each voiceOptions as opt (opt.id)}
							<button
								type="button"
								class="relative z-10 inline-flex flex-col items-center justify-center gap-0.5 rounded-(--radius-chip) px-2 py-1.5 text-xs font-medium transition-colors {voiceMode ===
								opt.id
									? 'text-(--on-accent)'
									: 'text-(--muted) hover:text-(--ink)'}"
								onclick={() => onVoiceChange(opt.id)}
							>
								<span>{opt.label}</span>
								<span class="font-mono text-[9px] opacity-70">{opt.hint}</span>
							</button>
						{/each}
					</div>
					<!-- Live voice preview -->
					<div
						class="corner-squircle rounded-(--radius-chip) border border-(--panel-border-soft) bg-(--panel) px-3 py-2"
					>
						<div class="font-display text-[15px] font-semibold text-(--ink)">
							Type that fits the page
						</div>
						<div class="text-[11px] text-(--muted)">A quick brown fox jumps over the lazy dog.</div>
					</div>
				</div>
			</section>

			<!-- ════════════════════════════════════════════
			     DOC LAYOUT
			     ════════════════════════════════════════════ -->
			<section class="corner-squircle rounded-(--radius-card) bg-(--panel-solid) p-4">
				<h3
					class="font-display mb-3 text-[13px] font-semibold tracking-wide text-(--muted) uppercase"
				>
					Doc layout
				</h3>

				<div class="flex flex-col gap-1">
					<div
						class="corner-squircle relative grid grid-cols-3 items-stretch rounded-(--radius-control) border border-(--panel-border) bg-(--panel) p-1"
					>
						<div
							class="corner-squircle absolute top-1 bottom-1 rounded-(--radius-chip) bg-(--accent) transition-all duration-200 ease-out"
							style={indicatorStyle(docLayoutIndex, docLayoutOptions.length)}
						></div>
						{#each docLayoutOptions as opt (opt.id)}
							<button
								type="button"
								class="relative z-10 inline-flex flex-col items-center justify-center gap-0.5 rounded-(--radius-chip) px-2 py-1.5 text-xs font-medium transition-colors {docLayout ===
								opt.id
									? 'text-(--on-accent)'
									: 'text-(--muted) hover:text-(--ink)'}"
								onclick={() => onDocLayoutChange(opt.id)}
							>
								<opt.Icon
									size={13}
									class="transition-transform duration-200 {docLayout === opt.id
										? 'scale-110'
										: ''}"
								/>
								<span>{opt.label}</span>
								<span class="font-mono text-[9px] opacity-70">{opt.hint}</span>
							</button>
						{/each}
					</div>
					<span class="mt-0.5 text-[10px] text-(--muted)">
						Layouts change the full docs route composition.
					</span>
				</div>
			</section>

			<!-- ════════════════════════════════════════════
			     CODE THEME
			     ════════════════════════════════════════════ -->
			<section class="corner-squircle rounded-(--radius-card) bg-(--panel-solid) p-4">
				<h3
					class="font-display mb-3 text-[13px] font-semibold tracking-wide text-(--muted) uppercase"
				>
					Code theme
				</h3>

				<div class="flex flex-col gap-3">
					<!-- ── Light mode picker + live preview ── -->
					<div class="flex flex-col gap-1.5">
						<label class="flex flex-col gap-1">
							<span class="text-xs font-medium text-(--ink)">Light mode</span>
							<select
								value={codeThemeLight}
								onchange={(e) => onCodeThemeLightChange(e.currentTarget.value as CodeTheme)}
								class="corner-squircle rounded-(--radius-chip) border border-(--panel-border) bg-(--panel) px-2 py-1.5 text-xs text-(--ink) focus:border-(--accent) focus:ring-1 focus:ring-(--accent) focus:outline-none"
							>
								{#each lightCodeOptions as opt (opt.id)}
									<option value={opt.id}>{opt.label}</option>
								{/each}
							</select>
						</label>
						<!-- The wrapper carries data-code-theme so syntax vars
							 cascade locally regardless of the ambient UI theme. -->
						<div
							data-code-theme={codeThemeLight}
							class="codeblock corner-squircle overflow-hidden rounded-(--radius-chip) font-mono text-[11px] leading-[1.65]"
						>
							<pre class="m-0 px-3 py-2"><span class="tok-kw">pub fn</span> <span
									class="tok-fn">greet</span>(<span class="tok-id">name</span>: <span
									class="tok-ty">&str</span>) -&gt; <span class="tok-ty">String</span> <span
									class="tok-mu">&#123;</span>
    <span class="tok-fn">format!</span>(<span class="tok-str">"hi, &#123;name&#125;"</span>)
<span class="tok-mu">&#125;</span></pre>
						</div>
					</div>

					<!-- ── Dark mode picker + live preview ── -->
					<div class="flex flex-col gap-1.5">
						<label class="flex flex-col gap-1">
							<span class="text-xs font-medium text-(--ink)">Dark mode</span>
							<select
								value={codeThemeDark}
								onchange={(e) => onCodeThemeDarkChange(e.currentTarget.value as CodeTheme)}
								class="corner-squircle rounded-(--radius-chip) border border-(--panel-border) bg-(--panel) px-2 py-1.5 text-xs text-(--ink) focus:border-(--accent) focus:ring-1 focus:ring-(--accent) focus:outline-none"
							>
								{#each darkCodeOptions as opt (opt.id)}
									<option value={opt.id}>{opt.label}</option>
								{/each}
							</select>
						</label>
						<div
							data-code-theme={codeThemeDark}
							class="codeblock corner-squircle overflow-hidden rounded-(--radius-chip) font-mono text-[11px] leading-[1.65]"
						>
							<pre class="m-0 px-3 py-2"><span class="tok-kw">pub fn</span> <span
									class="tok-fn">greet</span>(<span class="tok-id">name</span>: <span
									class="tok-ty">&str</span>) -&gt; <span class="tok-ty">String</span> <span
									class="tok-mu">&#123;</span>
    <span class="tok-fn">format!</span>(<span class="tok-str">"hi, &#123;name&#125;"</span>)
<span class="tok-mu">&#125;</span></pre>
						</div>
					</div>

					<!-- Ligatures toggle -->
					<div class="flex items-center justify-between">
						<div class="flex flex-col">
							<span class="text-xs font-medium text-(--ink)">Ligatures</span>
							<span class="text-[10px] text-(--muted)">Combine glyphs like {'=> -> !='}</span>
						</div>
						<button
							type="button"
							class="relative h-6 w-11 rounded-full transition-colors duration-200 {ligatures
								? 'bg-(--accent)'
								: 'bg-(--panel-border)'}"
							onclick={() => setLigatures(!ligatures)}
							role="switch"
							aria-checked={ligatures}
							aria-label="Toggle ligatures"
						>
							<span
								class="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200 {ligatures
									? 'translate-x-5'
									: ''}"
							></span>
						</button>
					</div>
				</div>
			</section>

			<!-- ════════════════════════════════════════════
			     EXTERNAL LINKS
			     ════════════════════════════════════════════ -->
			<section class="corner-squircle rounded-(--radius-card) bg-(--panel-solid) p-4">
				<h3
					class="font-display mb-3 text-[13px] font-semibold tracking-wide text-(--muted) uppercase"
				>
					External Links
				</h3>

				<div class="flex flex-col gap-4">
					<!-- Link mode -->
					<div class="flex flex-col gap-1">
						<span class="text-xs font-medium text-(--ink)">Doc links open in</span>
						<div
							class="corner-squircle relative grid grid-cols-2 items-stretch rounded-(--radius-control) border border-(--panel-border) bg-(--panel) p-1"
						>
							<div
								class="corner-squircle absolute top-1 bottom-1 rounded-(--radius-chip) bg-(--accent) transition-all duration-200 ease-out"
								style={indicatorStyle(linkIndex, linkOptions.length)}
							></div>
							{#each linkOptions as opt (opt.id)}
								<button
									type="button"
									class="relative z-10 inline-flex items-center justify-center gap-1.5 rounded-(--radius-chip) px-3 py-1.5 text-xs font-medium transition-colors {extLinkMode ===
									opt.id
										? 'text-(--on-accent)'
										: 'text-(--muted) hover:text-(--ink)'}"
									onclick={() => onExtLinkModeChange(opt.id)}
								>
									<opt.Icon size={13} />
									{opt.label}
								</button>
							{/each}
						</div>
						<span class="mt-0.5 text-[10px] text-(--muted)">
							{extLinkMode === 'docs'
								? 'External crate links open on docs.rs'
								: 'External crate links stay within Codeview'}
						</span>
					</div>

					<!-- Source links -->
					<div class="flex flex-col gap-1">
						<span class="text-xs font-medium text-(--ink)">Source links</span>
						<div
							class="corner-squircle relative grid grid-cols-3 items-stretch rounded-(--radius-control) border border-(--panel-border) bg-(--panel) p-1"
						>
							<div
								class="corner-squircle absolute top-1 bottom-1 rounded-(--radius-chip) bg-(--accent) transition-all duration-200 ease-out"
								style={indicatorStyle(sourceIndex, sourceProviders.length)}
							></div>
							{#each sourceProviders as prov (prov.id)}
								<button
									type="button"
									class="relative z-10 inline-flex items-center justify-center gap-1.5 rounded-(--radius-chip) px-2 py-1.5 text-xs font-medium transition-colors {sourceProviderMode ===
									prov.id
										? 'text-(--on-accent)'
										: 'text-(--muted) hover:text-(--ink)'}"
									onclick={() => onSourceProviderModeChange(prov.id)}
								>
									{#if prov.id === 'github'}
										<GlobeIcon size={12} />
									{:else if prov.id === 'crates-io'}
										<DatabaseIcon size={12} />
									{:else}
										<ZapIcon size={12} />
									{/if}
									{prov.label}
								</button>
							{/each}
						</div>
					</div>
				</div>
			</section>

			<!-- ════════════════════════════════════════════
			     EDITOR
			     ════════════════════════════════════════════ -->
			<section class="corner-squircle rounded-(--radius-card) bg-(--panel-solid) p-4">
				<h3
					class="font-display mb-3 text-[13px] font-semibold tracking-wide text-(--muted) uppercase"
				>
					Editor
				</h3>

				<div class="flex flex-col gap-3">
					<!-- Editor selector -->
					<div class="flex flex-col gap-1">
						<span class="text-xs font-medium text-(--ink)">Open files in</span>
						<div
							class="corner-squircle relative grid grid-cols-5 items-stretch rounded-(--radius-control) border border-(--panel-border) bg-(--panel) p-1"
						>
							<div
								class="corner-squircle absolute top-1 bottom-1 rounded-(--radius-chip) bg-(--accent) transition-all duration-200 ease-out"
								style={indicatorStyle(editorIndex, editors.length)}
							></div>
							{#each editors as ed (ed.id)}
								<button
									type="button"
									class="relative z-10 rounded-(--radius-chip) px-2 py-1.5 text-center text-xs font-medium transition-colors {editor ===
									ed.id
										? 'text-(--on-accent)'
										: 'text-(--muted) hover:text-(--ink)'}"
									onclick={() => setEditor(ed.id)}
								>
									{ed.label}
								</button>
							{/each}
						</div>
					</div>

					<!-- URI scheme preview / custom input -->
					<div class="flex flex-col gap-1">
						<span class="text-[10px] font-medium tracking-wider text-(--muted) uppercase">
							URI Scheme
						</span>
						{#if editor === 'custom'}
							<input
								type="text"
								value={customScheme}
								oninput={(e) => setCustomScheme(e.currentTarget.value)}
								placeholder="myeditor://open?file={'{path}'}&line={'{line}'}"
								class="corner-squircle w-full rounded-(--radius-chip) border border-(--panel-border) bg-(--panel) px-3 py-2 font-mono text-[11px] text-(--ink) placeholder:text-(--muted) focus:border-(--accent) focus:ring-1 focus:ring-(--accent) focus:outline-none"
							/>
						{:else}
							<div
								class="corner-squircle rounded-(--radius-chip) border border-(--panel-border) bg-(--code-bg) px-3 py-2 font-mono text-[11px] text-(--code-ink)"
							>
								{activeEditorScheme}
							</div>
						{/if}
						<span class="text-[10px] text-(--muted)">
							<code class="text-(--accent)">{'{path}'}</code>
							and
							<code class="text-(--accent)">{'{line}'}</code>
							are replaced with the file path and line number
						</span>
					</div>
				</div>
			</section>

			<!-- ════════════════════════════════════════════
			     VERSION CONTROL
			     ════════════════════════════════════════════ -->
			<section class="corner-squircle rounded-(--radius-card) bg-(--panel-solid) p-4">
				<h3
					class="font-display mb-3 text-[13px] font-semibold tracking-wide text-(--muted) uppercase"
				>
					Version Control
				</h3>

				<div class="flex flex-col gap-1">
					<span class="text-xs font-medium text-(--ink)">Clone command</span>
					<div
						class="corner-squircle relative grid grid-cols-2 items-stretch rounded-(--radius-control) border border-(--panel-border) bg-(--panel) p-1"
					>
						<div
							class="corner-squircle absolute top-1 bottom-1 rounded-(--radius-chip) bg-(--accent) transition-all duration-200 ease-out"
							style={indicatorStyle(vcsIndex, vcsOptions.length)}
						></div>
						{#each vcsOptions as opt (opt.id)}
							<button
								type="button"
								class="relative z-10 inline-flex items-center justify-center gap-1.5 rounded-(--radius-chip) px-3 py-1.5 text-xs font-medium transition-colors {vcsMode ===
								opt.id
									? 'text-(--on-accent)'
									: 'text-(--muted) hover:text-(--ink)'}"
								onclick={() => onVcsModeChange(opt.id)}
							>
								<opt.Icon
									size={13}
									class="transition-transform duration-200 {vcsMode === opt.id ? 'scale-110' : ''}"
								/>
								{opt.label}
							</button>
						{/each}
					</div>
					<span class="mt-0.5 text-[10px] text-(--muted)">Used when cloning repositories</span>
				</div>
			</section>
		</div>
	</Sheet.Content>
</Sheet.Root>

<style>
	.accent-chip:focus-visible {
		outline: 2px solid var(--accent-ring);
		outline-offset: 2px;
	}

	/* Make the shadcn-rendered close button more visible against the
	   drawer background, and align it with our compact header padding. */
	:global(.settings-sheet button[data-bits-dialog-close]) {
		top: 14px;
		right: 14px;
		padding: 6px;
		border-radius: 6px;
		background: var(--panel-strong);
		color: var(--muted);
		border: 1px solid var(--panel-border);
		transition:
			background 0.12s,
			color 0.12s;
	}
	:global(.settings-sheet button[data-bits-dialog-close]:hover) {
		background: var(--accent-soft);
		color: var(--accent);
		border-color: var(--accent-ring);
	}
</style>
