import { getLogger } from '#lib/log';
import { connect } from '$realtime';
import type { ParseQueueEntry } from '#lib/server/provider';
import type { StoredParseStatus } from '#lib/server/cloudflare/parse-contract';
import type { RealtimeClient } from './types';

interface QueueMessage {
	type?: string;
	active?: unknown;
	recent?: unknown;
}

export class QueueStatusConnection implements Disposable {
	active = $state.raw<ParseQueueEntry[]>([]);
	recent = $state.raw<ParseQueueEntry[]>([]);
	received = $state(false);

	#client: RealtimeClient = connect();
	#log = getLogger('queue-status');
	#tag: string | null = null;
	#callback = (data: unknown) => this.#onData(data as QueueMessage);

	connect(ecosystem = 'rust') {
		const tag = `queue:${ecosystem}`;
		if (this.#tag === tag) return;
		this.disconnect();
		this.#tag = tag;
		this.#client.subscribe(tag, this.#callback);
	}

	disconnect() {
		if (!this.#tag) return;
		this.#client.unsubscribe(this.#tag, this.#callback);
		this.#tag = null;
	}

	#onData(message: QueueMessage) {
		if (message.type && message.type !== 'queue') return;
		if (!Array.isArray(message.active) || !Array.isArray(message.recent)) return;

		const active = message.active.filter(isStoredParseStatus);
		const recent = message.recent.filter(isStoredParseStatus);
		this.active = active.map((entry, index) => toQueueEntry(entry, index + 1));
		this.recent = recent.map((entry) => toQueueEntry(entry));
		this.received = true;
		this.#log.debug`queue snapshot active=${String(active.length)} recent=${String(recent.length)}`;
	}

	destroy() {
		this.disconnect();
	}

	[Symbol.dispose]() {
		this.destroy();
	}
}

function isStoredParseStatus(value: unknown): value is StoredParseStatus {
	if (!value || typeof value !== 'object') return false;
	const status = value as Partial<StoredParseStatus>;
	return (
		(status.kind === 'crate' || status.kind === 'sysroot') &&
		typeof status.name === 'string' &&
		typeof status.version === 'string' &&
		(status.status === 'unknown' ||
			status.status === 'processing' ||
			status.status === 'ready' ||
			status.status === 'failed') &&
		typeof status.createdAt === 'string' &&
		typeof status.updatedAt === 'string'
	);
}

function toQueueEntry(status: StoredParseStatus, position?: number): ParseQueueEntry {
	return {
		kind: status.kind,
		name: status.name,
		version: status.version,
		status: status.status,
		step: status.step,
		error: status.error,
		requestId: status.requestId,
		workflowId: status.workflowId,
		githubRunId: status.githubRunId,
		githubRunUrl: status.githubRunUrl,
		requestedBy: status.requestedBy,
		requestedAt: status.createdAt,
		updatedAt: status.updatedAt,
		position,
	};
}
