<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { Button } from '#lib/components/ui/button/index.js';
	import Icon from '#lib/components/design/Icon.svelte';

	const notFound = $derived(page.status === 404);
	const heading = $derived(notFound ? 'Not found' : 'Something went wrong');
	const detail = $derived(
		page.error?.message && page.error.message !== 'Not Found'
			? page.error.message
			: notFound
				? 'That crate, version or item does not exist.'
				: 'The page failed to load. Try again in a moment.',
	);
	const crate = $derived(page.params.crate);
</script>

<svelte:head>
	<title>{heading} · Codeview</title>
</svelte:head>

<div class="flex flex-1 overflow-auto">
	<main id="main-content" tabindex="-1" class="mx-auto w-full max-w-160 px-4 py-16 sm:px-6">
		<p class="font-mono text-sm text-(--muted-soft)">{page.status}</p>
		<h1 class="mt-2 font-display text-2xl font-semibold text-(--ink)">{heading}</h1>
		<p class="mt-3 text-(--muted)">{detail}</p>
		<div class="mt-8 flex flex-wrap gap-2">
			<Button href={resolve('/')}>
				<Icon name="search" size={14} />
				Browse crates
			</Button>
			{#if notFound && crate && page.params.version && page.params.version !== 'latest'}
				<Button variant="outline" href={resolve('/[crate]/[version]', { crate, version: 'latest' })}>
					{crate} latest
				</Button>
			{/if}
		</div>
	</main>
</div>
