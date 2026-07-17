<script lang="ts">
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
	const editorHref = $derived(
		canOpenEditor && editorPath ? editorUri(editorScheme, editorPath, line) : null,
	);
	const currentCloneCommand = $derived(repoUrl ? cloneCommand(repoUrl, vcsMode) : '');

	let cloneCopied = $state(false);

	async function copyCloneCommand() {
		if (!currentCloneCommand) return;
		await navigator.clipboard.writeText(currentCloneCommand);
		cloneCopied = true;
		setTimeout(() => (cloneCopied = false), 2000);
	}
</script>

<div class="source-actions {className}">
	{#if sourceFile}
		<a
			href={editorHref ?? undefined}
			class="source-action"
			aria-disabled={!canOpenEditor}
			tabindex={canOpenEditor ? undefined : -1}
			title={canOpenEditor ? 'Open in editor' : 'Set local source root in settings'}
			aria-label="Open in editor"
		>
			<SquareArrowOutUpRight size={16} />
		</a>
	{/if}
	{#if repoUrl}
		<a
			href={repoUrl}
			target="_blank"
			rel="noopener noreferrer"
			class="source-action"
			title="Open source on web"
			aria-label="Open source on web"
		>
			<ExternalLink size={16} />
		</a>
		<details class="clone-wrapper">
			<summary class="source-action" title="Clone repository" aria-label="Clone repository">
				<TerminalSquare size={16} />
			</summary>
			<div class="clone-popover">
				<code class="clone-command">{currentCloneCommand}</code>
				<button
					type="button"
					class="clone-copy js-only"
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
		</details>
	{/if}
</div>

<style>
	.source-actions {
		display: flex;
		align-items: center;
		gap: 0.125rem;
	}

	.source-action {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
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

	.source-action[aria-disabled='true'] {
		cursor: not-allowed;
		opacity: 0.42;
	}

	.clone-wrapper > summary {
		list-style: none;
	}

	.clone-wrapper > summary::-webkit-details-marker {
		display: none;
	}

	.clone-wrapper {
		position: relative;
	}

	.clone-popover {
		position: absolute;
		top: calc(100% + 0.375rem);
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
		font-size: var(--text-sm);
		color: var(--ink);
		user-select: all;
	}

	.clone-copy {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.5rem;
		height: 1.5rem;
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
