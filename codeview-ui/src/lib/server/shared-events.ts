/**
 * Shared Event Stream - Multiplexed SSE for CodeView
 *
 * Architecture:
 * - Single SSE connection per browser tab
 * - Client subscribes/unsubscribes to "channels" (e.g., crate status, progress)
 * - Server broadcasts updates to all clients subscribed to a channel
 *
 * Benefits:
 * - No 10-connection limit issues
 * - Lower overhead
 * - Easier to manage reconnection state
 */

import type { Logger } from '@logtape/logtape';

export interface ClientSubscription {
	clientId: string;
	tags: Set<string>;
	writer: WritableStreamDefaultWriter;
	lastActivity: number;
}

export interface SubscriptionMessage {
	type: 'subscribe' | 'unsubscribe' | 'ping';
	tags?: string[];
}

export interface BroadcastMessage {
	tag: string;
	data: unknown;
}

export class SharedEventStream {
	private clients = new Map<string, ClientSubscription>();
	private tagToClients = new Map<string, Set<string>>();
	private encoder = new TextEncoder();
	private cleanupInterval: ReturnType<typeof setInterval> | null = null;

	constructor(
		private log: Logger,
		private idleTimeoutMs = 120000, // 2 minutes
	) {
		this.startCleanupInterval();
	}

	private startCleanupInterval(): void {
		this.cleanupInterval = setInterval(() => {
			this.cleanupIdleClients();
		}, 30000); // Check every 30s
	}

	private cleanupIdleClients(): void {
		const now = Date.now();
		for (const [clientId, client] of this.clients) {
			if (now - client.lastActivity > this.idleTimeoutMs) {
				this.log.debug`cleaning up idle client ${clientId}`;
				this.removeClient(clientId);
			}
		}
	}

	/**
	 * Register a new client connection
	 */
	addClient(clientId: string, writer: WritableStreamDefaultWriter): void {
		this.log.debug`addClient ${clientId}`;

		// Remove existing client if any (shouldn't happen, but be safe)
		this.removeClient(clientId);

		this.clients.set(clientId, {
			clientId,
			tags: new Set(),
			writer,
			lastActivity: Date.now(),
		});
	}

	/**
	 * Remove a client and all its subscriptions
	 */
	removeClient(clientId: string): void {
		const client = this.clients.get(clientId);
		if (!client) return;

		this.log.debug`removeClient ${clientId} with ${String(client.tags.size)} tags`;

		// Remove from all tag subscriptions
		for (const tag of client.tags) {
			const clientsForTag = this.tagToClients.get(tag);
			if (clientsForTag) {
				clientsForTag.delete(clientId);
				if (clientsForTag.size === 0) {
					this.tagToClients.delete(tag);
				}
			}
		}

		// Close writer
		client.writer.close().catch(() => {});
		this.clients.delete(clientId);
	}

	/**
	 * Subscribe a client to tags
	 */
	subscribe(clientId: string, tags: string[]): void {
		const client = this.clients.get(clientId);
		if (!client) {
			this.log.warn`subscribe: client ${clientId} not found`;
			return;
		}

		client.lastActivity = Date.now();

		for (const tag of tags) {
			if (client.tags.has(tag)) continue;

			client.tags.add(tag);

			let clientsForTag = this.tagToClients.get(tag);
			if (!clientsForTag) {
				clientsForTag = new Set();
				this.tagToClients.set(tag, clientsForTag);
			}
			clientsForTag.add(clientId);
		}

		this.log
			.debug`subscribe ${clientId} to [${tags.join(', ')}] - now subscribed to ${String(client.tags.size)} tags`;
	}

	/**
	 * Unsubscribe a client from tags
	 */
	unsubscribe(clientId: string, tags: string[]): void {
		const client = this.clients.get(clientId);
		if (!client) return;

		client.lastActivity = Date.now();

		for (const tag of tags) {
			if (!client.tags.has(tag)) continue;

			client.tags.delete(tag);

			const clientsForTag = this.tagToClients.get(tag);
			if (clientsForTag) {
				clientsForTag.delete(clientId);
				if (clientsForTag.size === 0) {
					this.tagToClients.delete(tag);
				}
			}
		}

		this.log
			.debug`unsubscribe ${clientId} from [${tags.join(', ')}] - now subscribed to ${String(client.tags.size)} tags`;
	}

	/**
	 * Update activity timestamp for a client (called on ping)
	 */
	ping(clientId: string): void {
		const client = this.clients.get(clientId);
		if (client) {
			client.lastActivity = Date.now();
		}
	}

	/**
	 * Broadcast a message to all clients subscribed to a tag
	 */
	async broadcast(tag: string, data: unknown): Promise<void> {
		const clientsForTag = this.tagToClients.get(tag);
		if (!clientsForTag || clientsForTag.size === 0) return;

		const payload = JSON.stringify({ tag, data });
		const chunk = this.encoder.encode(`data: ${payload}\n\n`);

		this.log.debug`broadcast ${tag} to ${String(clientsForTag.size)} client(s)`;

		const deadClients: string[] = [];

		for (const clientId of clientsForTag) {
			const client = this.clients.get(clientId);
			if (!client) {
				deadClients.push(clientId);
				continue;
			}

			try {
				await client.writer.write(chunk);
			} catch {
				deadClients.push(clientId);
			}
		}

		// Clean up dead clients
		for (const clientId of deadClients) {
			this.log.debug`removing dead client ${clientId}`;
			this.removeClient(clientId);
		}
	}

	/**
	 * Send a direct message to a specific client
	 */
	async sendToClient(clientId: string, data: unknown): Promise<boolean> {
		const client = this.clients.get(clientId);
		if (!client) return false;

		const payload = JSON.stringify(data);
		const chunk = this.encoder.encode(`data: ${payload}\n\n`);

		try {
			await client.writer.write(chunk);
			return true;
		} catch {
			this.removeClient(clientId);
			return false;
		}
	}

	/**
	 * Get stats for debugging
	 */
	getStats(): { clients: number; subscriptions: number } {
		let totalSubscriptions = 0;
		for (const client of this.clients.values()) {
			totalSubscriptions += client.tags.size;
		}
		return {
			clients: this.clients.size,
			subscriptions: totalSubscriptions,
		};
	}

	/**
	 * Clean up all resources
	 */
	destroy(): void {
		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval);
			this.cleanupInterval = null;
		}

		for (const clientId of this.clients.keys()) {
			this.removeClient(clientId);
		}
	}
}
