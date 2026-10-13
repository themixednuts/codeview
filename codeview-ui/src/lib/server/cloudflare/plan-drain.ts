/**
 * Pure helpers for the hosted planned-parse drain (parse-worker.ts).
 *
 * The daily `parse.yml` run drains the first `shard_drain_limit` items of
 * every shard bucket itself; the hosted queue dispatches everything else in
 * the plan, one GitHub run per crate, as capacity frees up.
 */

/**
 * How long items the daily shards will drain stay reserved for them. Shards
 * run 45 minutes each, four at a time across eight buckets; after this window
 * anything they left behind is fair game for the hosted queue.
 */
export const SHARD_RESERVATION_MS = 3 * 60 * 60 * 1000;

const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const U64_MASK = 0xffffffffffffffffn;
const utf8 = new TextEncoder();

/** FNV-1a 64-bit. Matches `publisher::shards::fnv1a64` in codeview-cli. */
export function fnv1a64(value: string): bigint {
  let hash = FNV64_OFFSET;
  for (const byte of utf8.encode(value)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV64_PRIME) & U64_MASK;
  }
  return hash;
}

/** Matches `publisher::shards::work_bucket`, which `cron parse-shard` filters on. */
export function workBucket(workId: string, shardCount: number): number {
  return Number(fnv1a64(workId) % BigInt(shardCount));
}

export type ShardReservationInput = {
  generatedAt: string;
  shardCount: number | undefined;
  shardDrainLimit: number | undefined;
  workIds: ReadonlyArray<string | undefined>;
};

/**
 * Indices of plan items the daily shards will drain themselves, while the
 * reservation window is open. Shards take items in plan order within their
 * bucket, so the first `shardDrainLimit` per bucket are theirs.
 */
export function shardReservedIndices(plan: ShardReservationInput, now = Date.now()): Set<number> {
  const reserved = new Set<number>();
  const { shardCount, shardDrainLimit } = plan;
  if (!shardCount || shardCount < 1 || !shardDrainLimit || shardDrainLimit < 1) return reserved;
  const generatedAt = Date.parse(plan.generatedAt);
  if (!Number.isFinite(generatedAt) || now - generatedAt >= SHARD_RESERVATION_MS) return reserved;
  const taken = Array.from({ length: shardCount }, () => 0);
  plan.workIds.forEach((workId, index) => {
    if (!workId) return;
    const bucket = workBucket(workId, shardCount);
    if (taken[bucket]! < shardDrainLimit) {
      taken[bucket]! += 1;
      reserved.add(index);
    }
  });
  return reserved;
}
