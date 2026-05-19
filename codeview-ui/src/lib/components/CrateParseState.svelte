<script lang="ts">
	import type { CrateStatusValue } from '$lib/context';
	import type { Snippet } from 'svelte';
	import { onDestroy, untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { parseToastState } from '$lib/toast/parse-toast.svelte';
	import ParseToastContent from './ParseToastContent.svelte';
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
		showProgress,
		progressStep,
		progressNodeCount,
		progressEdgeCount,
		progressTotalItems,
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
		showProgress: boolean;
		progressStep: string | null;
		progressNodeCount: number;
		progressEdgeCount: number;
		progressTotalItems: number | null;
		children?: Snippet;
	} = $props();

	let activeToastId: string | number | null = null;
	let activeToastKey = '';
	let toastShownAt = 0;
	let dismissTimer: ReturnType<typeof setTimeout> | null = null;

	function dismissToast() {
		if (activeToastId !== null) {
			untrack(() => {
				toast.dismiss(activeToastId as string | number);
			});
			activeToastId = null;
			activeToastKey = '';
			toastShownAt = 0;
		}
	}

	function clearDismissTimer() {
		if (dismissTimer) {
			clearTimeout(dismissTimer);
			dismissTimer = null;
		}
	}

	function clearToastState() {
		parseToastState.active = false;
		parseToastState.crateName = '';
		parseToastState.version = '';
		parseToastState.step = null;
		parseToastState.nodeCount = 0;
		parseToastState.edgeCount = 0;
		parseToastState.totalItems = null;
	}
	$effect(() => {
		if (!showProgress) {
			clearToastState();
			const now = Date.now();
			const elapsed = toastShownAt ? now - toastShownAt : 0;
			const remaining = elapsed < 800 ? 800 - elapsed : 0;
			if (remaining > 0 && activeToastId !== null) {
				clearDismissTimer();
				dismissTimer = setTimeout(() => {
					dismissTimer = null;
					dismissToast();
				}, remaining);
				return;
			}
			clearDismissTimer();
			dismissToast();
			return;
		}
		const key = crateName && version ? `parse:${crateName}@${version}` : 'parse:unknown';
		if (activeToastKey && activeToastKey !== key) {
			dismissToast();
		}
		parseToastState.active = true;
		parseToastState.crateName = crateName ?? '';
		parseToastState.version = version ?? '';
		parseToastState.step = progressStep;
		parseToastState.nodeCount = progressNodeCount;
		parseToastState.edgeCount = progressEdgeCount;
		parseToastState.totalItems = progressTotalItems;
		if (activeToastId !== null) return;
		const id = untrack(() =>
			toast.custom(ParseToastContent, {
				id: key,
				duration: Number.POSITIVE_INFINITY,
				dismissable: false,
				closeButton: false,
			}),
		);
		activeToastId = id;
		activeToastKey = key;
		toastShownAt = Date.now();
	});

	onDestroy(() => {
		clearDismissTimer();
		clearToastState();
		dismissToast();
	});
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
