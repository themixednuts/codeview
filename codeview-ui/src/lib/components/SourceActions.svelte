<script lang="ts">
	import type { Attachment } from 'svelte/attachments';
	import SquareArrowOutUpRight from '@lucide/svelte/icons/square-arrow-out-up-right';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import TerminalSquare from '@lucide/svelte/icons/terminal-square';
	import ClipboardCopy from '@lucide/svelte/icons/clipboard-copy';
	import Check from '@lucide/svelte/icons/check';
	import { editorSchemeCtx, sourceRootCtx, vcsModeCtx } from '$lib/context';
	import { cloneCommand, editorUri, resolveEditorPath } from '$lib/source-links';

	let {
		repoUrl = null,
		absolutePath = null,
		sourceFile = '',
		line = 1,
		className = '',
	} = $props<{
		repoUrl?: string | null;
		absolutePath?: string | null;
		sourceFile?: string;
		line?: number;
		className?: string;
	}>();

	const editorScheme = $derived(editorSchemeCtx.getOr('vscode://file/{path}:{line}'));
	const sourceRoot = $derived(sourceRootCtx.getOr(''));
	const vcsMode = $derived(vcsModeCtx.getOr('git'));
	const editorPath = $derived(resolveEditorPath(absolutePath, sourceRoot, sourceFile));
	const canOpenEditor = $derived(Boolean(editorPath && sourceFile));
	const currentCloneCommand = $derived(repoUrl ? cloneCommand(repoUrl, vcsMode) : '');

	let clonePopoverOpen = $state(false);
	let cloneCopied = $state(false);

	function openInEditor() {
		if (!editorPath) return;
		window.open(editorUri(editorScheme, editorPath, line));
	}

	function openOnWeb() {
		if (!repoUrl) return;
		window.open(repoUrl, '_blank');
	}

	function toggleClonePopover() {
		clonePopoverOpen = !clonePopoverOpen;
		cloneCopied = false;
	}

	async function copyCloneCommand() {
		if (!currentCloneCommand) return;
		await navigator.clipboard.writeText(currentCloneCommand);
		cloneCopied = true;
		setTimeout(() => (cloneCopied = false), 2000);
	}

	function handleCloneKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') clonePopoverOpen = false;
	}

	const cloneClickOutside: Attachment<HTMLDivElement> = (wrapper) => {
		$effect(() => {
			if (!clonePopoverOpen) return;
			function onClick(event: MouseEvent) {
				if (!wrapper.contains(event.target as HTMLElement)) clonePopoverOpen = false;
			}
			document.addEventListener('click', onClick, true);
			return () => document.removeEventListener('click', onClick, true);
		});
	};
</script>

<div class="source-actions {className}">
	{#if sourceFile}
		<button
			type="button"
			class="source-action"
			onclick={openInEditor}
			disabled={!canOpenEditor}
			title={canOpenEditor ? 'Open in editor' : 'Set local source root in settings'}
			aria-label="Open in editor"
		>
			<SquareArrowOutUpRight size={16} />
		</button>
	{/if}
	{#if repoUrl}
		<button
			type="button"
			class="source-action"
			onclick={openOnWeb}
			title="Open source on web"
			aria-label="Open source on web"
		>
			<ExternalLink size={16} />
		</button>
		<div class="clone-wrapper" {@attach cloneClickOutside}>
			<button
				type="button"
				class="source-action"
				onclick={toggleClonePopover}
				title="Clone repository"
				aria-label="Clone repository"
			>
				<TerminalSquare size={16} />
			</button>
			{#if clonePopoverOpen}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="clone-popover" onkeydown={handleCloneKeydown}>
					<code class="clone-command">{currentCloneCommand}</code>
					<button
						type="button"
						class="clone-copy"
						onclick={copyCloneCommand}
						title="Copy to clipboard"
						aria-label="Copy clone command"
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
</div>

<style>
	.source-actions {
		display: flex;
		align-items: center;
		gap: 2px;
	}

	.source-action {
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

	.source-action:hover:not(:disabled) {
		background: var(--panel-strong);
		color: var(--ink);
	}

	.source-action:disabled {
		cursor: not-allowed;
		opacity: 0.42;
	}

	.clone-wrapper {
		position: relative;
	}

	.clone-popover {
		position: absolute;
		top: calc(100% + 6px);
		right: 0;
		z-index: 20;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 0.625rem;
		white-space: nowrap;
		border: 1px solid var(--panel-border);
		border-radius: 8px;
		background: var(--panel-solid);
		box-shadow: var(--shadow-modal);
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
		flex-shrink: 0;
		border: none;
		border-radius: 4px;
		background: none;
		color: var(--muted);
		cursor: pointer;
		transition:
			background 0.15s,
			color 0.15s;
	}

	.clone-copy:hover {
		background: var(--panel-strong);
		color: var(--ink);
	}
</style>
