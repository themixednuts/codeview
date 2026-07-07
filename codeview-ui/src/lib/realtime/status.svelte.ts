import type { CrateStatus } from '$lib/schema';
import { triggerCrateParse } from '$lib/rpc/crate.remote';
import { getLogger } from '$lib/log';
import { connect } from '$realtime';
import { STEP_ORDER, stepLabels, stepPercents } from './constants';
import type { RealtimeClient } from './types';

type CrateStatusValue = CrateStatus['status'];

export { STEP_ORDER, stepLabels, stepPercents };

export class CrateStatusConnection implements Disposable {
	status = $state<CrateStatusValue>('unknown');
	error = $state<string | null>(null);
	step = $state<string | null>(null);
	action = $state<'install_std_docs' | 'docs_unavailable' | undefined>(undefined);
	installedVersion = $state<string | undefined>(undefined);

	#client: RealtimeClient = connect();
	#log = getLogger('status');
	#name = '';
	#version = '';
	#currentTag: string | null = null;
	// Stable callback reference — same identity across subscribe/unsubscribe calls.
	// Using a per-call closure caused a race: the #unsubscribe closure was set after
	// an await, creating a microtask window where disconnect() couldn't clean up.
	#callback = (data: unknown) => this.#onStatusData(data as CrateStatus);

	get tag() {
		return `${this.#name}@${this.#version}`;
	}

	connect(name: string, version: string) {
		this.disconnect();

		this.#name = name;
		this.#version = version;
		const tag = `rust:${name}:${version}`;
		this.#currentTag = tag;

		this.#log.debug`connect ${this.tag}`;

		// Don't reset to 'unknown' if already seeded to 'ready' from SSR
		if (this.status !== 'ready') {
			this.status = 'unknown';
			this.error = null;
			this.step = null;
			this.action = undefined;
			this.installedVersion = undefined;
		}

		this.#client.subscribe(tag, this.#callback);
	}

	disconnect() {
		if (this.#currentTag) {
			this.#client.unsubscribe(this.#currentTag, this.#callback);
			this.#currentTag = null;
		}
	}

	destroy() {
		this.disconnect();
	}

	[Symbol.dispose]() {
		this.destroy();
	}

	#onStatusData(msg: CrateStatus) {
		this.#log
			.debug`msg ${this.tag} status=${msg.status} step=${msg.step ?? '-'}${msg.error ? ` error=${msg.error}` : ''}`;

		this.status = msg.status;
		this.error = msg.error ?? null;
		this.action = msg.action;
		this.installedVersion = msg.installedVersion;

		const incoming = msg.step ?? null;
		if (incoming !== null) {
			const curIdx = this.step ? STEP_ORDER.indexOf(this.step) : -1;
			const newIdx = STEP_ORDER.indexOf(incoming);
			if (newIdx >= curIdx) this.step = incoming;
		}

		if (msg.status === 'ready' || msg.status === 'failed') {
			this.#log.debug`terminal ${this.tag} status=${msg.status}`;
			this.disconnect();
		}
	}

	async triggerParse(name: string, version: string) {
		this.#log.info`triggerParse ${name}@${version}`;
		this.status = 'processing';
		this.error = null;
		this.step = null;

		this.connect(name, version);

		try {
			await triggerCrateParse({ name, version });
		} catch (err) {
			this.#log.error`triggerParse failed ${name}@${version}: ${String(err)}`;
			this.status = 'failed';
			this.error = err instanceof Error ? err.message : String(err);
		}
	}

	async retry(name: string, version: string) {
		this.#log.info`retry ${name}@${version}`;
		this.error = null;
		await this.triggerParse(name, version);
	}
}
