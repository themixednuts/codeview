import { describe, expect, test } from "vite-plus/test";
import { SHARD_RESERVATION_MS, fnv1a64, shardReservedIndices, workBucket } from "./plan-drain";

describe("plan drain helpers", () => {
  test("fnv1a64 matches the published FNV-1a 64 vectors used by codeview-cli", () => {
    expect(fnv1a64("")).toBe(0xcbf29ce484222325n);
    expect(fnv1a64("a")).toBe(0xaf63dc4c8601ec8cn);
    expect(fnv1a64("foobar")).toBe(0x85944171f73967e8n);
  });

  test("workBucket matches codeview-cli work_bucket", () => {
    // Pinned in codeview-cli publisher/shards.rs too.
    expect(workBucket("crate:serde:1.0.228:default", 8)).toBe(1);
    expect(workBucket("crate:syn:3.0.9:default", 8)).toBe(3);
  });

  test("reserves the first shardDrainLimit items of each bucket during the window", () => {
    const workIds = Array.from({ length: 40 }, (_, i) => `crate:c${i}:1.0.0:default`);
    const generatedAt = "2026-10-13T03:00:00Z";
    const now = Date.parse(generatedAt) + 60_000;
    const reserved = shardReservedIndices(
      { generatedAt, shardCount: 4, shardDrainLimit: 2, workIds },
      now,
    );
    expect(reserved.size).toBe(8);
    const perBucket = new Map<number, number[]>();
    workIds.forEach((id, index) => {
      const bucket = workBucket(id, 4);
      perBucket.set(bucket, [...(perBucket.get(bucket) ?? []), index]);
    });
    for (const indices of perBucket.values()) {
      expect(indices.slice(0, 2).every((index) => reserved.has(index))).toBe(true);
      expect(indices.slice(2).some((index) => reserved.has(index))).toBe(false);
    }
  });

  test("releases reservations after the window or when the plan has no drain limit", () => {
    const workIds = ["crate:a:1.0.0:default", "crate:b:1.0.0:default"];
    const generatedAt = "2026-10-13T03:00:00Z";
    const late = Date.parse(generatedAt) + SHARD_RESERVATION_MS;
    expect(
      shardReservedIndices({ generatedAt, shardCount: 2, shardDrainLimit: 1, workIds }, late).size,
    ).toBe(0);
    expect(
      shardReservedIndices(
        { generatedAt, shardCount: 2, shardDrainLimit: undefined, workIds },
        Date.parse(generatedAt),
      ).size,
    ).toBe(0);
  });
});
