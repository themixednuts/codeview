import { getLogger } from '$lib/log';
import { connect } from '$realtime';

/**
 * Delay before subscribing to edge updates (ms).
 * Prevents zombie subscriptions during rapid back/forward navigation —
 * if the user navigates away within this window, no subscription is made.
 */
const CONNECT_DELAY_MS = 1_500;

interface EdgeUpdateMessage {
	type?: string;
	nodeId?: string;
}

/**
 * Reactive connection for cross-crate edge updates via shared event stream.
 * Uses multiplexed SSE to avoid connection limits.
 * Emits a monotonically increasing tick when updates arrive.
 */
export class CrossEdgeUpdatesConnection implements Disposable {
	updateTick = $state(0);

	#client = connect();
	#log = getLogger('graph-updates');
	#nodeId = '';
	#currentTag: string | null = null;
	#unsubscribe: (() => void) | null = null;
	#connectTimer: ReturnType<typeof setTimeout> | null = null;

	get tag() {
		return `edge:${this.#nodeId}`;
	}

	/**
	 * Connect to edge updates for a node.
	 */
	connect(nodeId: string) {
		if (this.#nodeId === nodeId && this.#currentTag) return;
		this.#cancelPending();
		this.disconnect();

		this.#nodeId = nodeId;
		const tag = `edge:${nodeId}`;
		this.#currentTag = tag;

		this.#log.debug`connect ${this.tag}`;

		// Delay subscribing to avoid zombie connections on rapid navigation
		this.#connectTimer = setTimeout(() => {
			this.#connectTimer = null;
			this.#doSubscribe(tag);
		}, CONNECT_DELAY_MS);
	}

	async #doSubscribe(tag: string) {
		const callback = (data: unknown) => this.#onData(data as EdgeUpdateMessage);
		await this.#client.subscribe(tag, callback);
		this.#unsubscribe = () => this.#client.unsubscribe(tag, callback);
	}

	#cancelPending() {
		if (this.#connectTimer !== null) {
			clearTimeout(this.#connectTimer);
			this.#connectTimer = null;
		}
	}

	/**
	 * Disconnect from current edge updates.
	 */
	disconnect() {
		this.#cancelPending();
		if (this.#unsubscribe) {
			this.#unsubscribe();
			this.#unsubscribe = null;
		}
		this.#currentTag = null;
	}

	#onData(msg: EdgeUpdateMessage) {
		if (msg.type && msg.type !== 'cross-edges') return;
		this.updateTick += 1;
		this.#log.debug`update ${this.tag} tick=${String(this.updateTick)}`;
	}

	/** Clean up and disconnect. */
	destroy() {
		this.disconnect();
	}

	[Symbol.dispose]() {
		this.destroy();
	}
}
