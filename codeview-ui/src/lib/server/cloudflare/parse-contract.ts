import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { CrateStatus } from "../provider";

export const PARSE_REQUEST_SCHEMA_VERSION = 1;
export const PARSE_STATUS_OBJECT_NAME = "rust";
export const LATEST_PLAN_POINTER_KEY = "rust/_index/latest-plan.json";
export const PLAN_RUNS_PREFIX = "rust/_runs/";

export const PlanKeyCandidate = Schema.Struct({
  key: Schema.String.check(Schema.isMinLength(1)),
  uploaded: Schema.optionalKey(Schema.String),
});
export interface PlanKeyCandidate extends Schema.Schema.Type<typeof PlanKeyCandidate> {}

export const LatestPlanPointer = Schema.Struct({
  key: Schema.String.check(Schema.isMinLength(1)),
  run_id: Schema.optionalKey(Schema.String),
  generated_at: Schema.optionalKey(Schema.String),
});
export interface LatestPlanPointer extends Schema.Schema.Type<typeof LatestPlanPointer> {}

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

type PlanListPage = {
  objects: ReadonlyArray<{ key: string; uploaded?: Date }>;
  delimitedPrefixes: readonly string[];
  truncated: boolean;
  cursor?: string;
};

export const listParsePlanKeys = Effect.fn("ParseContract.listParsePlanKeys")(function* (
  bucket: { list: (options?: R2ListOptions) => PromiseLike<PlanListPage> },
  maxKeys = 200,
) {
  const candidates: PlanKeyCandidate[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = yield* Effect.tryPromise({
      try: () =>
        bucket.list({
          prefix: PLAN_RUNS_PREFIX,
          delimiter: "/",
          limit: Math.min(1000, Math.max(1, maxKeys - candidates.length)),
          cursor,
        }),
      catch: (cause) => new Error(`plan prefix list failed: ${String(cause)}`),
    });
    for (const prefix of page.delimitedPrefixes) {
      const key = `${prefix}plan.json`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ key });
      if (candidates.length >= maxKeys) break;
    }
    if (candidates.length >= maxKeys) break;
    for (const object of page.objects) {
      if (!object.key.endsWith("/plan.json") || seen.has(object.key)) continue;
      seen.add(object.key);
      candidates.push({
        key: object.key,
        uploaded: object.uploaded?.toISOString(),
      });
      if (candidates.length >= maxKeys) break;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && candidates.length < maxKeys);
  return candidates.sort(comparePlanKeyCandidates);
});

function comparePlanKeyCandidates(left: PlanKeyCandidate, right: PlanKeyCandidate): number {
  const uploaded = (right.uploaded ?? "").localeCompare(left.uploaded ?? "");
  if (uploaded !== 0) return uploaded;
  return (
    comparePlanRunIds(planKeyRunId(right.key), planKeyRunId(left.key)) ||
    right.key.localeCompare(left.key)
  );
}

function planKeyRunId(key: string): string {
  if (!key.startsWith(PLAN_RUNS_PREFIX)) return key;
  const rest = key.slice(PLAN_RUNS_PREFIX.length);
  const slash = rest.indexOf("/");
  return slash === -1 ? rest : rest.slice(0, slash);
}

function comparePlanRunIds(left: string, right: string): number {
  const leftRun = parseGithubRunId(left);
  const rightRun = parseGithubRunId(right);
  if (leftRun && rightRun) return leftRun.run - rightRun.run || leftRun.attempt - rightRun.attempt;
  if (leftRun) return 1;
  if (rightRun) return -1;
  return left.localeCompare(right);
}

function parseGithubRunId(id: string): { run: number; attempt: number } | null {
  const match = /^(\d+)-(\d+)$/.exec(id);
  if (!match) return null;
  return { run: Number(match[1]), attempt: Number(match[2]) };
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

export const PARSE_WORKER_TASK_SCHEMA_VERSION = 2;

export type ParseWorkerTaskKind = "reconcile-finalizing" | "reconcile-stale" | "drain-planned";

export type ParseDrainPressureSnapshot = {
  statusActive: number;
  githubActive: number;
  actionsInUse: number;
  capacityReliable: boolean;
  capacityReason?: string;
};

export type ParseWorkerTaskMessage = {
  schemaVersion: typeof PARSE_WORKER_TASK_SCHEMA_VERSION;
  task: ParseWorkerTaskKind;
  enqueuedAt: string;
  pressure: ParseDrainPressureSnapshot;
  reconcileCursor?: number;
};

const ParseDrainPressureSnapshotSchema = Schema.Struct({
  statusActive: Schema.Number,
  githubActive: Schema.Number,
  actionsInUse: Schema.Number,
  capacityReliable: Schema.Boolean,
  capacityReason: Schema.optionalKey(Schema.String),
});

const ParseWorkerTaskMessageSchema = Schema.Struct({
  schemaVersion: Schema.Literal(PARSE_WORKER_TASK_SCHEMA_VERSION),
  task: Schema.Literals(["reconcile-finalizing", "reconcile-stale", "drain-planned"]),
  enqueuedAt: Schema.String,
  pressure: ParseDrainPressureSnapshotSchema,
  reconcileCursor: Schema.optionalKey(Schema.Number),
});

export function isParseWorkerTaskMessage(value: Schema.Json): value is ParseWorkerTaskMessage {
  const candidate = Option.getOrUndefined(
    Schema.decodeUnknownOption(ParseWorkerTaskMessageSchema)(value),
  );
  return candidate !== undefined && Number.isFinite(Date.parse(candidate.enqueuedAt));
}

export function isKnownQueueMessage(value: Schema.Json): value is ParseRequestMessage | ParseWorkerTaskMessage {
  return isParseWorkerTaskMessage(value) || isParseRequestMessage(value);
}
