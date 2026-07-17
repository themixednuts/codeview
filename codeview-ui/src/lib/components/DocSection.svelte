<script lang="ts">
	/**
	 * Inline documentation section heading + content.
	 *
	 * Replaces the legacy CollapsibleSection accordion for top-level doc sections
	 * (Documentation, Methods, Trait Implementations, Relationships, Attributes).
	 * Matches the doc-classic design: Fraunces h2 with count and on-hover anchor,
	 * underlined with a soft border, content rendered inline below.
	 */
	let {
		title,
		anchor,
		count = null,
		children,
	} = $props<{
		title: string;
		anchor: string;
		count?: number | null;
		children: import('svelte').Snippet;
	}>();
</script>

<section id={anchor} class="doc-section group">
	<div
		class="mt-9 mb-4 flex items-baseline gap-3 border-b border-(--panel-border-soft) pb-2"
	>
		<h2
			class="font-display text-xl leading-tight font-semibold tracking-tight text-(--ink)"
		>
			{title}
		</h2>
		{#if count != null}
			<span class="font-mono text-xs text-(--muted-soft) tabular-nums">{count}</span>
		{/if}
		<a
			href={`#${anchor}`}
			class="ml-auto font-mono text-xs text-(--muted-soft) opacity-0 transition-opacity group-hover:opacity-100 hover:text-(--accent)"
			aria-label="Permalink to {title}"
		>
			#{anchor}
		</a>
	</div>
	{@render children()}
</section>
