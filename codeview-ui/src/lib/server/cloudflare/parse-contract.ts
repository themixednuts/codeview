import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { CrateStatus } from "../provider";

export const PARSE_REQUEST_SCHEMA_VERSION = 1;
export const PARSE_STATUS_OBJECT_NAME = "rust";

export type ParseRequestKind = "crate" | "sysroot";

export type ParseRequestSource = "ui" | "manual" | "planned";

export type ParseRequestActor = {
  provider: "github";
  id: string;
  login: string;
  avatarUrl?: string;
};

export type ParseRequestMessage = {
  schemaVersion: typeof PARSE_REQUEST_SCHEMA_VERSION;
  ecosystem: "rust";
  kind: ParseRequestKind;
  name: string;
  version: string;
  force: boolean;
  requestId: string;
  requestedAt: string;
  source: ParseRequestSource;
  requestedBy?: ParseRequestActor;
};

export type ParseWorkflowParams = ParseRequestMessage & {
  callbackBaseUrl?: string;
};

export type ParseCompletionPayload = {
  schemaVersion: 1;
  kind?: ParseRequestKind;
  workflowId: string;
  requestId: string;
  name: string;
  version: string;
  ok: boolean;
  runId?: string;
  runUrl?: string;
  error?: string;
  completedAt: string;
};

export type StoredParseStatus = CrateStatus & {
  ecosystem: "rust";
  kind: ParseRequestKind;
  name: string;
  version: string;
  requestId?: string;
  workflowId?: string;
  githubRunId?: string;
  githubRunUrl?: string;
  requestedBy?: ParseRequestActor;
  createdAt: string;
  updatedAt: string;
  sequence: number;
};

export type ParseQueueSnapshot = {
  active: StoredParseStatus[];
  recent: StoredParseStatus[];
};

export type BeginParseResponse = {
  accepted: boolean;
  leased: boolean;
  workflowId: string;
  retryAfterSeconds?: number;
  status: StoredParseStatus;
};

export type QueueParseResponse = {
  accepted: boolean;
  status: StoredParseStatus;
};

export type ParseStatusEvent = {
  kind?: ParseRequestKind;
  name: string;
  version: string;
  status: CrateStatus["status"];
  step?: string;
  error?: string;
  action?: CrateStatus["action"];
  requestId?: string;
  workflowId?: string;
  githubRunId?: string;
  githubRunUrl?: string;
  requestedBy?: ParseRequestActor;
};

export function crateStatusTag(name: string, version: string): string {
  return `rust:${name}:${version}`;
}

export function parseStatusObject(namespace: DurableObjectNamespace): DurableObjectStub {
  const id = namespace.idFromName(PARSE_STATUS_OBJECT_NAME);
  return namespace.get(id);
}

export async function registerQueuedParseRequest(
  namespace: DurableObjectNamespace,
  message: ParseRequestMessage,
): Promise<QueueParseResponse> {
  const response = await parseStatusObject(namespace).fetch("https://status/queued", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(message),
  });
  if (!response.ok) {
    throw new Error(`parse queue registration failed: ${response.status}`);
  }
  const value: unknown = await response.json();
  // SAFETY: PARSE_STATUS Durable Object /queued returns QueueParseResponse that this worker just serialized.
  return value as QueueParseResponse;
}

export function shouldAcceptQueuedParseRequest(
  existing: StoredParseStatus | null,
  message: ParseRequestMessage,
): boolean {
  if (!existing) return true;
  if (existing.status === "processing") return false;
  const requestedAt = Date.parse(message.requestedAt);
  const existingUpdatedAt = Date.parse(existing.updatedAt);
  return (
    Number.isFinite(requestedAt) &&
    (!Number.isFinite(existingUpdatedAt) || requestedAt > existingUpdatedAt)
  );
}

export function parseWorkflowId(requestId: string): string {
  return `parse-${requestId}`;
}

export function makeParseRequest(
  name: string,
  version: string,
  force: boolean,
  source: ParseRequestSource = "ui",
  kind: ParseRequestKind = "crate",
  requestedBy?: ParseRequestActor,
): ParseRequestMessage {
  const requestId =
    globalThis.crypto !== undefined && "randomUUID" in globalThis.crypto
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return {
    schemaVersion: PARSE_REQUEST_SCHEMA_VERSION,
    ecosystem: "rust",
    kind,
    name,
    version,
    force,
    requestId,
    requestedAt: new Date().toISOString(),
    source,
    requestedBy,
  };
}

const ParseRequestActorSchema = Schema.Struct({
  provider: Schema.Literal("github"),
  id: Schema.String.check(Schema.isMinLength(1)),
  login: Schema.String.check(Schema.isMinLength(1)),
  avatarUrl: Schema.optionalKey(Schema.String),
});

const ParseRequestMessageSchema = Schema.Struct({
  schemaVersion: Schema.Literal(PARSE_REQUEST_SCHEMA_VERSION),
  ecosystem: Schema.Literal("rust"),
  kind: Schema.Literals(["crate", "sysroot"]),
  name: Schema.String.check(Schema.isMinLength(1)),
  version: Schema.String.check(Schema.isMinLength(1)),
  force: Schema.Boolean,
  requestId: Schema.String.check(Schema.isMinLength(1)),
  requestedAt: Schema.String,
  source: Schema.Literals(["ui", "manual", "planned"]),
  requestedBy: Schema.optionalKey(ParseRequestActorSchema),
});

export function isParseRequestMessage(value: Schema.Json): value is ParseRequestMessage {
  const candidate = Option.getOrUndefined(
    Schema.decodeUnknownOption(ParseRequestMessageSchema)(value),
  );
  return candidate !== undefined && Number.isFinite(Date.parse(candidate.requestedAt));
}
