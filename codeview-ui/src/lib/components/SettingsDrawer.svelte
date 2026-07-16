<script lang="ts">
	import { browser } from '$app/environment';
	import { onMount } from 'svelte';
	import { Input } from '$lib/shadcn/ui/input';
	import * as NativeSelect from '$lib/shadcn/ui/native-select';
	import * as RadioGroup from '$lib/shadcn/ui/radio-group';
	import * as Sheet from '$lib/shadcn/ui/sheet';
	import { Switch } from '$lib/shadcn/ui/switch';
	import SettingsRadioOption from './SettingsRadioOption.svelte';
	import BookOpenIcon from '@lucide/svelte/icons/book-open';
	import Columns2Icon from '@lucide/svelte/icons/columns-2';
	import DatabaseIcon from '@lucide/svelte/icons/database';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import GitBranchIcon from '@lucide/svelte/icons/git-branch';
	import GitForkIcon from '@lucide/svelte/icons/git-fork';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import LinkIcon from '@lucide/svelte/icons/link';
	import MonitorIcon from '@lucide/svelte/icons/monitor';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import PanelRightIcon from '@lucide/svelte/icons/panel-right';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import SunIcon from '@lucide/svelte/icons/sun';
	import ZapIcon from '@lucide/svelte/icons/zap';
	import {
		CUSTOM_EDITOR_KEY,
		EDITOR_KEY,
		EDITOR_VALUES,
		readClientPref,
		readStoredPref,
		type EditorId,
		writePref,
	} from '$lib/preferences';
	import type {
		AccentMode,
		CodeTheme,
		DensityMode,
		DocLayoutMode,
		ExternalLinkMode,
		SourceProviderMode,
		Theme,
		VcsMode,
		VoiceMode,
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
		sourceRoot: string;
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
		onSourceRootChange?: (root: string) => void;
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
		sourceRoot,
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
		onSourceRootChange,
		onOpenChange,
	}: Props = $props();

	const LIGATURES_KEY = 'codeview-ligatures';
	const editors: { id: EditorId; label: string; scheme: string }[] = [
		{ id: 'vscode', label: 'VS Code', scheme: 'vscode://file/{path}:{line}' },
		{ id: 'cursor', label: 'Cursor', scheme: 'cursor://file/{path}:{line}' },
		{ id: 'zed', label: 'Zed', scheme: 'zed://file/{path}:{line}' },
		{ id: 'neovim', label: 'Neovim', scheme: 'nvim://open?file={path}&line={line}' },
		{ id: 'custom', label: 'Custom', scheme: '' },
	];
	const themeOptions: Array<{ id: Theme; label: string; Icon: typeof SunIcon }> = [
		{ id: 'light', label: 'Light', Icon: SunIcon },
		{ id: 'dark', label: 'Dark', Icon: MoonIcon },
		{ id: 'system', label: 'System', Icon: MonitorIcon },
	];
	const accentOptions: Array<{
		id: AccentMode;
		label: string;
		swatch: [string, string, string];
	}> = [
		{ id: 'orange', label: 'Orange', swatch: ['#cb4b16', '#fdf6e3', '#586e75'] },
		{ id: 'cobalt', label: 'Cobalt', swatch: ['#1f6fa5', '#fdf6e3', '#586e75'] },
		{ id: 'forest', label: 'Forest', swatch: ['#4f7d2f', '#fdf6e3', '#586e75'] },
		{ id: 'plum', label: 'Plum', swatch: ['#8c3a76', '#fdf6e3', '#586e75'] },
		{ id: 'char', label: 'Charcoal', swatch: ['#2b323a', '#fdf6e3', '#586e75'] },
	];
	const densityOptions: Array<{ id: DensityMode; label: string; hint: string }> = [
		{ id: 'compact', label: 'Compact', hint: '13px' },
		{ id: 'comfortable', label: 'Comfort', hint: '14px' },
		{ id: 'spacious', label: 'Spacious', hint: '15px' },
	];
	const voiceOptions: Array<{ id: VoiceMode; label: string; hint: string }> = [
		{ id: 'editorial', label: 'Editorial', hint: 'Fraunces / Inter' },
		{ id: 'technical', label: 'Technical', hint: 'IBM Plex Sans' },
		{ id: 'geometric', label: 'Geometric', hint: 'Space Grotesk' },
	];
	const docLayoutOptions: Array<{
		id: DocLayoutMode;
		label: string;
		hint: string;
		Icon: typeof BookOpenIcon;
	}> = [
		{ id: 'classic', label: 'Classic', hint: 'Docs + TOC', Icon: PanelRightIcon },
		{ id: 'reading', label: 'Reading', hint: 'Single column', Icon: BookOpenIcon },
		{ id: 'split', label: 'Split', hint: 'Docs + source', Icon: Columns2Icon },
	];
	const linkOptions: Array<{
		id: ExternalLinkMode;
		label: string;
		Icon: typeof LinkIcon;
	}> = [
		{ id: 'codeview', label: 'Codeview', Icon: LinkIcon },
		{ id: 'docs', label: 'docs.rs', Icon: ExternalLinkIcon },
	];
	const sourceProviders: Array<{ id: SourceProviderMode; label: string }> = [
		{ id: 'auto', label: 'Auto' },
		{ id: 'crates-io', label: 'crates.io' },
		{ id: 'github', label: 'GitHub' },
	];
	const vcsOptions: Array<{ id: VcsMode; label: string; Icon: typeof GitBranchIcon }> = [
		{ id: 'git', label: 'git', Icon: GitBranchIcon },
		{ id: 'jj', label: 'jj', Icon: GitForkIcon },
	];
	const lightCodeThemes: Array<{ value: CodeTheme; label: string }> = [
		{ value: 'solarized-light', label: 'Solarized Light' },
		{ value: 'catppuccin-latte', label: 'Catppuccin Latte' },
		{ value: 'one-light', label: 'One Light' },
		{ value: 'github-light', label: 'GitHub Light' },
	];
	const darkCodeThemes: Array<{ value: CodeTheme; label: string }> = [
		{ value: 'solarized-dark', label: 'Solarized Dark' },
		{ value: 'catppuccin-mocha', label: 'Catppuccin Mocha' },
		{ value: 'one-dark', label: 'One Dark' },
		{ value: 'github-dark', label: 'GitHub Dark' },
	];

	let editor = $state<EditorId>('vscode');
	let customScheme = $state('');
	let ligatures = $state(false);

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
	const linkIndex = $derived(activeIndex(linkOptions, extLinkMode));
	const sourceIndex = $derived(activeIndex(sourceProviders, sourceProviderMode));
	const editorIndex = $derived(activeIndex(editors, editor));
	const vcsIndex = $derived(activeIndex(vcsOptions, vcsMode));
	const activeEditorScheme = $derived(editorScheme());

	function selectedValue<T extends string>(event: Event, update: (value: T) => void) {
		update((event.currentTarget as HTMLSelectElement).value as T);
	}

	function selectedRadio<T extends string>(value: string, update: (value: T) => void) {
		update(value as T);
	}

	function editorScheme(value = editor): string {
		return value === 'custom'
			? customScheme || 'scheme://file/{path}:{line}'
			: (editors.find((item) => item.id === value)?.scheme ?? '');
	}

	function loadSettings() {
		if (!browser) return;
		editor = readStoredPref(EDITOR_KEY, EDITOR_VALUES, 'vscode');
		customScheme = readClientPref(CUSTOM_EDITOR_KEY, '');
		ligatures = localStorage.getItem(LIGATURES_KEY) === 'true';
		applyLigatures(ligatures);
		onEditorSchemeChange?.(editorScheme());
	}

	function setEditor(value: EditorId) {
		editor = value;
		if (browser) writePref(EDITOR_KEY, value);
		onEditorSchemeChange?.(editorScheme(value));
	}

	function setCustomScheme(value: string) {
		customScheme = value;
		if (browser) writePref(CUSTOM_EDITOR_KEY, value);
		if (editor === 'custom') onEditorSchemeChange?.(editorScheme());
	}

	function setLigatures(value: boolean) {
		ligatures = value;
		if (browser) localStorage.setItem(LIGATURES_KEY, String(value));
		applyLigatures(value);
	}

	function applyLigatures(value: boolean) {
		if (browser)
			document.documentElement.style.setProperty('--font-ligatures', value ? 'normal' : 'none');
	}

	onMount(loadSettings);
</script>

<Sheet.Root bind:open onOpenChange={(value) => onOpenChange?.(value)}>
	<Sheet.Content
		side="right"
		class="settings-sheet w-full gap-0 overflow-y-auto border-l border-(--panel-border) bg-(--bg) p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-104"
	>
		<div class="border-b border-(--panel-border-soft) px-5 pt-5 pr-12 pb-4">
			<Sheet.Header class="gap-1 p-0">
				<div class="flex items-center gap-2.5">
					<div
						class="corner-squircle flex size-7 items-center justify-center rounded-(--radius-chip) bg-(--accent)"
					>
						<SettingsIcon size={14} class="text-(--on-accent)" />
					</div>
					<Sheet.Title class="font-display text-[17px] leading-none font-semibold text-(--ink)">
						Settings
					</Sheet.Title>
				</div>
				<Sheet.Description class="text-[11px] text-(--muted)">
					Theme, type, density and integration preferences.
				</Sheet.Description>
			</Sheet.Header>
		</div>

		<div class="flex flex-col gap-1.5 px-4 pb-8">
			<section class="settings-card" aria-labelledby="settings-ui-mode">
				<h2 id="settings-ui-mode" class="settings-card-title">UI mode</h2>
				<RadioGroup.Root
					value={theme}
					orientation="horizontal"
					class="settings-segmented grid-cols-3"
					onValueChange={(value) => selectedRadio<Theme>(value, onThemeChange)}
				>
					<span
						class="settings-segmented-indicator"
						style={indicatorStyle(themeIndex, themeOptions.length)}
					></span>
					{#each themeOptions as option (option.id)}
						<SettingsRadioOption
							id={`settings-theme-${option.id}`}
							value={option.id}
							label={`Use ${option.label.toLowerCase()} theme`}
							variant="segmented"
						>
							<option.Icon size={13} />
							{option.label}
						</SettingsRadioOption>
					{/each}
				</RadioGroup.Root>
			</section>

			<section class="settings-card" aria-labelledby="settings-accent">
				<h2 id="settings-accent" class="settings-card-title">Accent</h2>
				<RadioGroup.Root
					value={accentMode}
					orientation="horizontal"
					class="grid grid-cols-5 gap-1.5"
					onValueChange={(value) => selectedRadio<AccentMode>(value, onAccentChange)}
				>
					{#each accentOptions as option (option.id)}
						<SettingsRadioOption
							id={`settings-accent-${option.id}`}
							value={option.id}
							label={`${option.label} accent`}
							variant="swatch"
							class="h-10"
							style={`background: linear-gradient(90deg, ${option.swatch[0]} 0%, ${option.swatch[0]} 60%, ${option.swatch[1]} 60%, ${option.swatch[1]} 80%, ${option.swatch[2]} 80%, ${option.swatch[2]} 100%)`}
						>
							<span class="sr-only">{option.label}</span>
						</SettingsRadioOption>
					{/each}
				</RadioGroup.Root>
				<p class="mt-2 text-[10.5px] text-(--muted)">
					{accentOptions.find((option) => option.id === accentMode)?.label}: accent, paper, ink
				</p>
			</section>

			<section class="settings-card" aria-labelledby="settings-density">
				<h2 id="settings-density" class="settings-card-title">Density</h2>
				<RadioGroup.Root
					value={densityMode}
					orientation="horizontal"
					class="settings-segmented grid-cols-3"
					onValueChange={(value) => selectedRadio<DensityMode>(value, onDensityChange)}
				>
					<span
						class="settings-segmented-indicator"
						style={indicatorStyle(densityIndex, densityOptions.length)}
					></span>
					{#each densityOptions as option (option.id)}
						<SettingsRadioOption
							id={`settings-density-${option.id}`}
							value={option.id}
							label={option.label}
							variant="segmented"
							class="h-10"
							contentClass="flex-col gap-0.5"
						>
							<span>{option.label}</span>
							<span class="font-mono text-[9px] opacity-70">{option.hint}</span>
						</SettingsRadioOption>
					{/each}
				</RadioGroup.Root>
			</section>

			<section class="settings-card" aria-labelledby="settings-voice">
				<h2 id="settings-voice" class="settings-card-title">Voice</h2>
				<RadioGroup.Root
					value={voiceMode}
					orientation="horizontal"
					class="settings-segmented grid-cols-3"
					onValueChange={(value) => selectedRadio<VoiceMode>(value, onVoiceChange)}
				>
					<span
						class="settings-segmented-indicator"
						style={indicatorStyle(voiceIndex, voiceOptions.length)}
					></span>
					{#each voiceOptions as option (option.id)}
						<SettingsRadioOption
							id={`settings-voice-${option.id}`}
							value={option.id}
							label={option.label}
							variant="segmented"
							class="h-10"
							contentClass="flex-col gap-0.5"
						>
							<span>{option.label}</span>
							<span class="max-w-full truncate font-mono text-[8.5px] opacity-70">
								{option.hint}
							</span>
						</SettingsRadioOption>
					{/each}
				</RadioGroup.Root>
				<div
					class="corner-squircle mt-2 rounded-(--radius-chip) border border-(--panel-border-soft) bg-(--panel) px-3 py-2"
				>
					<div class="font-display text-[15px] font-semibold text-(--ink)">
						Type that fits the page
					</div>
					<div class="text-[11px] text-(--muted)">A quick brown fox jumps over the lazy dog.</div>
				</div>
			</section>

			<section class="settings-card" aria-labelledby="settings-doc-layout">
				<h2 id="settings-doc-layout" class="settings-card-title">Doc layout</h2>
				<RadioGroup.Root
					value={docLayout}
					orientation="horizontal"
					class="settings-segmented grid-cols-3"
					onValueChange={(value) => selectedRadio<DocLayoutMode>(value, onDocLayoutChange)}
				>
					<span
						class="settings-segmented-indicator"
						style={indicatorStyle(docLayoutIndex, docLayoutOptions.length)}
					></span>
					{#each docLayoutOptions as option (option.id)}
						<SettingsRadioOption
							id={`settings-layout-${option.id}`}
							value={option.id}
							label={`${option.label} layout`}
							variant="segmented"
							class="h-12"
							contentClass="flex-col gap-0.5"
						>
							<span class="inline-flex items-center gap-1.5">
								<option.Icon size={13} />{option.label}
							</span>
							<span class="font-mono text-[8.5px] opacity-70">{option.hint}</span>
						</SettingsRadioOption>
					{/each}
				</RadioGroup.Root>
				<p class="mt-1.5 text-[10px] text-(--muted)">
					Layouts change the full documentation route composition.
				</p>
			</section>

			<section class="settings-card" aria-labelledby="settings-code-theme">
				<h2 id="settings-code-theme" class="settings-card-title">Code theme</h2>
				<div class="flex flex-col gap-3">
					<div class="flex flex-col gap-1.5">
						<label for="settings-code-light" class="text-xs font-medium text-(--ink)">
							Light mode
						</label>
						<NativeSelect.Root
							id="settings-code-light"
							value={codeThemeLight}
							class="w-full bg-(--panel) text-xs"
							onchange={(event) => selectedValue<CodeTheme>(event, onCodeThemeLightChange)}
						>
							{#each lightCodeThemes as option (option.value)}
								<NativeSelect.Option value={option.value}>{option.label}</NativeSelect.Option>
							{/each}
						</NativeSelect.Root>
						<div
							data-code-theme={codeThemeLight}
							class="codeblock corner-squircle overflow-hidden rounded-(--radius-chip) font-mono text-[11px] leading-[1.65]"
						>
							<pre class="m-0 px-3 py-2"><span class="tok-kw">pub fn</span> <span
									class="tok-fn">greet</span>(<span class="tok-id">name</span>: <span
									class="tok-ty">&amp;str</span>) -&gt; <span class="tok-ty">String</span> <span
									class="tok-mu">&#123;</span>
    <span class="tok-fn">format!</span>(<span class="tok-str">"hi, &#123;name&#125;"</span>)
<span class="tok-mu">&#125;</span></pre>
						</div>
					</div>

					<div class="flex flex-col gap-1.5">
						<label for="settings-code-dark" class="text-xs font-medium text-(--ink)">
							Dark mode
						</label>
						<NativeSelect.Root
							id="settings-code-dark"
							value={codeThemeDark}
							class="w-full bg-(--panel) text-xs"
							onchange={(event) => selectedValue<CodeTheme>(event, onCodeThemeDarkChange)}
						>
							{#each darkCodeThemes as option (option.value)}
								<NativeSelect.Option value={option.value}>{option.label}</NativeSelect.Option>
							{/each}
						</NativeSelect.Root>
						<div
							data-code-theme={codeThemeDark}
							class="codeblock corner-squircle overflow-hidden rounded-(--radius-chip) font-mono text-[11px] leading-[1.65]"
						>
							<pre class="m-0 px-3 py-2"><span class="tok-kw">pub fn</span> <span
									class="tok-fn">greet</span>(<span class="tok-id">name</span>: <span
									class="tok-ty">&amp;str</span>) -&gt; <span class="tok-ty">String</span> <span
									class="tok-mu">&#123;</span>
    <span class="tok-fn">format!</span>(<span class="tok-str">"hi, &#123;name&#125;"</span>)
<span class="tok-mu">&#125;</span></pre>
						</div>
					</div>

					<div class="flex items-center justify-between border-t border-(--panel-border-soft) pt-3">
						<div>
							<label for="settings-ligatures" class="text-xs font-medium text-(--ink)">
								Ligatures
							</label>
							<p class="text-[10px] text-(--muted)">Combine glyphs like =&gt; -&gt; !=</p>
						</div>
						<Switch
							id="settings-ligatures"
							checked={ligatures}
							onCheckedChange={setLigatures}
							aria-label="Toggle ligatures"
						/>
					</div>
				</div>
			</section>

			<section class="settings-card" aria-labelledby="settings-external-links">
				<h2 id="settings-external-links" class="settings-card-title">External links</h2>
				<div class="flex flex-col gap-4">
					<div>
						<p class="mb-1 text-xs font-medium text-(--ink)">Doc links open in</p>
						<RadioGroup.Root
							value={extLinkMode}
							orientation="horizontal"
							class="settings-segmented grid-cols-2"
							onValueChange={(value) => selectedRadio<ExternalLinkMode>(value, onExtLinkModeChange)}
						>
							<span
								class="settings-segmented-indicator"
								style={indicatorStyle(linkIndex, linkOptions.length)}
							></span>
							{#each linkOptions as option (option.id)}
								<SettingsRadioOption
									id={`settings-links-${option.id}`}
									value={option.id}
									label={option.label}
									variant="segmented"
								>
									<option.Icon size={13} />{option.label}
								</SettingsRadioOption>
							{/each}
						</RadioGroup.Root>
						<p class="mt-1.5 text-[10px] text-(--muted)">
							{extLinkMode === 'docs'
								? 'External crate links open on docs.rs.'
								: 'External crate links stay within Codeview.'}
						</p>
					</div>

					<div>
						<p class="mb-1 text-xs font-medium text-(--ink)">Source links</p>
						<RadioGroup.Root
							value={sourceProviderMode}
							orientation="horizontal"
							class="settings-segmented grid-cols-3"
							onValueChange={(value) =>
								selectedRadio<SourceProviderMode>(value, onSourceProviderModeChange)}
						>
							<span
								class="settings-segmented-indicator"
								style={indicatorStyle(sourceIndex, sourceProviders.length)}
							></span>
							{#each sourceProviders as option (option.id)}
								<SettingsRadioOption
									id={`settings-source-${option.id}`}
									value={option.id}
									label={option.label}
									variant="segmented"
								>
									{#if option.id === 'github'}
										<GlobeIcon size={12} />
									{:else if option.id === 'crates-io'}
										<DatabaseIcon size={12} />
									{:else}
										<ZapIcon size={12} />
									{/if}
									{option.label}
								</SettingsRadioOption>
							{/each}
						</RadioGroup.Root>
					</div>
				</div>
			</section>

			<section class="settings-card" aria-labelledby="settings-editor">
				<h2 id="settings-editor" class="settings-card-title">Editor</h2>
				<div class="flex flex-col gap-3">
					<div>
						<p class="mb-1 text-xs font-medium text-(--ink)">Open files in</p>
						<RadioGroup.Root
							value={editor}
							orientation="horizontal"
							class="settings-segmented grid-cols-5"
							onValueChange={(value) => selectedRadio<EditorId>(value, setEditor)}
						>
							<span
								class="settings-segmented-indicator"
								style={indicatorStyle(editorIndex, editors.length)}
							></span>
							{#each editors as option (option.id)}
								<SettingsRadioOption
									id={`settings-editor-${option.id}`}
									value={option.id}
									label={option.label}
									variant="segmented"
									contentClass="text-[10.5px]"
								>
									{option.label}
								</SettingsRadioOption>
							{/each}
						</RadioGroup.Root>
					</div>

					<div>
						<label for="settings-custom-editor" class="settings-field-label">URI scheme</label>
						{#if editor === 'custom'}
							<Input
								id="settings-custom-editor"
								value={customScheme}
								placeholder={'scheme://file/{path}:{line}'}
								class="bg-(--panel) font-mono text-[11px]"
								oninput={(event) => setCustomScheme(event.currentTarget.value)}
							/>
						{:else}
							<div
								class="corner-squircle rounded-(--radius-chip) border border-(--panel-border) bg-(--code-bg) px-3 py-2 font-mono text-[11px] text-(--code-ink)"
							>
								{activeEditorScheme}
							</div>
						{/if}
						<p class="mt-1 text-[10px] text-(--muted)">
							<code class="text-(--accent)">{'{path}'}</code>
							and
							<code class="text-(--accent)">{'{line}'}</code>
							are replaced with the file path and line number.
						</p>
					</div>

					<div>
						<label for="settings-source-root" class="settings-field-label">Local source root</label>
						<Input
							id="settings-source-root"
							value={sourceRoot}
							placeholder="C:\\src\\project"
							class="bg-(--panel) font-mono text-[11px]"
							oninput={(event) => onSourceRootChange?.(event.currentTarget.value)}
						/>
						<p class="mt-1 text-[10px] text-(--muted)">
							Used by hosted editor links for repository source paths.
						</p>
					</div>
				</div>
			</section>

			<section class="settings-card" aria-labelledby="settings-version-control">
				<h2 id="settings-version-control" class="settings-card-title">Version control</h2>
				<p class="mb-1 text-xs font-medium text-(--ink)">Clone command</p>
				<RadioGroup.Root
					value={vcsMode}
					orientation="horizontal"
					class="settings-segmented grid-cols-2"
					onValueChange={(value) => selectedRadio<VcsMode>(value, onVcsModeChange)}
				>
					<span
						class="settings-segmented-indicator"
						style={indicatorStyle(vcsIndex, vcsOptions.length)}
					></span>
					{#each vcsOptions as option (option.id)}
						<SettingsRadioOption
							id={`settings-vcs-${option.id}`}
							value={option.id}
							label={option.label}
							variant="segmented"
						>
							<option.Icon size={13} />{option.label}
						</SettingsRadioOption>
					{/each}
				</RadioGroup.Root>
				<p class="mt-1.5 text-[10px] text-(--muted)">Used when cloning repositories.</p>
			</section>
		</div>
	</Sheet.Content>
</Sheet.Root>

<style>
	.settings-card {
		border-radius: var(--radius-card);
		background: var(--panel-solid);
		padding: 1rem;
	}

	.settings-card-title {
		margin-bottom: 0.75rem;
		font-family: var(--font-display);
		font-size: 13px;
		font-weight: 600;
		letter-spacing: 0;
		text-transform: uppercase;
		color: var(--muted);
	}

	:global(.settings-segmented) {
		position: relative;
		display: grid;
		align-items: stretch;
		border: 1px solid var(--panel-border);
		border-radius: var(--radius-control);
		background: var(--panel);
		padding: 0.25rem;
	}

	.settings-segmented-indicator {
		position: absolute;
		top: 0.25rem;
		bottom: 0.25rem;
		border-radius: var(--radius-chip);
		background: var(--accent);
		transition:
			left 180ms ease-out,
			width 180ms ease-out;
	}

	.settings-field-label {
		display: block;
		margin-bottom: 0.25rem;
		font-size: 10px;
		font-weight: 500;
		text-transform: uppercase;
		color: var(--muted);
	}

	:global(.settings-sheet button[data-bits-dialog-close]) {
		top: 14px;
		right: 14px;
		padding: 6px;
		border: 1px solid var(--panel-border);
		border-radius: 6px;
		background: var(--panel-strong);
		color: var(--muted);
	}

	:global(.settings-sheet button[data-bits-dialog-close]:hover) {
		border-color: var(--accent-ring);
		background: var(--accent-soft);
		color: var(--accent);
	}
</style>
