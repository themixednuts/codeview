import type { CrateStatus } from '$lib/schema';
import { triggerCrateParse } from '$lib/rpc/crate.remote';
import { getLogger } from '$lib/log';
import { connect } from '$realtime';

type CrateStatusValue = CrateStatus['status'];

/** Ordered pipeline steps — index determines ordering. */
export const STEP_ORDER = ['resolving', 'fetching', 'parsing', 'storing', 'indexing'];

export const stepLabels: Record<string, string> = {
	resolving: 'Resolving metadata...',
	fetching: 'Downloading rustdoc...',
	parsing: 'Extracting graph...',
	storing: 'Uploading graph...',
	indexing: 'Indexing dependencies...'
};

export const stepPercents: Record<string, number> = {
	resolving: 20,
	fetching: 40,
	parsing: 60,
	storing: 80,
	indexing: 90
};

/**
 * Reactive connection for streaming crate parse status via shared event stream.
 * Uses multiplexed SSE to avoid connection limits.
 *
 * All public properties use $state and are automatically reactive.
 * Components can read them directly without subscribing.
 */
export class CrateStatusConnection implements Disposable {
	status = $state<CrateStatusValue>('unknown');
	error = $state<string | null>(null);
	step = $state<string | null>(null);
	action = $state<'install_std_docs' | 'docs_unavailable' | undefined>(undefined);
	installedVersion = $state<string | undefined>(undefined);

	#client = connect();
	#log = getLogger('status');
	#name = '';
	#version = '';
	#currentTag: string | null = null;
	#unsubscribe: (() => void) | null = null;

	get tag() {
		return `${this.#name}@${this.#version}`;
	}

	/**
	 * Connect to a crate's status stream.
	 */
	async connect(name: string, version: string) {
		this.disconnect();

		this.#name = name;
		this.#version = version;
		const tag = `rust:${name}:${version}`;
		this.#currentTag = tag;

		this.#log.debug`connect ${this.tag}`;

		// Reset state
		this.status = 'unknown';
		this.error = null;
		this.step = null;
		this.action = undefined;
		this.installedVersion = undefined;

		// Subscribe via shared connection
		const callback = (data: unknown) => this.onStatusData(data as CrateStatus);
		await this.#client.subscribe(tag, callback);
		this.#unsubscribe = () => this.#client.unsubscribe(tag, callback);
	}

	/**
	 * Disconnect from current status stream.
	 */
	disconnect() {
		if (this.#unsubscribe) {
			this.#unsubscribe();
			this.#unsubscribe = null;
		}
		this.#currentTag = null;
	}

	destroy() {
		this.disconnect();
	}

	[Symbol.dispose]() {
		this.destroy();
	}

	private onStatusData(msg: CrateStatus) {
		this.#log.debug`msg ${this.tag} status=${msg.status} step=${msg.step ?? '-'}${msg.error ? ` error=${msg.error}` : ''}`;

		this.status = msg.status;
		this.error = msg.error ?? null;
		this.action = msg.action;
		this.installedVersion = msg.installedVersion;

		// Only advance step forward — never retract
		const incoming = msg.step ?? null;
		if (incoming !== null) {
			const curIdx = this.step ? STEP_ORDER.indexOf(this.step) : -1;
			const newIdx = STEP_ORDER.indexOf(incoming);
			if (newIdx >= curIdx) this.step = incoming;
		}

		// Terminal states — disconnect
		if (msg.status === 'ready' || msg.status === 'failed') {
			this.#log.debug`terminal ${this.tag} status=${msg.status}`;
			this.disconnect();
		}
	}

	/** Trigger a parse and start watching. */
	async triggerParse(name: string, version: string) {
		this.#log.info`triggerParse ${name}@${version}`;
		this.status = 'processing';
		this.error = null;
		this.step = null;

		// Ensure we're subscribed
		await this.connect(name, version);

		try {
			await triggerCrateParse(`${name}@${version}`);
		} catch (err) {
			this.#log.error`triggerParse failed ${name}@${version}: ${String(err)}`;
			this.status = 'failed';
			this.error = err instanceof Error ? err.message : String(err);
		}
	}

	/** Retry a failed parse (force re-parse). */
	async retry(name: string, version: string) {
		this.#log.info`retry ${name}@${version}`;
		this.error = null;
		await this.triggerParseWithForce(name, version);
	}

	/** Trigger a parse with the force flag to clear failed state. */
	private async triggerParseWithForce(name: string, version: string) {
		this.#log.info`triggerParse(force) ${name}@${version}`;
		this.status = 'processing';
		this.error = null;
		this.step = null;

		// Ensure we're subscribed
		await this.connect(name, version);

		try {
			await triggerCrateParse(`${name}@${version}!force`);
		} catch (err) {
			this.#log.error`triggerParse(force) failed ${name}@${version}: ${String(err)}`;
			this.status = 'failed';
			this.error = err instanceof Error ? err.message : String(err);
		}
	}
}
