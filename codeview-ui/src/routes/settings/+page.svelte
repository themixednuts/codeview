<script lang="ts">
	import { Button } from '$lib/shadcn/ui/button';
	import * as Field from '$lib/shadcn/ui/field';
	import * as NativeSelect from '$lib/shadcn/ui/native-select';
	import {
		ACCENT_KEY,
		CODE_DARK_KEY,
		CODE_LIGHT_KEY,
		DENSITY_KEY,
		DOC_LAYOUT_KEY,
		THEME_KEY,
		TEXT_SIZE_KEY,
		VOICE_KEY,
	} from '$lib/preferences';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const fields = [
		{ key: THEME_KEY, label: 'Theme', options: ['system', 'light', 'dark'] },
		{ key: ACCENT_KEY, label: 'Accent', options: ['orange', 'cobalt', 'forest', 'plum', 'char'] },
		{ key: DENSITY_KEY, label: 'Density', options: ['compact', 'comfortable', 'spacious'] },
		{ key: TEXT_SIZE_KEY, label: 'Text size', options: ['standard', 'large', 'extra-large'] },
		{ key: VOICE_KEY, label: 'Typography', options: ['editorial', 'technical', 'geometric'] },
		{
			key: DOC_LAYOUT_KEY,
			label: 'Documentation layout',
			options: ['classic', 'reading', 'split'],
		},
		{
			key: CODE_LIGHT_KEY,
			label: 'Light code theme',
			options: ['solarized-light', 'catppuccin-latte', 'one-light', 'github-light'],
		},
		{
			key: CODE_DARK_KEY,
			label: 'Dark code theme',
			options: ['solarized-dark', 'catppuccin-mocha', 'one-dark', 'github-dark'],
		},
	] as const;

	function optionLabel(value: string) {
		return value.replaceAll('-', ' ').replace(/^./, (letter) => letter.toUpperCase());
	}
</script>

<svelte:head>
	<title>Settings · Codeview</title>
</svelte:head>

<main id="main-content" class="min-h-0 flex-1 overflow-auto px-4 py-8 sm:px-6">
	<div class="mx-auto max-w-2xl">
		<div class="mb-6">
			<p class="text-2xs font-semibold tracking-[0.2em] text-(--muted-soft) uppercase">
				Codeview
			</p>
			<h1 class="font-display mt-1 text-2xl font-semibold text-(--ink)">Settings</h1>
		</div>

		<form method="POST" class="space-y-6">
			<input type="hidden" name="returnTo" value={data.returnTo} />
			<Field.Group class="grid gap-5 sm:grid-cols-2">
				{#each fields as field (field.key)}
					<Field.Field>
						<Field.Label for={field.key}>{field.label}</Field.Label>
						<NativeSelect.Root
							id={field.key}
							name={field.key}
							value={String(data.preferences[field.key])}
							class="w-full"
						>
							{#each field.options as option (option)}
								<NativeSelect.Option value={option}>{optionLabel(option)}</NativeSelect.Option>
							{/each}
						</NativeSelect.Root>
					</Field.Field>
				{/each}
			</Field.Group>

			<div class="flex items-center justify-end gap-2 border-t border-(--panel-border) pt-5">
				<Button href={data.returnTo} variant="ghost">Cancel</Button>
				<Button type="submit">Save settings</Button>
			</div>
		</form>
	</div>
</main>
