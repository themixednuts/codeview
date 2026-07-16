<script lang="ts">
	import { browser } from '$app/environment';
	import { untrack } from 'svelte';
	import { Button } from '$lib/shadcn/ui/button';
	import * as Field from '$lib/shadcn/ui/field';
	import { Input } from '$lib/shadcn/ui/input';
	import * as NativeSelect from '$lib/shadcn/ui/native-select';
	import { Separator } from '$lib/shadcn/ui/separator';
	import * as Sheet from '$lib/shadcn/ui/sheet';
	import { Switch } from '$lib/shadcn/ui/switch';
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
	const themes: Array<{ value: Theme; label: string }> = [
		{ value: 'system', label: 'System' },
		{ value: 'light', label: 'Light' },
		{ value: 'dark', label: 'Dark' },
	];
	const accents: Array<{ value: AccentMode; label: string }> = [
		{ value: 'orange', label: 'Orange' },
		{ value: 'cobalt', label: 'Cobalt' },
		{ value: 'forest', label: 'Forest' },
		{ value: 'plum', label: 'Plum' },
		{ value: 'char', label: 'Charcoal' },
	];
	const densities: Array<{ value: DensityMode; label: string }> = [
		{ value: 'compact', label: 'Compact' },
		{ value: 'comfortable', label: 'Comfortable' },
		{ value: 'spacious', label: 'Spacious' },
	];
	const voices: Array<{ value: VoiceMode; label: string }> = [
		{ value: 'editorial', label: 'Editorial' },
		{ value: 'technical', label: 'Technical' },
		{ value: 'geometric', label: 'Geometric' },
	];
	const docLayouts: Array<{ value: DocLayoutMode; label: string }> = [
		{ value: 'classic', label: 'Classic' },
		{ value: 'reading', label: 'Reading' },
		{ value: 'split', label: 'Split' },
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
	let loadedForOpen = false;

	const activeEditorScheme = $derived(
		editor === 'custom'
			? customScheme || 'scheme://file/{path}:{line}'
			: (editors.find((item) => item.id === editor)?.scheme ?? ''),
	);

	function selectedValue<T extends string>(event: Event, update: (value: T) => void) {
		update((event.currentTarget as HTMLSelectElement).value as T);
	}

	function loadSettings() {
		if (!browser) return;
		editor = readStoredPref(EDITOR_KEY, EDITOR_VALUES, 'vscode');
		customScheme = readClientPref(CUSTOM_EDITOR_KEY, '');
		ligatures = localStorage.getItem(LIGATURES_KEY) === 'true';
		applyLigatures(ligatures);
	}

	function setEditor(value: EditorId) {
		editor = value;
		if (browser) writePref(EDITOR_KEY, value);
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
		if (browser)
			document.documentElement.style.setProperty('--font-ligatures', value ? 'normal' : 'none');
	}

	$effect(() => onEditorSchemeChange?.(activeEditorScheme));
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

<Sheet.Root bind:open onOpenChange={(value) => onOpenChange?.(value)}>
	<Sheet.Content side="right" class="w-full overflow-y-auto sm:max-w-md">
		<Sheet.Header>
			<Sheet.Title>Settings</Sheet.Title>
			<Sheet.Description>Appearance, documentation, and local source tools.</Sheet.Description>
		</Sheet.Header>

		<div class="space-y-6 px-4 pb-6">
			<section aria-labelledby="appearance-settings">
				<h2 id="appearance-settings" class="mb-3 text-sm font-semibold text-(--ink)">Appearance</h2>
				<Field.Group class="grid gap-4 sm:grid-cols-2">
					<Field.Field>
						<Field.Label for="settings-theme">Theme</Field.Label>
						<NativeSelect.Root
							id="settings-theme"
							value={theme}
							class="w-full"
							onchange={(event) => selectedValue<Theme>(event, onThemeChange)}
						>
							{#each themes as option (option.value)}
								<NativeSelect.Option value={option.value}>{option.label}</NativeSelect.Option>
							{/each}
						</NativeSelect.Root>
					</Field.Field>
					<Field.Field>
						<Field.Label for="settings-accent">Accent</Field.Label>
						<NativeSelect.Root
							id="settings-accent"
							value={accentMode}
							class="w-full"
							onchange={(event) => selectedValue<AccentMode>(event, onAccentChange)}
						>
							{#each accents as option (option.value)}
								<NativeSelect.Option value={option.value}>{option.label}</NativeSelect.Option>
							{/each}
						</NativeSelect.Root>
					</Field.Field>
					<Field.Field>
						<Field.Label for="settings-density">Density</Field.Label>
						<NativeSelect.Root
							id="settings-density"
							value={densityMode}
							class="w-full"
							onchange={(event) => selectedValue<DensityMode>(event, onDensityChange)}
						>
							{#each densities as option (option.value)}
								<NativeSelect.Option value={option.value}>{option.label}</NativeSelect.Option>
							{/each}
						</NativeSelect.Root>
					</Field.Field>
					<Field.Field>
						<Field.Label for="settings-type">Typography</Field.Label>
						<NativeSelect.Root
							id="settings-type"
							value={voiceMode}
							class="w-full"
							onchange={(event) => selectedValue<VoiceMode>(event, onVoiceChange)}
						>
							{#each voices as option (option.value)}
								<NativeSelect.Option value={option.value}>{option.label}</NativeSelect.Option>
							{/each}
						</NativeSelect.Root>
					</Field.Field>
				</Field.Group>
			</section>

			<Separator />

			<section aria-labelledby="docs-settings">
				<h2 id="docs-settings" class="mb-3 text-sm font-semibold text-(--ink)">Documentation</h2>
				<Field.Group class="grid gap-4 sm:grid-cols-2">
					<Field.Field>
						<Field.Label for="settings-layout">Layout</Field.Label>
						<NativeSelect.Root
							id="settings-layout"
							value={docLayout}
							class="w-full"
							onchange={(event) => selectedValue<DocLayoutMode>(event, onDocLayoutChange)}
						>
							{#each docLayouts as option (option.value)}
								<NativeSelect.Option value={option.value}>{option.label}</NativeSelect.Option>
							{/each}
						</NativeSelect.Root>
					</Field.Field>
					<Field.Field>
						<Field.Label for="settings-links">External documentation</Field.Label>
						<NativeSelect.Root
							id="settings-links"
							value={extLinkMode}
							class="w-full"
							onchange={(event) => selectedValue<ExternalLinkMode>(event, onExtLinkModeChange)}
						>
							<NativeSelect.Option value="codeview">Codeview</NativeSelect.Option>
							<NativeSelect.Option value="docs">docs.rs</NativeSelect.Option>
						</NativeSelect.Root>
					</Field.Field>
					<Field.Field>
						<Field.Label for="settings-code-light">Light code theme</Field.Label>
						<NativeSelect.Root
							id="settings-code-light"
							value={codeThemeLight}
							class="w-full"
							onchange={(event) => selectedValue<CodeTheme>(event, onCodeThemeLightChange)}
						>
							{#each lightCodeThemes as option (option.value)}
								<NativeSelect.Option value={option.value}>{option.label}</NativeSelect.Option>
							{/each}
						</NativeSelect.Root>
					</Field.Field>
					<Field.Field>
						<Field.Label for="settings-code-dark">Dark code theme</Field.Label>
						<NativeSelect.Root
							id="settings-code-dark"
							value={codeThemeDark}
							class="w-full"
							onchange={(event) => selectedValue<CodeTheme>(event, onCodeThemeDarkChange)}
						>
							{#each darkCodeThemes as option (option.value)}
								<NativeSelect.Option value={option.value}>{option.label}</NativeSelect.Option>
							{/each}
						</NativeSelect.Root>
					</Field.Field>
				</Field.Group>
				<div
					class="mt-4 flex items-center justify-between gap-4 rounded-lg border border-(--panel-border) p-3"
				>
					<div>
						<p class="text-sm font-medium text-(--ink)">Code ligatures</p>
						<p class="text-xs text-(--muted)">Combine supported operator glyphs.</p>
					</div>
					<Switch
						checked={ligatures}
						onCheckedChange={setLigatures}
						aria-label="Toggle code ligatures"
					/>
				</div>
			</section>

			<Separator />

			<section aria-labelledby="source-settings">
				<h2 id="source-settings" class="mb-3 text-sm font-semibold text-(--ink)">Source tools</h2>
				<Field.Group class="grid gap-4 sm:grid-cols-2">
					<Field.Field>
						<Field.Label for="settings-host">Source host</Field.Label>
						<NativeSelect.Root
							id="settings-host"
							value={sourceProviderMode}
							class="w-full"
							onchange={(event) =>
								selectedValue<SourceProviderMode>(event, onSourceProviderModeChange)}
						>
							<NativeSelect.Option value="auto">Automatic</NativeSelect.Option>
							<NativeSelect.Option value="crates-io">crates.io</NativeSelect.Option>
							<NativeSelect.Option value="github">GitHub</NativeSelect.Option>
						</NativeSelect.Root>
					</Field.Field>
					<Field.Field>
						<Field.Label for="settings-vcs">Version control</Field.Label>
						<NativeSelect.Root
							id="settings-vcs"
							value={vcsMode}
							class="w-full"
							onchange={(event) => selectedValue<VcsMode>(event, onVcsModeChange)}
						>
							<NativeSelect.Option value="git">Git</NativeSelect.Option>
							<NativeSelect.Option value="jj">Jujutsu</NativeSelect.Option>
						</NativeSelect.Root>
					</Field.Field>
					<Field.Field>
						<Field.Label for="settings-editor">Editor</Field.Label>
						<NativeSelect.Root
							id="settings-editor"
							value={editor}
							class="w-full"
							onchange={(event) => selectedValue<EditorId>(event, setEditor)}
						>
							{#each editors as option (option.id)}
								<NativeSelect.Option value={option.id}>{option.label}</NativeSelect.Option>
							{/each}
						</NativeSelect.Root>
					</Field.Field>
					<Field.Field>
						<Field.Label for="settings-source-root">Local source root</Field.Label>
						<Input
							id="settings-source-root"
							value={sourceRoot}
							placeholder="C:\\src\\project"
							oninput={(event) => onSourceRootChange?.(event.currentTarget.value)}
						/>
					</Field.Field>
				</Field.Group>
				{#if editor === 'custom'}
					<Field.Field class="mt-4">
						<Field.Label for="settings-custom-editor">Editor URL template</Field.Label>
						<Input
							id="settings-custom-editor"
							value={customScheme}
							placeholder={'scheme://file/{path}:{line}'}
							oninput={(event) => setCustomScheme(event.currentTarget.value)}
						/>
						<Field.Description>Use {'{path}'} and {'{line}'} placeholders.</Field.Description>
					</Field.Field>
				{/if}
			</section>
		</div>

		<Sheet.Footer class="border-t border-(--panel-border) px-4 py-3">
			<Button type="button" variant="outline" onclick={() => (open = false)}>Done</Button>
		</Sheet.Footer>
	</Sheet.Content>
</Sheet.Root>
