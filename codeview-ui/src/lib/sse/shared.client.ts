import type { RealtimeCallback, RealtimeClient } from "#lib/realtime/types.js";
import { getLogger } from "#lib/log.js";
import { SSEConnection, type SSEEndReason } from "./connection";
import * as Predicate from "effect/Predicate";
import type { Json, JsonObject } from "effect/Schema";

function isJsonObject(value: Json): value is JsonObject {
  return Predicate.isObject(value);
}

/**
 * Shared Event Connection - Single SSE connection with multiplexed subscriptions
 *
 * Replaces multiple per-crate connections with one shared connection.
 * Subscriptions are managed via POST /api/events/subscribe
 */
export class Client extends SSEConnection implements RealtimeClient {
  private subscriptions = new Map<string, Set<RealtimeCallback>>();
  private clientId: string | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private pendingSubscriptions = new Set<string>();
  private subscribedTags = new Set<string>();

  protected readonly log = getLogger("shared-events");

  protected get tag() {
    return "shared";
  }

  protected get endpoint() {
    return "/api/events/sse";
  }

  /**
   * Subscribe to a tag. Creates the shared connection if needed.
   */
  async subscribe(tag: string, callback: RealtimeCallback): Promise<void> {
    // Add callback to subscriptions
    let callbacks = this.subscriptions.get(tag);
    if (!callbacks) {
      callbacks = new Set();
      this.subscriptions.set(tag, callbacks);
    }
    callbacks.add(callback);

    // If already connected and subscribed, nothing to do
    if (this.subscribedTags.has(tag)) {
      return;
    }

    // Mark as pending subscription
    this.pendingSubscriptions.add(tag);

    // Ensure connection is open
    if (!this.connected) {
      this.open();
    }

    // Wait for connection and then subscribe
    await this.waitForConnection();
    await this.sendSubscribe([tag]);
  }

  /**
   * Unsubscribe from a tag.
   */
  async unsubscribe(tag: string, callback: RealtimeCallback): Promise<void> {
    const callbacks = this.subscriptions.get(tag);
    if (!callbacks) return;

    callbacks.delete(callback);

    // If no more callbacks for this tag, unsubscribe from server
    if (callbacks.size === 0) {
      this.subscriptions.delete(tag);

      if (this.subscribedTags.has(tag)) {
        await this.sendUnsubscribe([tag]);
        this.subscribedTags.delete(tag);
      }
      this.pendingSubscriptions.delete(tag);
    }
  }

  /**
   * Check if connected and subscribed to a tag.
   */
  isSubscribed(tag: string): boolean {
    return this.subscribedTags.has(tag);
  }

  /**
   * Wait for connection to be established.
   */
  private async waitForConnection(): Promise<void> {
    if (this.connected && this.clientId) return;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Connection timeout"));
      }, 10000);

      const checkConnection = () => {
        if (this.connected && this.clientId) {
          clearTimeout(timeout);
          resolve();
        } else {
          setTimeout(checkConnection, 50);
        }
      };
      checkConnection();
    });
  }

  /**
   * Send subscribe request to server.
   */
  private async sendSubscribe(tags: string[]): Promise<void> {
    if (!this.clientId) return;

    try {
      const response = await fetch("/api/events/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: this.clientId,
          action: "subscribe",
          tags,
        }),
      });

      if (!response.ok) {
        this.log.warn`subscribe failed: ${response.status}`;
        return;
      }

      // Mark tags as subscribed
      for (const tag of tags) {
        this.pendingSubscriptions.delete(tag);
        this.subscribedTags.add(tag);
      }

      // Apply initialData immediately (server returns current state for each tag)
      // SAFETY: subscribe responses are JSON objects with an optional initialData map.
      const parsed = (await response.json().catch(() => null)) as Json | null;
      if (!isJsonObject(parsed) || !isJsonObject(parsed.initialData)) {
        return;
      }

      const initialData = parsed.initialData;
      for (const tag of Object.keys(initialData)) {
        if (!Object.hasOwn(initialData, tag)) continue;
        const data = initialData[tag];
        if (data === null || data === undefined) continue;
        const callbacks = this.subscriptions.get(tag);
        if (!callbacks) continue;
        for (const cb of callbacks) {
          try {
            cb(data);
          } catch (err) {
            this.log.error`initialData callback error for ${tag}: ${String(err)}`;
          }
        }
      }
    } catch (err) {
      this.log.error`subscribe error: ${String(err)}`;
    }
  }

  /**
   * Send unsubscribe request to server.
   */
  private async sendUnsubscribe(tags: string[]): Promise<void> {
    if (!this.clientId) return;

    try {
      await fetch("/api/events/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: this.clientId,
          action: "unsubscribe",
          tags,
        }),
      });
    } catch (err) {
      this.log.error`unsubscribe error: ${String(err)}`;
    }
  }

  /**
   * Send ping to keep connection alive.
   */
  private async sendPing(): Promise<void> {
    if (!this.clientId) return;

    try {
      await fetch("/api/events/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: this.clientId,
          action: "ping",
        }),
      });
    } catch (err) {
      this.log.debug`ping failed: ${String(err)}`;
    }
  }

  protected onData(data: Json): void {
    if (!isJsonObject(data)) return;

    if (
      "type" in data &&
      data.type === "connected" &&
      "clientId" in data &&
      Predicate.isString(data.clientId)
    ) {
      this.clientId = data.clientId;
      this.log.debug`connected with clientId=${data.clientId}`;

      if (this.pendingSubscriptions.size > 0) {
        this.sendSubscribe(Array.from(this.pendingSubscriptions));
      }
      return;
    }

    if (!("tag" in data) || !Predicate.isString(data.tag)) return;
    const callbacks = this.subscriptions.get(data.tag);
    if (!callbacks) return;
    const payload = "data" in data ? data.data : null;
    for (const callback of callbacks) {
      try {
        callback(payload);
      } catch (err) {
        this.log.error`callback error for ${data.tag}: ${String(err)}`;
      }
    }
  }

  protected override onStreamReady(): void {
    this.log.debug`stream ready`;

    // Start ping interval
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }
    this.pingInterval = setInterval(() => {
      this.sendPing();
    }, 30000); // Ping every 30s
  }

  protected override onStreamEnd(reason: SSEEndReason, detail?: string): void {
    this.log.debug`stream ended: ${reason}${detail ? ` (${detail})` : ""}`;

    // Clear ping interval
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    // Reset state
    this.clientId = null;
    this.subscribedTags.clear();

    // Reconnection will happen automatically via SSEConnection
    // When reconnected, we'll need to resubscribe to all tags
    for (const tag of this.subscriptions.keys()) {
      this.pendingSubscriptions.add(tag);
    }
  }

  override destroy(): void {
    // Unsubscribe from all tags
    if (this.clientId && this.subscribedTags.size > 0) {
      this.sendUnsubscribe(Array.from(this.subscribedTags));
    }

    // Clear ping interval
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    // Clear subscriptions
    this.subscriptions.clear();
    this.pendingSubscriptions.clear();
    this.subscribedTags.clear();
    this.clientId = null;

    // Call parent destroy
    super.destroy();
  }
}

// Global singleton - one shared connection per browser tab
let globalSharedConnection: Client | null = null;

export function connect(): Client {
  if (!globalSharedConnection) {
    globalSharedConnection = new Client();
  }
  return globalSharedConnection;
}
