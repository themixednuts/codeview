<script lang="ts">
	import type { CrateStatusValue } from '$lib/context';
	import type { Snippet } from 'svelte';
	import DocsUnavailable from './DocsUnavailable.svelte';
	import ParseError from './ParseError.svelte';
	import StdDocsPrompt from './StdDocsPrompt.svelte';

	let {
		crateName,
		version,
		status,
		action,
		error,
		installedVersion,
		crateVersionOptions,
		hasTreeData,
		onInstallStart,
		onInstallError,
		onRetryStart,
		onRetryError,
		children,
	}: {
		crateName: string | undefined;
		version: string | undefined;
		status: CrateStatusValue;
		action?: 'install_std_docs' | 'docs_unavailable';
		error?: string | null;
		installedVersion?: string;
		crateVersionOptions: string[];
		hasTreeData: boolean;
		onInstallStart?: () => void;
		onInstallError?: (message: string) => void;
		onRetryStart?: () => void;
		onRetryError?: (message: string) => void;
		children?: Snippet;
	} = $props();
</script>

{#if status === 'failed' && action === 'install_std_docs'}
	<StdDocsPrompt {crateName} {version} {installedVersion} {onInstallStart} {onInstallError} />
{:else if status === 'failed' && action === 'docs_unavailable' && !hasTreeData}
	<DocsUnavailable {crateName} {version} {crateVersionOptions} {onRetryStart} {onRetryError} />
{:else if status === 'failed' && !hasTreeData}
	<ParseError {crateName} {version} {error} {onRetryStart} {onRetryError} />
{:else}
	{@render children?.()}
{/if}
