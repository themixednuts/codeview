import { getLogger } from "#lib/log.js";
import { connect } from "$realtime";
import type { ParseQueueEntry } from "#lib/server/provider.js";
import type { RealtimeClient } from "./types";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

export class QueueStatusConnection implements Disposable {
  active = $state.raw<ParseQueueEntry[]>([]);
  recent = $state.raw<ParseQueueEntry[]>([]);
  received = $state(false);

  #client: RealtimeClient = connect();
  #log = getLogger("queue-status");
  #tag: string | null = null;
  #callback = (data: Schema.Json) => this.#onData(data);

  connect(ecosystem = "rust") {
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

  #onData(data: Schema.Json) {
    if (!Predicate.isObject(data)) return;
    const type = "type" in data && Predicate.isString(data.type) ? data.type : undefined;
    if (type && type !== "queue") return;
    if (!("active" in data) || !("recent" in data)) return;
    if (!Array.isArray(data.active) || !Array.isArray(data.recent)) return;

    const active =
      Option.getOrUndefined(
        Schema.decodeUnknownOption(Schema.Array(QueueStatusSnapshotSchema))(data.active),
      ) ?? [];
    const recent =
      Option.getOrUndefined(
        Schema.decodeUnknownOption(Schema.Array(QueueStatusSnapshotSchema))(data.recent),
      ) ?? [];
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

const QueueStatusSnapshotSchema = Schema.Struct({
  kind: Schema.Literals(["crate", "sysroot"]),
  name: Schema.String,
  version: Schema.String,
  status: Schema.Literals(["unknown", "processing", "ready", "failed"]),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  step: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
  requestId: Schema.optionalKey(Schema.String),
  workflowId: Schema.optionalKey(Schema.String),
  githubRunId: Schema.optionalKey(Schema.String),
  githubRunUrl: Schema.optionalKey(Schema.String),
  requestedBy: Schema.optionalKey(
    Schema.Struct({
      provider: Schema.Literal("github"),
      id: Schema.String,
      login: Schema.String,
      avatarUrl: Schema.optionalKey(Schema.String),
    }),
  ),
});

type QueueStatusSnapshot = typeof QueueStatusSnapshotSchema.Type;

function toQueueEntry(status: QueueStatusSnapshot, position?: number): ParseQueueEntry {
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
