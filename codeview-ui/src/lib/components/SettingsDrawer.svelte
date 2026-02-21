<script lang="ts">
	import { browser } from '$app/environment';
	import * as Sheet from '$lib/shadcn/ui/sheet/index.js';
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
	} from '@lucide/svelte';
	import type { Theme, ExternalLinkMode, SourceProviderMode, VcsMode } from '$lib/context';

	interface Props {
		open: boolean;
		theme: Theme;
		extLinkMode: ExternalLinkMode;
		sourceProviderMode: SourceProviderMode;
		vcsMode: VcsMode;
		onThemeChange: (theme: Theme) => void;
		onExtLinkModeChange: (mode: ExternalLinkMode) => void;
		onSourceProviderModeChange: (mode: SourceProviderMode) => void;
		onVcsModeChange: (mode: VcsMode) => void;
		onEditorSchemeChange?: (scheme: string) => void;
		onOpenChange?: (open: boolean) => void;
	}

	let {
		open = $bindable(false),
		theme,
		extLinkMode,
		sourceProviderMode,
		vcsMode,
		onThemeChange,
		onExtLinkModeChange,
		onSourceProviderModeChange,
		onVcsModeChange,
		onEditorSchemeChange,
		onOpenChange,
	}: Props = $props();

	// ── Editor preference ──
	const EDITOR_KEY = 'codeview-editor';
	const CUSTOM_EDITOR_KEY = 'codeview-editor-custom';
	const UI_FONT_KEY = 'codeview-ui-font';
	const CODE_FONT_KEY = 'codeview-code-font';
	const LIGATURES_KEY = 'codeview-ligatures';
	const FONT_SIZE_KEY = 'codeview-font-size';

	type EditorId = 'vscode' | 'cursor' | 'zed' | 'neovim' | 'custom';
	type UIFontId = 'space-grotesk' | 'geist' | 'system';
	type CodeFontId = 'inherit' | 'jetbrains-mono' | 'geist-mono' | 'system-mono';

	const editors: { id: EditorId; label: string; scheme: string }[] = [
		{ id: 'vscode', label: 'VS Code', scheme: 'vscode://file/{path}:{line}' },
		{ id: 'cursor', label: 'Cursor', scheme: 'cursor://file/{path}:{line}' },
		{ id: 'zed', label: 'Zed', scheme: 'zed://file/{path}:{line}' },
		{ id: 'neovim', label: 'Neovim', scheme: 'nvim://open?file={path}&line={line}' },
		{ id: 'custom', label: 'Custom', scheme: '' },
	];

	const uiFonts: { id: UIFontId; label: string; family: string }[] = [
		{ id: 'space-grotesk', label: 'Space Grotesk', family: "'Space Grotesk', sans-serif" },
		{ id: 'geist', label: 'Geist', family: "'Geist', sans-serif" },
		{ id: 'system', label: 'System', family: 'system-ui, sans-serif' },
	];

	const codeFonts: { id: CodeFontId; label: string; family: string }[] = [
		{ id: 'inherit', label: 'Inherit', family: '' },
		{ id: 'jetbrains-mono', label: 'JetBrains Mono', family: "'JetBrains Mono', monospace" },
		{ id: 'geist-mono', label: 'Geist Mono', family: "'Geist Mono', monospace" },
		{ id: 'system-mono', label: 'System Mono', family: "'SF Mono', 'Cascadia Code', 'Consolas', monospace" },
	];

	const sourceProviders: { id: SourceProviderMode; label: string }[] = [
		{ id: 'auto', label: 'Auto' },
		{ id: 'crates-io', label: 'crates.io' },
		{ id: 'github', label: 'GitHub' },
	];

	const vcsOptions: { id: VcsMode; label: string; Icon: typeof GitBranchIcon }[] = [
		{ id: 'git', label: 'git', Icon: GitBranchIcon },
		{ id: 'jj', label: 'jj', Icon: GitForkIcon },
	];

	let editor = $state<EditorId>('vscode');
	let customScheme = $state('');
	let uiFont = $state<UIFontId>('space-grotesk');
	let codeFont = $state<CodeFontId>('inherit');
	let ligatures = $state(false);
	let fontSize = $state(14);

	const activeEditorScheme = $derived(
		editor === 'custom'
			? customScheme || 'scheme://file/{path}:{line}'
			: (editors.find((e) => e.id === editor)?.scheme ?? ''),
	);

	const codeFontPreview = $derived(
		codeFont === 'inherit'
			? uiFonts.find((f) => f.id === uiFont)?.label ?? 'Space Grotesk'
			: codeFonts.find((f) => f.id === codeFont)?.label ?? '',
	);

	// ── Sliding indicator refs ──
	let themeRefs: Record<Theme, HTMLButtonElement | null> = $state({ light: null, dark: null, system: null });
	let editorRefs: Record<EditorId, HTMLButtonElement | null> = $state({
		vscode: null,
		cursor: null,
		zed: null,
		neovim: null,
		custom: null,
	});
	let uiFontRefs: Record<UIFontId, HTMLButtonElement | null> = $state({
		'space-grotesk': null,
		geist: null,
		system: null,
	});
	let linkRefs: Record<ExternalLinkMode, HTMLButtonElement | null> = $state({
		codeview: null,
		docs: null,
	});
	let sourceRefs: Record<SourceProviderMode, HTMLButtonElement | null> = $state({
		auto: null,
		'crates-io': null,
		github: null,
	});
	let vcsRefs: Record<VcsMode, HTMLButtonElement | null> = $state({
		git: null,
		jj: null,
	});

	function indicator(ref: HTMLButtonElement | null) {
		if (!ref) return { left: 0, width: 0 };
		return { left: ref.offsetLeft, width: ref.offsetWidth };
	}

	const themeIndicator = $derived(indicator(themeRefs[theme]));
	const editorIndicator = $derived(indicator(editorRefs[editor]));
	const uiFontIndicator = $derived(indicator(uiFontRefs[uiFont]));
	const linkIndicator = $derived(indicator(linkRefs[extLinkMode]));
	const sourceIndicator = $derived(indicator(sourceRefs[sourceProviderMode]));
	const vcsIndicator = $derived(indicator(vcsRefs[vcsMode]));

	// ── Persistence ──
	function loadSettings() {
		if (!browser) return;
		const storedEditor = localStorage.getItem(EDITOR_KEY);
		if (storedEditor && editors.some((e) => e.id === storedEditor)) {
			editor = storedEditor as EditorId;
		}
		customScheme = localStorage.getItem(CUSTOM_EDITOR_KEY) ?? '';

		// Migrate legacy font key
		const legacy = localStorage.getItem('codeview-font-family');
		if (legacy) {
			localStorage.removeItem('codeview-font-family');
			if (legacy === 'system') {
				localStorage.setItem(UI_FONT_KEY, 'system');
			} else if (legacy === 'mono') {
				localStorage.setItem(CODE_FONT_KEY, 'system-mono');
			}
		}

		const storedUIFont = localStorage.getItem(UI_FONT_KEY);
		if (storedUIFont && uiFonts.some((f) => f.id === storedUIFont)) {
			uiFont = storedUIFont as UIFontId;
		}
		applyUIFont(uiFont);

		const storedCodeFont = localStorage.getItem(CODE_FONT_KEY);
		if (storedCodeFont && codeFonts.some((f) => f.id === storedCodeFont)) {
			codeFont = storedCodeFont as CodeFontId;
		}
		applyCodeFont(codeFont);

		const storedLigatures = localStorage.getItem(LIGATURES_KEY);
		if (storedLigatures !== null) {
			ligatures = storedLigatures === 'true';
		}
		applyLigatures(ligatures);

		const storedSize = localStorage.getItem(FONT_SIZE_KEY);
		if (storedSize) {
			fontSize = parseInt(storedSize, 10) || 14;
			applyFontSize(fontSize);
		}
	}

	function setEditor(id: EditorId) {
		editor = id;
		if (browser) localStorage.setItem(EDITOR_KEY, id);
	}

	function setCustomScheme(value: string) {
		customScheme = value;
		if (browser) localStorage.setItem(CUSTOM_EDITOR_KEY, value);
	}

	function setUIFont(id: UIFontId) {
		uiFont = id;
		if (browser) localStorage.setItem(UI_FONT_KEY, id);
		applyUIFont(id);
	}

	function setCodeFont(id: CodeFontId) {
		codeFont = id;
		if (browser) localStorage.setItem(CODE_FONT_KEY, id);
		applyCodeFont(id);
	}

	function setLigatures(value: boolean) {
		ligatures = value;
		if (browser) localStorage.setItem(LIGATURES_KEY, String(value));
		applyLigatures(value);
	}

	function applyUIFont(id: UIFontId) {
		if (!browser) return;
		const root = document.documentElement;
		const font = uiFonts.find((f) => f.id === id);
		if (id === 'space-grotesk') {
			root.style.removeProperty('--font-body');
		} else if (font) {
			root.style.setProperty('--font-body', font.family);
		}
	}

	function applyCodeFont(id: CodeFontId) {
		if (!browser) return;
		const root = document.documentElement;
		const font = codeFonts.find((f) => f.id === id);
		if (id === 'inherit') {
			root.style.removeProperty('--font-code');
		} else if (font) {
			root.style.setProperty('--font-code', font.family);
		}
	}

	function applyLigatures(value: boolean) {
		if (!browser) return;
		document.documentElement.style.setProperty('--font-ligatures', value ? 'normal' : 'none');
	}

	function setFontSize(value: number) {
		fontSize = value;
		if (browser) localStorage.setItem(FONT_SIZE_KEY, String(value));
		applyFontSize(value);
	}

	function applyFontSize(value: number) {
		if (!browser) return;
		document.documentElement.style.setProperty('--font-size-base', `${value}px`);
	}

	// Notify parent whenever editor scheme changes
	$effect(() => {
		onEditorSchemeChange?.(activeEditorScheme);
	});

	$effect(() => {
		if (open) loadSettings();
	});
</script>

<Sheet.Root bind:open onOpenChange={(v) => onOpenChange?.(v)}>
	<Sheet.Content
		side="right"
		class="overflow-y-auto border-l border-(--panel-border) bg-(--bg) !p-0 !gap-0 sm:!max-w-[26rem]"
	>
		<!-- ── Header ── -->
		<div class="relative overflow-hidden px-6 pt-8 pb-5">
			<!-- Subtle glow behind header -->
			<div
				class="pointer-events-none absolute -top-12 -right-12 h-40 w-40 rounded-full opacity-30"
				style="background: radial-gradient(circle, var(--accent) 0%, transparent 70%)"
			></div>
			<Sheet.Header class="relative !p-0">
				<div class="flex items-center gap-2.5">
					<div
						class="corner-squircle flex h-8 w-8 items-center justify-center rounded-(--radius-chip) bg-(--accent)"
					>
						<SettingsIcon size={15} class="text-(--on-accent)" />
					</div>
					<Sheet.Title class="font-display text-xl font-bold tracking-tight text-(--ink)"
						>Settings</Sheet.Title
					>
				</div>
				<Sheet.Description class="mt-1.5 text-xs text-(--muted)"
					>Customize your Codeview experience</Sheet.Description
				>
			</Sheet.Header>
		</div>

		<!-- ── Scrollable sections ── -->
		<div class="flex flex-col gap-1.5 px-4 pb-8">
			<!-- ════════════════════════════════════════════
			     APPEARANCE
			     ════════════════════════════════════════════ -->
			<section class="corner-squircle rounded-(--radius-card) bg-(--panel-solid) p-4">
				<h3 class="font-display mb-3 text-[13px] font-semibold tracking-wide text-(--muted) uppercase">
					Appearance
				</h3>

				<div class="flex flex-col gap-1">
					<span class="text-xs font-medium text-(--ink)">Theme</span>
					<div
						class="corner-squircle relative flex items-center gap-1 rounded-(--radius-control) border border-(--panel-border) bg-(--panel) p-1"
					>
						<div
							class="corner-squircle absolute top-1 bottom-1 rounded-(--radius-chip) bg-(--accent) transition-all duration-200 ease-out"
							style="left: {themeIndicator.left}px; width: {themeIndicator.width}px"
						></div>
						{#each [{ id: 'light' as Theme, label: 'Light', Icon: SunIcon }, { id: 'dark' as Theme, label: 'Dark', Icon: MoonIcon }, { id: 'system' as Theme, label: 'System', Icon: MonitorIcon }] as opt (opt.id)}
							<button
								type="button"
								class="relative z-10 inline-flex flex-1 items-center justify-center gap-1.5 rounded-(--radius-chip) px-3 py-1.5 text-xs font-medium transition-colors {theme === opt.id ? 'text-(--on-accent)' : 'text-(--muted) hover:text-(--ink)'}"
								onclick={() => onThemeChange(opt.id)}
								{@attach (el) => { themeRefs[opt.id] = el as HTMLButtonElement; return () => { themeRefs[opt.id] = null; }; }}
							>
								<opt.Icon size={13} class="transition-transform duration-200 {theme === opt.id ? 'scale-110' : ''}" />
								{opt.label}
							</button>
						{/each}
					</div>
				</div>
			</section>

			<!-- ════════════════════════════════════════════
			     TYPOGRAPHY
			     ════════════════════════════════════════════ -->
			<section class="corner-squircle rounded-(--radius-card) bg-(--panel-solid) p-4">
				<h3 class="font-display mb-3 text-[13px] font-semibold tracking-wide text-(--muted) uppercase">
					Typography
				</h3>

				<div class="flex flex-col gap-4">
					<!-- Interface font -->
					<div class="flex flex-col gap-1">
						<span class="text-xs font-medium text-(--ink)">Interface font</span>
						<div
							class="corner-squircle relative flex items-center gap-1 rounded-(--radius-control) border border-(--panel-border) bg-(--panel) p-1"
						>
							<div
								class="corner-squircle absolute top-1 bottom-1 rounded-(--radius-chip) bg-(--accent) transition-all duration-200 ease-out"
								style="left: {uiFontIndicator.left}px; width: {uiFontIndicator.width}px"
							></div>
							{#each uiFonts as fam (fam.id)}
								<button
									type="button"
									class="relative z-10 flex-1 rounded-(--radius-chip) px-2 py-1.5 text-xs font-medium transition-colors {uiFont === fam.id ? 'text-(--on-accent)' : 'text-(--muted) hover:text-(--ink)'}"
									onclick={() => setUIFont(fam.id)}
									{@attach (el) => { uiFontRefs[fam.id] = el as HTMLButtonElement; return () => { uiFontRefs[fam.id] = null; }; }}
								>
									{fam.label}
								</button>
							{/each}
						</div>
						<span class="mt-0.5 text-[10px] text-(--muted)">
							<span style="font-family: {uiFonts.find(f => f.id === uiFont)?.family}">The quick brown fox jumps over the lazy dog</span>
						</span>
					</div>

					<!-- Code font -->
					<div class="flex flex-col gap-1">
						<span class="text-xs font-medium text-(--ink)">Code font</span>
						<div
							class="corner-squircle grid grid-cols-2 gap-1 rounded-(--radius-control) border border-(--panel-border) bg-(--panel) p-1"
						>
							{#each codeFonts as fam (fam.id)}
								<button
									type="button"
									class="corner-squircle rounded-(--radius-chip) px-2 py-1.5 text-xs font-medium transition-colors {codeFont === fam.id ? 'bg-(--accent) text-(--on-accent)' : 'text-(--muted) hover:text-(--ink) hover:bg-(--panel-strong)'}"
									onclick={() => setCodeFont(fam.id)}
								>
									{fam.label}
								</button>
							{/each}
						</div>
						<span class="mt-0.5 text-[10px] text-(--muted)">
							<code style="font-family: {codeFont === 'inherit' ? uiFonts.find(f => f.id === uiFont)?.family : codeFonts.find(f => f.id === codeFont)?.family}; font-variant-ligatures: {ligatures ? 'normal' : 'none'}">fn main() {'{'} => -> != == {codeFontPreview} {'}'}</code>
						</span>
					</div>

					<!-- Ligatures toggle -->
					<div class="flex items-center justify-between">
						<div class="flex flex-col">
							<span class="text-xs font-medium text-(--ink)">Ligatures</span>
							<span class="text-[10px] text-(--muted)">Combine glyphs like {'=> -> !='}</span>
						</div>
						<button
							type="button"
							class="relative h-6 w-11 rounded-full transition-colors duration-200 {ligatures ? 'bg-(--accent)' : 'bg-(--panel-border)'}"
							onclick={() => setLigatures(!ligatures)}
							role="switch"
							aria-checked={ligatures}
							aria-label="Toggle ligatures"
						>
							<span
								class="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200 {ligatures ? 'translate-x-5' : ''}"
							></span>
						</button>
					</div>

					<!-- Font size -->
					<div class="flex flex-col gap-1.5">
						<div class="flex items-center justify-between">
							<span class="text-xs font-medium text-(--ink)">Font size</span>
							<span
								class="corner-squircle rounded-(--radius-chip) border border-(--panel-border) bg-(--panel) px-2 py-0.5 text-[11px] font-medium tabular-nums text-(--ink)"
							>
								{fontSize}px
							</span>
						</div>
						<div class="relative flex items-center gap-3">
							<span class="text-[10px] text-(--muted)">12</span>
							<input
								type="range"
								min="12"
								max="20"
								step="1"
								value={fontSize}
								oninput={(e) => setFontSize(parseInt(e.currentTarget.value, 10))}
								class="settings-range flex-1"
							/>
							<span class="text-[10px] text-(--muted)">20</span>
						</div>
					</div>
				</div>
			</section>

			<!-- ════════════════════════════════════════════
			     EXTERNAL LINKS
			     ════════════════════════════════════════════ -->
			<section class="corner-squircle rounded-(--radius-card) bg-(--panel-solid) p-4">
				<h3 class="font-display mb-3 text-[13px] font-semibold tracking-wide text-(--muted) uppercase">
					External Links
				</h3>

				<div class="flex flex-col gap-4">
					<!-- Link mode -->
					<div class="flex flex-col gap-1">
						<span class="text-xs font-medium text-(--ink)">Doc links open in</span>
						<div
							class="corner-squircle relative flex items-center gap-1 rounded-(--radius-control) border border-(--panel-border) bg-(--panel) p-1"
						>
							<div
								class="corner-squircle absolute top-1 bottom-1 rounded-(--radius-chip) bg-(--accent) transition-all duration-200 ease-out"
								style="left: {linkIndicator.left}px; width: {linkIndicator.width}px"
							></div>
							{#each [{ id: 'codeview' as ExternalLinkMode, label: 'Codeview', Icon: LinkIcon }, { id: 'docs' as ExternalLinkMode, label: 'docs.rs', Icon: ExternalLinkIcon }] as opt (opt.id)}
								<button
									type="button"
									class="relative z-10 inline-flex flex-1 items-center justify-center gap-1.5 rounded-(--radius-chip) px-3 py-1.5 text-xs font-medium transition-colors {extLinkMode === opt.id ? 'text-(--on-accent)' : 'text-(--muted) hover:text-(--ink)'}"
									onclick={() => onExtLinkModeChange(opt.id)}
									{@attach (el) => { linkRefs[opt.id] = el as HTMLButtonElement; return () => { linkRefs[opt.id] = null; }; }}
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

					<!-- Source provider -->
					<div class="flex flex-col gap-1">
						<span class="text-xs font-medium text-(--ink)">Source provider</span>
						<div
							class="corner-squircle relative flex items-center gap-1 rounded-(--radius-control) border border-(--panel-border) bg-(--panel) p-1"
						>
							<div
								class="corner-squircle absolute top-1 bottom-1 rounded-(--radius-chip) bg-(--accent) transition-all duration-200 ease-out"
								style="left: {sourceIndicator.left}px; width: {sourceIndicator.width}px"
							></div>
							{#each sourceProviders as prov (prov.id)}
								<button
									type="button"
									class="relative z-10 inline-flex flex-1 items-center justify-center gap-1.5 rounded-(--radius-chip) px-2 py-1.5 text-xs font-medium transition-colors {sourceProviderMode === prov.id ? 'text-(--on-accent)' : 'text-(--muted) hover:text-(--ink)'}"
									onclick={() => onSourceProviderModeChange(prov.id)}
									{@attach (el) => { sourceRefs[prov.id] = el as HTMLButtonElement; return () => { sourceRefs[prov.id] = null; }; }}
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
				<h3 class="font-display mb-3 text-[13px] font-semibold tracking-wide text-(--muted) uppercase">
					Editor
				</h3>

				<div class="flex flex-col gap-3">
					<!-- Editor selector -->
					<div class="flex flex-col gap-1">
						<span class="text-xs font-medium text-(--ink)">Open files in</span>
						<div
							class="corner-squircle relative flex flex-wrap items-center gap-1 rounded-(--radius-control) border border-(--panel-border) bg-(--panel) p-1"
						>
							<div
								class="corner-squircle absolute top-1 bottom-1 rounded-(--radius-chip) bg-(--accent) transition-all duration-200 ease-out"
								style="left: {editorIndicator.left}px; width: {editorIndicator.width}px"
							></div>
							{#each editors as ed (ed.id)}
								<button
									type="button"
									class="relative z-10 rounded-(--radius-chip) px-2.5 py-1.5 text-xs font-medium transition-colors {editor === ed.id ? 'text-(--on-accent)' : 'text-(--muted) hover:text-(--ink)'}"
									onclick={() => setEditor(ed.id)}
									{@attach (el) => { editorRefs[ed.id] = el as HTMLButtonElement; return () => { editorRefs[ed.id] = null; }; }}
								>
									{ed.label}
								</button>
							{/each}
						</div>
					</div>

					<!-- URI scheme preview / custom input -->
					<div class="flex flex-col gap-1">
						<span class="text-[10px] font-medium tracking-wider text-(--muted) uppercase">URI Scheme</span>
						{#if editor === 'custom'}
							<input
								type="text"
								value={customScheme}
								oninput={(e) => setCustomScheme(e.currentTarget.value)}
								placeholder="myeditor://open?file={'{path}'}&line={'{line}'}"
								class="corner-squircle w-full rounded-(--radius-chip) border border-(--panel-border) bg-(--panel) px-3 py-2 font-mono text-[11px] text-(--ink) placeholder:text-(--muted) focus:border-(--accent) focus:outline-none focus:ring-1 focus:ring-(--accent)"
							/>
						{:else}
							<div
								class="corner-squircle rounded-(--radius-chip) border border-(--panel-border) bg-(--code-bg) px-3 py-2 font-mono text-[11px] text-(--code-ink)"
							>
								{activeEditorScheme}
							</div>
						{/if}
						<span class="text-[10px] text-(--muted)">
							<code class="text-(--accent)">{'{path}'}</code> and <code class="text-(--accent)">{'{line}'}</code> are replaced with the file path and line number
						</span>
					</div>
				</div>
			</section>

			<!-- ════════════════════════════════════════════
			     VERSION CONTROL
			     ════════════════════════════════════════════ -->
			<section class="corner-squircle rounded-(--radius-card) bg-(--panel-solid) p-4">
				<h3 class="font-display mb-3 text-[13px] font-semibold tracking-wide text-(--muted) uppercase">
					Version Control
				</h3>

				<div class="flex flex-col gap-1">
					<span class="text-xs font-medium text-(--ink)">Clone command</span>
					<div
						class="corner-squircle relative flex items-center gap-1 rounded-(--radius-control) border border-(--panel-border) bg-(--panel) p-1"
					>
						<div
							class="corner-squircle absolute top-1 bottom-1 rounded-(--radius-chip) bg-(--accent) transition-all duration-200 ease-out"
							style="left: {vcsIndicator.left}px; width: {vcsIndicator.width}px"
						></div>
						{#each vcsOptions as opt (opt.id)}
							<button
								type="button"
								class="relative z-10 inline-flex flex-1 items-center justify-center gap-1.5 rounded-(--radius-chip) px-3 py-1.5 text-xs font-medium transition-colors {vcsMode === opt.id ? 'text-(--on-accent)' : 'text-(--muted) hover:text-(--ink)'}"
								onclick={() => onVcsModeChange(opt.id)}
								{@attach (el) => { vcsRefs[opt.id] = el as HTMLButtonElement; return () => { vcsRefs[opt.id] = null; }; }}
							>
								<opt.Icon size={13} class="transition-transform duration-200 {vcsMode === opt.id ? 'scale-110' : ''}" />
								{opt.label}
							</button>
						{/each}
					</div>
					<span class="mt-0.5 text-[10px] text-(--muted)">
						Used when cloning repositories
					</span>
				</div>
			</section>
		</div>
	</Sheet.Content>
</Sheet.Root>

<style>
	/* Custom range input matching the codeview aesthetic */
	.settings-range {
		-webkit-appearance: none;
		appearance: none;
		height: 6px;
		border-radius: 3px;
		background: var(--panel-border);
		outline: none;
		cursor: pointer;
	}

	.settings-range::-webkit-slider-thumb {
		-webkit-appearance: none;
		appearance: none;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: var(--accent);
		border: 3px solid var(--panel-solid);
		box-shadow: var(--shadow-toggle);
		cursor: pointer;
		transition: transform 0.15s ease;
	}

	.settings-range::-webkit-slider-thumb:hover {
		transform: scale(1.15);
	}

	.settings-range::-webkit-slider-thumb:active {
		transform: scale(0.95);
	}

	.settings-range::-moz-range-thumb {
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: var(--accent);
		border: 3px solid var(--panel-solid);
		box-shadow: var(--shadow-toggle);
		cursor: pointer;
	}

	.settings-range::-moz-range-track {
		height: 6px;
		border-radius: 3px;
		background: var(--panel-border);
	}
</style>
