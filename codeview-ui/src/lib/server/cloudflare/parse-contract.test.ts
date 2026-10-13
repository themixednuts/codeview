import { describe, expect, test } from "vite-plus/test";
import * as Effect from "effect/Effect";
import {
  isParseWorkerTaskMessage,
  isRecentPermanentFailure,
  listParsePlanKeys,
  makeParseRequest,
  PARSE_WORKER_TASK_SCHEMA_VERSION,
  ORPHANED_PROCESSING_MS,
  PERMANENT_FAILURE_COOLDOWN_MS,
  PERMANENT_FAILURE_STEP,
  shouldAcceptQueuedParseRequest,
  type StoredParseStatus,
} from "./parse-contract";

function storedStatus(
  status: StoredParseStatus["status"],
  updatedAt = "2026-07-09T12:00:00.000Z",
): StoredParseStatus {
  return {
    ecosystem: "rust",
    kind: "crate",
    name: "serde",
    version: "1.0.228",
    status,
    createdAt: "2026-07-09T11:00:00.000Z",
    updatedAt,
    sequence: 1,
  };
}

describe("queued parse registration", () => {
  test("accepts work with no existing status", () => {
    expect(shouldAcceptQueuedParseRequest(null, makeParseRequest("serde", "1.0.228", false))).toBe(
      true,
    );
  });

  test("does not replace active work", () => {
    const existing = storedStatus("processing");
    expect(
      shouldAcceptQueuedParseRequest(
        existing,
        makeParseRequest("serde", "1.0.228", true),
        Date.parse(existing.updatedAt) + 60_000,
      ),
    ).toBe(false);
  });

  test("replaces orphaned active work past the callback window", () => {
    const existing = storedStatus("processing");
    expect(
      shouldAcceptQueuedParseRequest(
        existing,
        makeParseRequest("serde", "1.0.228", false),
        Date.parse(existing.updatedAt) + ORPHANED_PROCESSING_MS + 1,
      ),
    ).toBe(true);
  });

  test("replaces an older terminal status", () => {
    expect(
      shouldAcceptQueuedParseRequest(
        storedStatus("ready", "2020-01-01T00:00:00.000Z"),
        makeParseRequest("serde", "1.0.228", false),
      ),
    ).toBe(true);
  });

  test("rejects a delayed registration older than the terminal status", () => {
    const request = {
      ...makeParseRequest("serde", "1.0.228", false),
      requestedAt: "2026-07-09T11:59:59.000Z",
    };
    expect(shouldAcceptQueuedParseRequest(storedStatus("failed"), request)).toBe(false);
  });

  test("blocks non-forced requests for a recent permanent failure, but not admin force", () => {
    const existing = { ...storedStatus("failed"), step: PERMANENT_FAILURE_STEP };
    const later = Date.parse(existing.updatedAt) + 60 * 60 * 1000;
    const visit = {
      ...makeParseRequest("serde", "1.0.228", false),
      requestedAt: new Date(later).toISOString(),
    };
    const forced = { ...visit, force: true };
    expect(shouldAcceptQueuedParseRequest(existing, visit, later)).toBe(false);
    expect(shouldAcceptQueuedParseRequest(existing, forced, later)).toBe(true);
    expect(isRecentPermanentFailure(existing, later)).toBe(true);
  });

  test("lets a permanent failure be retried after the cooldown", () => {
    const existing = { ...storedStatus("failed"), step: PERMANENT_FAILURE_STEP };
    const later = Date.parse(existing.updatedAt) + PERMANENT_FAILURE_COOLDOWN_MS + 1;
    const visit = {
      ...makeParseRequest("serde", "1.0.228", false),
      requestedAt: new Date(later).toISOString(),
    };
    expect(shouldAcceptQueuedParseRequest(existing, visit, later)).toBe(true);
  });
});

describe("parse worker task messages", () => {
  test("accepts cron maintenance tasks", () => {
    expect(
      isParseWorkerTaskMessage({
        schemaVersion: PARSE_WORKER_TASK_SCHEMA_VERSION,
        task: "drain-planned",
        enqueuedAt: "2026-08-20T00:00:00.000Z",
        pressure: {
          statusActive: 1,
          githubActive: 2,
          actionsInUse: 2,
          capacityReliable: true,
        },
      }),
    ).toBe(true);
  });

  test("accepts a delayed drain task that reads pressure when it runs", () => {
    expect(
      isParseWorkerTaskMessage({
        schemaVersion: PARSE_WORKER_TASK_SCHEMA_VERSION,
        task: "drain-planned",
        enqueuedAt: "2026-10-13T08:00:00.000Z",
      }),
    ).toBe(true);
  });

  test("rejects parse requests as worker tasks", () => {
    expect(isParseWorkerTaskMessage(makeParseRequest("serde", "1.0.228", false))).toBe(false);
  });
});

describe("listParsePlanKeys", () => {
  test("lists run prefixes instead of every object under rust/_runs/", async () => {
    const listed: R2ListOptions[] = [];
    const bucket = {
      async list(options?: R2ListOptions) {
        listed.push(options ?? {});
        return {
          objects: [],
          delimitedPrefixes: ["rust/_runs/111-1/", "rust/_runs/999-1/"],
          truncated: false,
        };
      },
    };

    await expect(Effect.runPromise(listParsePlanKeys(bucket))).resolves.toEqual([
      { key: "rust/_runs/999-1/plan.json" },
      { key: "rust/_runs/111-1/plan.json" },
    ]);
    expect(listed).toEqual([
      { prefix: "rust/_runs/", delimiter: "/", limit: 200, cursor: undefined },
    ]);
  });
});
