import type { CrateStatus } from '$lib/schema';
import { triggerCrateParse } from '$lib/graph.remote';
import { getLogger } from '$lib/log';
import { SSEConnection } from '$lib/sse';

type CrateStatusValue = CrateStatus['status'];

/** Ordered pipeline steps — index determines ordering. */
const STEP_ORDER = ['resolving', 'fetching', 'parsing', 'storing', 'indexing'];

/**
 * Reactive SSE connection for streaming crate parse status.
 * Connects to the SSE endpoint which handles both hosted (DO stream)
 * and local (single-event) modes.
 */
export class CrateStatusConnection extends SSEConnection {
	status = $state<CrateStatusValue>('unknown');
	error = $state<string | null>(null);
	step = $state<string | null>(null);
	action = $state<'install_std_docs' | undefined>(undefined);
	installedVersion = $state<string | undefined>(undefined);

	protected readonly log = getLogger('status');
	#name = '';
	#version = '';

	protected get tag() {
		return `${this.#name}@${this.#version}`;
	}

	protected get endpoint() {
		const key = `rust:${this.#name}:${this.#version}`;
		return `/api/crate-status/sse?key=${encodeURIComponent(key)}`;
	}

	/** Connect to a crate's status stream. Closes any previous connection. */
	connect(name: string, version: string) {
		this.close();
		this.activate();
		this.#name = name;
		this.#version = version;
		this.status = 'unknown';
		this.error = null;
		this.step = null;
		this.action = undefined;
		this.installedVersion = undefined;
		this.open();
	}

	protected onData(data: unknown) {
		const msg = data as CrateStatus;
		this.log.debug`msg ${this.tag} status=${msg.status} step=${msg.step ?? '-'}${msg.error ? ` error=${msg.error}` : ''}`;
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

		// Terminal states — close stream
		if (msg.status === 'ready' || msg.status === 'failed') {
			this.log.debug`terminal ${this.tag} status=${msg.status}`;
			this.close();
		}
	}

	/** Trigger a parse and start watching. */
	async triggerParse(name: string, version: string) {
		this.log.info`triggerParse ${name}@${version}`;
		this.status = 'processing';
		this.error = null;
		this.step = null;
		this.close();
		this.activate();
		this.#name = name;
		this.#version = version;
		try {
			await triggerCrateParse(`${name}@${version}`);
			this.open();
		} catch (err) {
			this.log.error`triggerParse failed ${name}@${version}: ${String(err)}`;
			this.status = 'failed';
			this.error = err instanceof Error ? err.message : String(err);
		}
	}

	/** Retry a failed parse (force re-parse). */
	async retry(name: string, version: string) {
		this.log.info`retry ${name}@${version}`;
		this.error = null;
		await this.triggerParseWithForce(name, version);
	}

	/** Trigger a parse with the force flag to clear failed state. */
	private async triggerParseWithForce(name: string, version: string) {
		this.log.info`triggerParse(force) ${name}@${version}`;
		this.status = 'processing';
		this.error = null;
		this.step = null;
		this.close();
		this.activate();
		this.#name = name;
		this.#version = version;
		try {
			await triggerCrateParse(`${name}@${version}!force`);
			this.open();
		} catch (err) {
			this.log.error`triggerParse(force) failed ${name}@${version}: ${String(err)}`;
			this.status = 'failed';
			this.error = err instanceof Error ? err.message : String(err);
		}
	}
}
