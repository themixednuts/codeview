import { getLogger } from '$lib/log';
import { StreamConnection } from '$lib/stream.svelte';

/**
 * Delay before opening the SSE connection (ms).
 * Prevents zombie connections during rapid back/forward navigation —
 * if the user navigates away within this window, no connection is opened.
 */
const CONNECT_DELAY_MS = 1_500;

/**
 * Reactive SSE connection for cross-crate edge updates.
 * Emits a monotonically increasing tick when updates arrive.
 */
export class CrossEdgeUpdatesConnection extends StreamConnection {
	updateTick = $state(0);

	protected readonly log = getLogger('graph-updates');
	#nodeId = '';
	#connectTimer: ReturnType<typeof setTimeout> | null = null;

	protected get tag() {
		return `edge:${this.#nodeId}`;
	}

	protected get endpoint() {
		const key = `edge:${this.#nodeId}`;
		return `/api/graph-updates/sse?key=${encodeURIComponent(key)}`;
	}

	connect(nodeId: string) {
		if (this.#nodeId === nodeId && this.connected) return;
		this.#cancelPending();
		this.close();
		this.activate();
		this.#nodeId = nodeId;
		this.beginStream(`edge:${nodeId}`);
		// Delay opening to avoid zombie connections on rapid navigation
		this.#connectTimer = setTimeout(() => {
			this.#connectTimer = null;
			this.open();
		}, CONNECT_DELAY_MS);
	}

	#cancelPending() {
		if (this.#connectTimer !== null) {
			clearTimeout(this.#connectTimer);
			this.#connectTimer = null;
		}
	}

	override destroy() {
		this.#cancelPending();
		super.destroy();
	}

	protected override close() {
		this.#cancelPending();
		super.close();
	}

	protected onData(data: unknown) {
		const msg = data as { type?: string; nodeId?: string };
		if (msg.type && msg.type !== 'cross-edges') return;
		this.touchStream();
		this.updateTick += 1;
		this.log.debug`update ${this.tag} tick=${String(this.updateTick)}`;
	}
}
