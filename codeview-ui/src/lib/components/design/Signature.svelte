<script lang="ts">
	import type { Node } from '$lib/schema';
	import { formatSignature } from '$lib/signature-format';
	import CodeBlock from './CodeBlock.svelte';

	let {
		node,
		form = 'inline',
		theme = 'light',
		variant = 'flat',
		label,
	} = $props<{
		node: Pick<Node, 'name' | 'signature'>;
		form?: 'inline' | 'multiline';
		theme?: 'dark' | 'light';
		variant?: 'default' | 'flat';
		label?: string;
	}>();

	const formatted = $derived(formatSignature(node));
	const code = $derived(form === 'multiline' ? formatted.multiline : formatted.inline);
</script>

<CodeBlock {code} lang="rust" {theme} {variant} {label} />
