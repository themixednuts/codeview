<script lang="ts">
	import { browser } from '$app/environment';
	import type { Node } from '$lib/schema';
	import { kindLabels } from '$lib/display-names';
	import { parseDocumentation } from '$lib/highlight/documentation';
	import PlayIcon from '@lucide/svelte/icons/play';
	import PauseIcon from '@lucide/svelte/icons/pause';
	import SquareIcon from '@lucide/svelte/icons/square';
	import CodeIcon from '@lucide/svelte/icons/code';
	import GaugeIcon from '@lucide/svelte/icons/gauge';
	import Volume2Icon from '@lucide/svelte/icons/volume-2';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';

	type SpeechState = 'idle' | 'speaking' | 'paused';

	let { node } = $props<{ node: Node }>();

	let includeCode = $state(false);
	let rate = $state(1);
	let speechState: SpeechState = $state('idle');
	let chunkIndex = $state(0);
	let utterance: SpeechSynthesisUtterance | null = null;
	let queuedChunks: string[] = [];
	let speechSession = 0;

	const docs = $derived(node.docs ?? '');
	const segments = $derived(docs ? parseDocumentation(docs, 'rust', node.doc_links ?? {}) : []);
	const supported = $derived(
		browser &&
			'speechSynthesis' in window &&
			'SpeechSynthesisUtterance' in window &&
			typeof window.speechSynthesis?.speak === 'function',
	);
	const transcript = $derived(buildTranscript());
	const canRead = $derived(supported && transcript.length > 0);
	const progressLabel = $derived.by(() => {
		if (speechState === 'idle') return '';
		const total = Math.max(queuedChunks.length, 1);
		return `${Math.min(chunkIndex + 1, total)}/${total}`;
	});

	$effect(() => {
		node.id;
		return () => stop();
	});

	function buildTranscript(): string {
		if (!docs.trim()) return '';

		const kindLabel = kindLabels[node.kind as keyof typeof kindLabels] ?? String(node.kind);
		const parts = [`${kindLabel} ${node.name}.`];
		for (const segment of segments) {
			if (segment.type === 'text') {
				const text = htmlToText(segment.html);
				if (text) parts.push(text);
				continue;
			}

			parts.push(
				includeCode ? `Code example. ${codeToSpeech(segment.content)}` : 'Code example omitted.',
			);
		}

		return normalizeSpeechText(parts.join('\n\n'));
	}

	function htmlToText(html: string): string {
		if (browser && typeof DOMParser !== 'undefined') {
			const doc = new DOMParser().parseFromString(html, 'text/html');
			doc.querySelectorAll('script, style, svg').forEach((el) => el.remove());
			doc.querySelectorAll('code').forEach((el) => {
				el.replaceWith(doc.createTextNode(` ${el.textContent ?? ''} `));
			});
			return normalizeSpeechText(doc.body.textContent ?? '');
		}

		return normalizeSpeechText(html.replace(/<[^>]*>/g, ' '));
	}

	function codeToSpeech(code: string): string {
		return normalizeSpeechText(
			code
				.split('\n')
				.map((line) => line.replace(/^\s*\d+\s+/, '').trimEnd())
				.filter(Boolean)
				.join('. '),
		);
	}

	function normalizeSpeechText(text: string): string {
		return text
			.replace(/&nbsp;/g, ' ')
			.replace(/::/g, ' namespace ')
			.replace(/_/g, ' underscore ')
			.replace(/\s+/g, ' ')
			.trim();
	}

	function splitTranscript(text: string): string[] {
		const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [text];
		const chunks: string[] = [];
		let current = '';

		for (const sentence of sentences.map((part) => part.trim()).filter(Boolean)) {
			if (current && `${current} ${sentence}`.length > 260) {
				chunks.push(current);
				current = sentence;
			} else {
				current = current ? `${current} ${sentence}` : sentence;
			}
		}
		if (current) chunks.push(current);
		return chunks;
	}

	function play() {
		if (!canRead) return;
		if (speechState === 'paused') {
			window.speechSynthesis.resume();
			speechState = 'speaking';
			if (!utterance && chunkIndex < queuedChunks.length) speakCurrent(speechSession);
			return;
		}

		stop(true);
		const session = speechSession;
		queuedChunks = splitTranscript(transcript);
		chunkIndex = 0;
		speechState = 'speaking';
		queueMicrotask(() => speakCurrent(session));
	}

	function speakCurrent(session = speechSession) {
		if (session !== speechSession || !supported || speechState !== 'speaking') return;
		if (chunkIndex >= queuedChunks.length) {
			finish(session);
			return;
		}

		const nextUtterance = new SpeechSynthesisUtterance(queuedChunks[chunkIndex]);
		utterance = nextUtterance;
		nextUtterance.rate = rate;
		nextUtterance.onend = () => {
			if (session !== speechSession || utterance !== nextUtterance || speechState !== 'speaking')
				return;
			chunkIndex += 1;
			speakCurrent(session);
		};
		nextUtterance.onerror = () => finish(session);
		window.speechSynthesis.speak(nextUtterance);
	}

	function pause() {
		if (!supported || speechState !== 'speaking') return;
		window.speechSynthesis.pause();
		speechState = 'paused';
	}

	function stop(force = false) {
		speechSession += 1;
		if (utterance) {
			utterance.onend = null;
			utterance.onerror = null;
		}
		if (supported && (force || speechState !== 'idle' || utterance || queuedChunks.length > 0)) {
			window.speechSynthesis.cancel();
		}
		resetSpeechState();
	}

	function finish(session = speechSession) {
		if (session !== speechSession) return;
		resetSpeechState();
	}

	function resetSpeechState() {
		speechState = 'idle';
		chunkIndex = 0;
		utterance = null;
		queuedChunks = [];
	}

	function toggleCode() {
		if (speechState !== 'idle') stop();
		includeCode = !includeCode;
	}

	function updateRate(event: Event) {
		const nextRate = Number((event.currentTarget as HTMLInputElement).value);
		if (Number.isFinite(nextRate)) rate = nextRate;
	}
</script>

<div class="doc-read-aloud js-only flex flex-wrap items-center gap-1.5" data-reader-ignore>
	<button
		type="button"
		class="reader-button reader-button-primary"
		onclick={play}
		disabled={!canRead}
		title={supported
			? speechState === 'paused'
				? 'Resume read aloud'
				: speechState === 'speaking'
					? 'Restart read aloud'
					: 'Read aloud'
			: 'Read aloud unavailable'}
		aria-label={speechState === 'paused'
			? 'Resume read aloud'
			: speechState === 'speaking'
				? 'Restart read aloud'
				: 'Read aloud'}
	>
		{#if speechState === 'paused'}
			<PlayIcon size={13} />
			<span>Resume</span>
		{:else if speechState === 'speaking'}
			<RotateCcwIcon size={13} />
			<span>Restart</span>
		{:else}
			<Volume2Icon size={13} />
			<span>Read</span>
		{/if}
	</button>

	{#if speechState === 'speaking'}
		<button
			type="button"
			class="reader-icon-button"
			onclick={pause}
			title="Pause"
			aria-label="Pause"
		>
			<PauseIcon size={13} />
		</button>
	{/if}

	{#if speechState !== 'idle'}
		<button
			type="button"
			class="reader-icon-button"
			onclick={() => stop()}
			title="Stop"
			aria-label="Stop"
		>
			<SquareIcon size={12} />
		</button>
		<span class="reader-progress" aria-live="polite">{progressLabel}</span>
	{/if}

	<button
		type="button"
		class:reader-active={includeCode}
		class="reader-icon-button"
		onclick={toggleCode}
		disabled={!docs.trim()}
		title={includeCode ? 'Skip code blocks' : 'Include code blocks'}
		aria-label={includeCode ? 'Skip code blocks' : 'Include code blocks'}
		aria-pressed={includeCode}
	>
		<CodeIcon size={13} />
	</button>

	<label class="reader-rate" title="Speech rate">
		<GaugeIcon size={12} />
		<input
			type="range"
			min="0.75"
			max="1.5"
			step="0.25"
			value={rate}
			oninput={updateRate}
			disabled={!canRead}
			aria-label="Speech rate"
		/>
		<span>{rate.toFixed(2).replace(/\.00$/, '')}x</span>
	</label>
</div>

<style>
	.reader-button,
	.reader-icon-button,
	.reader-rate {
		border: 1px solid var(--panel-border-soft);
		background: var(--panel-solid);
		color: var(--ink-soft);
		box-shadow: var(--shadow-soft);
	}

	.reader-button,
	.reader-icon-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.35rem;
		min-height: 1.75rem;
		border-radius: var(--radius-control);
		font-size: var(--text-xs);
		font-weight: 600;
		line-height: 1;
		transition:
			border-color 0.12s ease,
			background-color 0.12s ease,
			color 0.12s ease;
	}

	.reader-button {
		padding: 0 0.65rem;
	}

	.reader-icon-button {
		width: 1.75rem;
		padding: 0;
	}

	.reader-button:hover:not(:disabled),
	.reader-icon-button:hover:not(:disabled),
	.reader-active {
		border-color: var(--accent-ring);
		background: var(--accent-soft);
		color: var(--accent-strong);
	}

	.reader-button:disabled,
	.reader-icon-button:disabled,
	.reader-rate:has(input:disabled) {
		cursor: not-allowed;
		opacity: 0.5;
	}

	.reader-button-primary {
		color: var(--ink);
	}

	.reader-progress {
		min-width: 2.25rem;
		font-family: var(--font-code);
		font-size: var(--text-xs);
		color: var(--muted-soft);
		text-align: center;
	}

	.reader-rate {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		min-height: 1.75rem;
		border-radius: var(--radius-control);
		padding: 0 0.45rem;
		font-family: var(--font-code);
		font-size: var(--text-xs);
	}

	.reader-rate input {
		width: 4.25rem;
		accent-color: var(--accent);
	}
</style>
