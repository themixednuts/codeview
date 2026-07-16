<script lang="ts">
	import { browser } from '$app/environment';
	import { onMount } from 'svelte';
	import { Button } from '$lib/shadcn/ui/button';
	import * as Field from '$lib/shadcn/ui/field';
	import { Input } from '$lib/shadcn/ui/input';
	import * as NativeSelect from '$lib/shadcn/ui/native-select';
	import * as RadioGroup from '$lib/shadcn/ui/radio-group';
	import { Separator } from '$lib/shadcn/ui/separator';
	import * as Sheet from '$lib/shadcn/ui/sheet';
	import { Switch } from '$lib/shadcn/ui/switch';
	import SettingsRadioOption from './SettingsRadioOption.svelte';
	import BookOpenIcon from '@lucide/svelte/icons/book-open';
	import Columns2Icon from '@lucide/svelte/icons/columns-2';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import GitBranchIcon from '@lucide/svelte/icons/git-branch';
	import GitForkIcon from '@lucide/svelte/icons/git-fork';
	import LinkIcon from '@lucide/svelte/icons/link';
	import MonitorIcon from '@lucide/svelte/icons/monitor';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import PanelRightIcon from '@lucide/svelte/icons/panel-right';
	import SunIcon from '@lucide/svelte/icons/sun';
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
	const accents: Array<{ value: AccentMode; label: string; color: string }> = [
		{ value: 'orange', label: 'Orange', color: '#cb4b16' },
		{ value: 'cobalt', label: 'Cobalt', color: '#1f6fa5' },
		{ value: 'forest', label: 'Forest', color: '#4f7d2f' },
		{ value: 'plum', label: 'Plum', color: '#8c3a76' },
		{ value: 'char', label: 'Charcoal', color: '#2b323a' },
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
		class="w-full gap-0 overflow-hidden data-[side=right]:w-full data-[side=right]:sm:max-w-md"
	>
		<Sheet.Header class="border-b border-(--panel-border) px-5 py-4">
			<Sheet.Title>Settings</Sheet.Title>
			<Sheet.Description>Appearance, documentation, and source tools.</Sheet.Description>
		</Sheet.Header>

		<div class="min-h-0 flex-1 space-y-6 overflow-y-auto p-5">
			<section aria-labelledby="appearance-settings">
				<h2
					id="appearance-settings"
					class="mb-4 text-[10px] font-semibold tracking-[0.18em] text-(--muted-soft) uppercase"
				>
					Appearance
				</h2>
				<Field.Group class="gap-5">
					<Field.Field>
						<Field.Label>Theme</Field.Label>
						<RadioGroup.Root
							value={theme}
							orientation="horizontal"
							class="grid w-full grid-cols-3"
							onValueChange={(value) => selectedRadio<Theme>(value, onThemeChange)}
						>
							<SettingsRadioOption
								id="settings-theme-system"
								value="system"
								label="Use system theme"
							>
								<MonitorIcon /> System
							</SettingsRadioOption>
							<SettingsRadioOption id="settings-theme-light" value="light" label="Use light theme">
								<SunIcon /> Light
							</SettingsRadioOption>
							<SettingsRadioOption id="settings-theme-dark" value="dark" label="Use dark theme">
								<MoonIcon /> Dark
							</SettingsRadioOption>
						</RadioGroup.Root>
					</Field.Field>

					<Field.Field>
						<Field.Label>Accent</Field.Label>
						<RadioGroup.Root
							value={accentMode}
							orientation="horizontal"
							class="grid w-full grid-cols-5"
							onValueChange={(value) => selectedRadio<AccentMode>(value, onAccentChange)}
						>
							{#each accents as option (option.value)}
								<SettingsRadioOption
									id={`settings-accent-${option.value}`}
									value={option.value}
									label={`${option.label} accent`}
									class="h-9"
								>
									<span
										class="size-2.5 shrink-0 rounded-full border border-black/10"
										style={`background-color: ${option.color}`}
									></span>
									<span class="hidden truncate text-[10px] min-[390px]:inline">{option.label}</span>
								</SettingsRadioOption>
							{/each}
						</RadioGroup.Root>
					</Field.Field>

					<Field.Field>
						<Field.Label>Density</Field.Label>
						<RadioGroup.Root
							value={densityMode}
							orientation="horizontal"
							class="grid w-full grid-cols-3"
							onValueChange={(value) => selectedRadio<DensityMode>(value, onDensityChange)}
						>
							{#each densities as option (option.value)}
								<SettingsRadioOption
									id={`settings-density-${option.value}`}
									value={option.value}
									label={option.label}
								>
									{option.label}
								</SettingsRadioOption>
							{/each}
						</RadioGroup.Root>
					</Field.Field>

					<Field.Field>
						<Field.Label>Typography</Field.Label>
						<RadioGroup.Root
							value={voiceMode}
							orientation="horizontal"
							class="grid w-full grid-cols-3"
							onValueChange={(value) => selectedRadio<VoiceMode>(value, onVoiceChange)}
						>
							{#each voices as option (option.value)}
								<SettingsRadioOption
									id={`settings-voice-${option.value}`}
									value={option.value}
									label={option.label}
								>
									{option.label}
								</SettingsRadioOption>
							{/each}
						</RadioGroup.Root>
					</Field.Field>
				</Field.Group>
			</section>

			<Separator />

			<section aria-labelledby="docs-settings">
				<h2
					id="docs-settings"
					class="mb-4 text-[10px] font-semibold tracking-[0.18em] text-(--muted-soft) uppercase"
				>
					Documentation
				</h2>
				<Field.Group class="gap-5">
					<Field.Field>
						<Field.Label>Layout</Field.Label>
						<RadioGroup.Root
							value={docLayout}
							orientation="horizontal"
							class="grid w-full grid-cols-3"
							onValueChange={(value) => selectedRadio<DocLayoutMode>(value, onDocLayoutChange)}
						>
							<SettingsRadioOption
								id="settings-layout-classic"
								value="classic"
								label="Classic layout"
							>
								<PanelRightIcon /> Classic
							</SettingsRadioOption>
							<SettingsRadioOption
								id="settings-layout-reading"
								value="reading"
								label="Reading layout"
							>
								<BookOpenIcon /> Reading
							</SettingsRadioOption>
							<SettingsRadioOption id="settings-layout-split" value="split" label="Split layout">
								<Columns2Icon /> Split
							</SettingsRadioOption>
						</RadioGroup.Root>
					</Field.Field>

					<Field.Field>
						<Field.Label>Documentation links</Field.Label>
						<RadioGroup.Root
							value={extLinkMode}
							orientation="horizontal"
							class="grid w-full grid-cols-2"
							onValueChange={(value) => selectedRadio<ExternalLinkMode>(value, onExtLinkModeChange)}
						>
							<SettingsRadioOption
								id="settings-links-codeview"
								value="codeview"
								label="Use Codeview links"
							>
								<LinkIcon /> Codeview
							</SettingsRadioOption>
							<SettingsRadioOption id="settings-links-docs" value="docs" label="Use docs.rs links">
								<ExternalLinkIcon /> docs.rs
							</SettingsRadioOption>
						</RadioGroup.Root>
					</Field.Field>

					<div class="grid gap-4 sm:grid-cols-2">
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
					</div>

					<Field.Field orientation="horizontal" class="border-t border-(--panel-border-soft) pt-4">
						<div class="min-w-0 flex-1">
							<Field.Label for="settings-ligatures">Code ligatures</Field.Label>
							<Field.Description>Combine supported operator glyphs.</Field.Description>
						</div>
						<Switch
							id="settings-ligatures"
							checked={ligatures}
							onCheckedChange={setLigatures}
							aria-label="Toggle code ligatures"
						/>
					</Field.Field>
				</Field.Group>
			</section>

			<Separator />

			<section aria-labelledby="source-settings">
				<h2
					id="source-settings"
					class="mb-4 text-[10px] font-semibold tracking-[0.18em] text-(--muted-soft) uppercase"
				>
					Source tools
				</h2>
				<Field.Group class="gap-5">
					<Field.Field>
						<Field.Label>Source host</Field.Label>
						<RadioGroup.Root
							value={sourceProviderMode}
							orientation="horizontal"
							class="grid w-full grid-cols-3"
							onValueChange={(value) =>
								selectedRadio<SourceProviderMode>(value, onSourceProviderModeChange)}
						>
							<SettingsRadioOption
								id="settings-source-auto"
								value="auto"
								label="Automatic source host"
							>
								Automatic
							</SettingsRadioOption>
							<SettingsRadioOption
								id="settings-source-crates"
								value="crates-io"
								label="crates.io source host"
							>
								crates.io
							</SettingsRadioOption>
							<SettingsRadioOption
								id="settings-source-github"
								value="github"
								label="GitHub source host"
							>
								GitHub
							</SettingsRadioOption>
						</RadioGroup.Root>
					</Field.Field>

					<Field.Field>
						<Field.Label>Version control</Field.Label>
						<RadioGroup.Root
							value={vcsMode}
							orientation="horizontal"
							class="grid w-full grid-cols-2"
							onValueChange={(value) => selectedRadio<VcsMode>(value, onVcsModeChange)}
						>
							<SettingsRadioOption id="settings-vcs-git" value="git" label="Use Git">
								<GitBranchIcon /> Git
							</SettingsRadioOption>
							<SettingsRadioOption id="settings-vcs-jj" value="jj" label="Use Jujutsu">
								<GitForkIcon /> Jujutsu
							</SettingsRadioOption>
						</RadioGroup.Root>
					</Field.Field>

					<Field.Field>
						<Field.Label>Editor</Field.Label>
						<RadioGroup.Root
							value={editor}
							orientation="horizontal"
							class="grid w-full grid-cols-3"
							onValueChange={(value) => selectedRadio<EditorId>(value, setEditor)}
						>
							{#each editors as option (option.id)}
								<SettingsRadioOption
									id={`settings-editor-${option.id}`}
									value={option.id}
									label={option.label}
								>
									{option.label}
								</SettingsRadioOption>
							{/each}
						</RadioGroup.Root>
					</Field.Field>

					<Field.Field>
						<Field.Label for="settings-source-root">Local source root</Field.Label>
						<Input
							id="settings-source-root"
							value={sourceRoot}
							placeholder="C:\\src\\project"
							oninput={(event) => onSourceRootChange?.(event.currentTarget.value)}
						/>
						<Field.Description>Absolute path used by editor deep links.</Field.Description>
					</Field.Field>

					{#if editor === 'custom'}
						<Field.Field>
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
				</Field.Group>
			</section>
		</div>

		<Sheet.Footer class="border-t border-(--panel-border) px-5 py-3">
			<Button type="button" onclick={() => (open = false)}>Done</Button>
		</Sheet.Footer>
	</Sheet.Content>
</Sheet.Root>
