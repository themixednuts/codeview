<script lang="ts">
	import type { Span } from '$lib/graph';
	import type { Attachment } from 'svelte/attachments';
	import { LoaderCircleIcon } from '@lucide/svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { browser } from '$app/environment';
	import { getSource } from '$lib/rpc/source.remote';
	import { sourceProviderModeCtx, editorSchemeCtx, vcsModeCtx } from '$lib/context';
	import { parseExplorerState, serializeExplorerState } from '$lib/url-state';
	import CodeBlock from './CodeBlock.svelte';
	import X from '@lucide/svelte/icons/x';
	import SquareArrowOutUpRight from '@lucide/svelte/icons/square-arrow-out-up-right';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import TerminalSquare from '@lucide/svelte/icons/terminal-square';
	import ClipboardCopy from '@lucide/svelte/icons/clipboard-copy';
	import Check from '@lucide/svelte/icons/check';

	interface Props {
		span: Span;
		theme?: 'dark' | 'light';
		crateName?: string;
		crateVersion?: string;
	}

	let { span, theme = 'light', crateName, crateVersion }: Props = $props();

	const sourceProviderMode = $derived(sourceProviderModeCtx.getOr('auto'));

	/** Unique key for this span (guards against null during teardown) */
	const spanKey = $derived(span ? `${span.file}:${span.line}:${span.end_line ?? span.line}` : '');

	/** Display path with forward slashes — rustdoc JSON generated on Windows
	 *  carries backslashes (e.g. `library\alloc\src\boxed.rs`) which look wrong
	 *  on the web. We normalise display only; the request payload still uses
	 *  the raw path so the server's source loader resolves correctly. */
	const displayFile = $derived(span?.file ? span.file.replace(/\\/g, '/') : '');

	const viewState = $derived(parseExplorerState(page.url));
	const isOpen = $derived(browser && !!spanKey && viewState.src === spanKey);

	const sourceData = $derived(
		isOpen && span
			? await getSource({
					file: span.file,
					crateName,
					crateVersion,
					sourceProvider: sourceProviderMode,
				})
			: null,
	);
	const sourceContent = $derived(sourceData?.content ?? null);
	const absolutePath = $derived(sourceData?.absolutePath ?? null);
	const repoUrl = $derived(sourceData?.repoUrl ?? null);

	const editorScheme = $derived(editorSchemeCtx.getOr('vscode://file/{path}:{line}'));
	const vcsMode = $derived(vcsModeCtx.getOr('git'));

	/** Whether viewing an external crate (not the workspace crate) */
	const isExternalCrate = $derived(!!crateName);

	/** Extract repo base URL from a GitHub blob URL (strip /blob/...) */
	function repoBaseUrl(url: string): string {
		const blobIdx = url.indexOf('/blob/');
		return blobIdx !== -1 ? url.slice(0, blobIdx) : url;
	}

	/** Build the clone command based on VCS preference */
	const cloneCommand = $derived.by(() => {
		if (!repoUrl) return '';
		const base = repoBaseUrl(repoUrl);
		return vcsMode === 'jj' ? `jj git clone ${base}` : `git clone ${base}`;
	});

	let clonePopoverOpen = $state(false);
	let cloneCopied = $state(false);

	function openInEditor() {
		if (!absolutePath || !span) return;
		const uri = editorScheme.replace('{path}', absolutePath).replace('{line}', String(span.line));
		window.open(uri);
	}

	function openOnGitHub() {
		if (!repoUrl) return;
		window.open(repoUrl, '_blank');
	}

	function toggleClonePopover() {
		clonePopoverOpen = !clonePopoverOpen;
		cloneCopied = false;
	}

	async function copyCloneCommand() {
		await navigator.clipboard.writeText(cloneCommand);
		cloneCopied = true;
		setTimeout(() => (cloneCopied = false), 2000);
	}

	function handleCloneKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') clonePopoverOpen = false;
	}

	/** Click-outside handler for clone popover */
	const cloneClickOutside: Attachment<HTMLDivElement> = (wrapper) => {
		$effect(() => {
			if (!clonePopoverOpen) return;
			function onClick(e: MouseEvent) {
				if (!wrapper.contains(e.target as HTMLElement)) {
					clonePopoverOpen = false;
				}
			}
			document.addEventListener('click', onClick, true);
			return () => document.removeEventListener('click', onClick, true);
		});
	};

	const highlightRange = $derived.by(() => {
		if (!span) return [];
		const start = span.line;
		const end = span.end_line ?? span.line;
		const lines: number[] = [];
		for (let i = start; i <= end; i++) lines.push(i);
		return lines;
	});

	function open() {
		if (!spanKey) return;
		updateSourceParam(spanKey);
	}

	function clearSourceState() {
		if (!isOpen) return;
		updateSourceParam(null);
	}

	function updateSourceParam(src: string | null) {
		void goto(serializeExplorerState(page.url, { src }), {
			replaceState: true,
			noScroll: true,
			keepFocus: true,
		});
	}

	function close() {
		clonePopoverOpen = false;
		clearSourceState();
	}

	function handleDialogClose() {
		clearSourceState();
	}

	function handleBackdropClick(e: MouseEvent) {
		if (e.target === e.currentTarget) close();
	}

	function langFromFile(file: string): 'rust' | 'toml' | 'json' | 'text' {
		if (file.endsWith('.rs')) return 'rust';
		if (file.endsWith('.toml')) return 'toml';
		if (file.endsWith('.json')) return 'json';
		return 'text';
	}

	// Attachment to sync dialog open/close with isOpen state
	const syncDialog: Attachment<HTMLDialogElement> = (dialog) => {
		$effect(() => {
			if (isOpen && !dialog.open) {
				dialog.showModal();
			} else if (!isOpen && dialog.open) {
				dialog.close();
			}
		});
	};

	// Attachment to scroll to highlighted line when content loads
	const scrollToHighlight: Attachment<HTMLDivElement> = (container) => {
		let lastKey: string | null = null;

		$effect(() => {
			if (!isOpen || !sourceContent) {
				lastKey = null;
				return;
			}
			if (lastKey === spanKey) return;
			lastKey = spanKey;

			requestAnimationFrame(() => {
				const firstHighlighted = container.querySelector('.line.highlighted');
				if (firstHighlighted) {
					const lineTop = (firstHighlighted as HTMLElement).offsetTop;
					const offset = Math.max(0, lineTop - container.clientHeight / 3);
					container.scrollTo({ top: offset, behavior: 'instant' });
				}
			});
		});
	};
</script>

<button type="button" class="source-link" onclick={open} title="View source">
	<span class="token-name">{displayFile}</span>
	<span class="token-meta">:{span.line}:{span.column}</span>
</button>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<dialog
	{@attach syncDialog}
	onclose={handleDialogClose}
	onclick={handleBackdropClick}
	aria-label="Source: {displayFile}"
>
	<div class="modal-panel">
		<header class="modal-header">
			<div class="modal-title">
				<span class="modal-file">{displayFile}</span>
				<span class="modal-line">:{span.line}:{span.column}</span>
			</div>
			<div class="modal-actions">
				{#if absolutePath}
					<button type="button" class="modal-action" onclick={openInEditor} title="Open in editor">
						<SquareArrowOutUpRight size={16} />
					</button>
				{/if}
				{#if repoUrl}
					<button type="button" class="modal-action" onclick={openOnGitHub} title="View on GitHub">
						<ExternalLink size={16} />
					</button>
				{/if}
				{#if isExternalCrate && repoUrl}
					<div class="clone-wrapper" {@attach cloneClickOutside}>
						<button
							type="button"
							class="modal-action"
							onclick={toggleClonePopover}
							title="Clone repository"
						>
							<TerminalSquare size={16} />
						</button>
						{#if clonePopoverOpen}
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<div class="clone-popover" onkeydown={handleCloneKeydown}>
								<code class="clone-command">{cloneCommand}</code>
								<button
									type="button"
									class="clone-copy"
									onclick={copyCloneCommand}
									title="Copy to clipboard"
								>
									{#if cloneCopied}
										<Check size={14} />
									{:else}
										<ClipboardCopy size={14} />
									{/if}
								</button>
							</div>
						{/if}
					</div>
				{/if}
				<button type="button" class="modal-close" onclick={close} aria-label="Close">
					<X size={18} />
				</button>
			</div>
		</header>
		<div class="modal-body" {@attach scrollToHighlight}>
			{#if sourceData?.error}
				<p class="source-error">{sourceData.error}</p>
			{:else if sourceData?.content}
				<CodeBlock
					code={sourceData.content}
					lang={langFromFile(span.file)}
					{theme}
					startLine={1}
					highlightLines={highlightRange}
					showLineNumbers={true}
				/>
			{:else if isOpen}
				<div class="flex items-center gap-2 p-4">
					<LoaderCircleIcon class="animate-spin" size={12} />
					<span class="text-xs text-(--muted)">Loading source...</span>
				</div>
			{:else}
				<p class="source-error">Source unavailable.</p>
			{/if}
		</div>
	</div>
</dialog>

<style>
	.source-link {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		font-family: var(--font-code);
		font-size: 0.8125rem;
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
		color: var(--ink);
		transition: color 0.15s;
	}

	.source-link:hover {
		color: var(--accent);
	}

	dialog {
		padding: 0;
		border: none;
		background: transparent;
		max-width: none;
		max-height: none;
		width: 100%;
		height: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	dialog::backdrop {
		background: var(--overlay-backdrop);
		backdrop-filter: blur(4px);
	}

	dialog:not([open]) {
		display: none;
	}

	.modal-panel {
		display: flex;
		flex-direction: column;
		width: min(90vw, 900px);
		max-height: 85vh;
		border-radius: var(--radius-panel, 12px);
		border: 1px solid var(--panel-border);
		background: var(--panel-solid);
		box-shadow: var(--shadow-modal);
		overflow: hidden;
	}

	.modal-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.75rem 1rem;
		border-bottom: 1px solid var(--panel-border);
		flex-shrink: 0;
	}

	.modal-title {
		font-family: var(--font-code);
		font-size: 0.875rem;
	}

	.modal-file {
		font-weight: 600;
		color: var(--ink);
	}

	.modal-line {
		color: var(--accent);
	}

	.modal-close {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border-radius: 6px;
		border: none;
		background: none;
		color: var(--muted);
		cursor: pointer;
		transition:
			background 0.15s,
			color 0.15s;
	}

	.modal-close:hover {
		background: var(--panel-strong);
		color: var(--ink);
	}

	.modal-actions {
		display: flex;
		align-items: center;
		gap: 2px;
	}

	.modal-action {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border-radius: 6px;
		border: none;
		background: none;
		color: var(--muted);
		cursor: pointer;
		transition:
			background 0.15s,
			color 0.15s;
	}

	.modal-action:hover {
		background: var(--panel-strong);
		color: var(--ink);
	}

	.clone-wrapper {
		position: relative;
	}

	.clone-popover {
		position: absolute;
		top: calc(100% + 6px);
		right: 0;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.625rem;
		background: var(--panel-solid);
		border: 1px solid var(--panel-border);
		border-radius: 8px;
		box-shadow: var(--shadow-modal);
		white-space: nowrap;
		z-index: 10;
	}

	.clone-command {
		font-family: var(--font-code);
		font-size: 0.75rem;
		color: var(--ink);
		user-select: all;
	}

	.clone-copy {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		border-radius: 4px;
		border: none;
		background: none;
		color: var(--muted);
		cursor: pointer;
		flex-shrink: 0;
		transition:
			background 0.15s,
			color 0.15s;
	}

	.clone-copy:hover {
		background: var(--panel-strong);
		color: var(--ink);
	}

	.modal-body {
		overflow: auto;
		flex: 1;
		min-height: 0;
	}

	.modal-body :global(pre) {
		margin: 0;
		border-radius: 0;
		border: none;
	}

	.source-error {
		color: var(--danger);
		font-size: 0.8125rem;
		padding: 1rem;
	}
</style>
