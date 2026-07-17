# Research: scheduling, fan-out, and queueing for static parse builds

Date: 2026-07-04

Scope: research and design only. This doc is grounded in `resources/research/parse-pipeline-current-state.md`, `.github/workflows/parse.yml`, and the current `codeview-cli/src/{cron,publisher}/` scheduling and R2 code. It does not propose hosted dynamic parsing.

## Sources

- GitHub Actions matrix, dynamic matrix, `max-parallel`, reusable workflow, concurrency, artifact, output, and limit docs:
  - https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
  - https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/run-job-variations
  - https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows
  - https://docs.github.com/actions/writing-workflows/choosing-what-your-workflow-does/control-the-concurrency-of-workflows-and-jobs
  - https://docs.github.com/en/actions/tutorials/store-and-share-data
  - https://docs.github.com/en/actions/reference/limits
  - https://docs.github.com/en/billing/concepts/product-billing/github-actions
- docs.rs rustdoc JSON docs: https://docs.rs/about/rustdoc-json
- rustdoc JSON/std component docs: https://doc.rust-lang.org/beta/rustdoc/unstable-features.html
- crates.io data access policy/RFC: https://rust-lang.github.io/rfcs/3463-crates-io-policy-update.html
- Cloudflare R2 consistency/pricing:
  - https://developers.cloudflare.com/r2/reference/consistency/
  - https://developers.cloudflare.com/r2/pricing/
- Cloudflare Queues overview, pull consumers, limits, retries, DLQ, and pricing:
  - https://developers.cloudflare.com/queues/
  - https://developers.cloudflare.com/queues/configuration/pull-consumers/
  - https://developers.cloudflare.com/queues/platform/limits/
  - https://developers.cloudflare.com/queues/configuration/batching-retries/
  - https://developers.cloudflare.com/queues/configuration/dead-letter-queues/
  - https://developers.cloudflare.com/queues/platform/pricing/
- Cloudflare D1 limit notes: https://developers.cloudflare.com/d1/reference/faq/

Anything about a safe docs.rs crawl rate is unverified. I found official docs for rustdoc JSON availability and URL shape, but not an explicit docs.rs crawler rate limit. Treat the proposed docs.rs rate settings as conservative defaults to confirm with docs.rs maintainers.

## 1. GitHub Actions constraints

The current workflow is artificially capped at `--max-crates 20` and `max-parallel: 10`. GitHub Actions can go much higher, but not by emitting one unbounded matrix item per crate.

Primary source refs for this section: GitHub workflow syntax for matrix/output/job timeout limits, GitHub run-variations docs for dynamic matrices and `max-parallel`, GitHub limits docs for hosted-runner concurrency, GitHub artifact docs for job-to-job artifacts, GitHub reusable workflow docs, GitHub concurrency docs, and GitHub Actions billing docs.

Relevant limits and behavior:

- A single matrix expands to at most 256 jobs per workflow run. This applies to GitHub-hosted and self-hosted runners.
- `strategy.max-parallel` only throttles how many matrix children run at once. It does not increase the 256 matrix expansion limit.
- Dynamic matrices are supported by passing JSON through a prior job output and using `fromJSON(...)`.
- Job outputs are capped at 1 MB per job and 50 MB total per workflow run, approximated as UTF-16. Large per-crate matrices or full work plans should move through artifacts or R2, not job outputs.
- Artifacts are the right primitive for passing larger files between jobs. `upload-artifact`/`download-artifact` can pass data across jobs, and retention can be shortened for ephemeral plan/report files.
- GitHub-hosted standard runner concurrency is plan-bound: Free 20, Pro 40, Team 60, Enterprise 500 concurrent jobs. Larger runners have separate limits.
- Standard GitHub-hosted jobs have a 6 hour execution limit. The full workflow run limit is much larger, but a single shard job must fit in 6 hours.
- Private-repo minutes are plan-bound. Current docs list 2,000/month for Free, 3,000/month for Pro/Team, and 50,000/month for Enterprise Cloud. Public repositories get standard GitHub-hosted runner minutes free.
- Reusable workflows can be invoked with `workflow_call`, including from matrix jobs. They reduce YAML duplication but do not remove the need to budget jobs, outputs, minutes, and upstream traffic.
- Concurrency groups should protect R2 finalization. Current GitHub docs include `queue: max`, which allows up to 100 pending runs in a concurrency group. Use this carefully; the default keeps only one pending run.

Real GHA ceiling:

```
daily_capacity ~= min(
  runner_parallelism * 1440 / avg_parse_minutes,
  matrix_jobs * floor((360 - startup_minutes) / avg_parse_minutes),
  docs_rs_politeness_budget_per_day,
  monthly_runner_minutes_remaining / avg_parse_minutes
)
```

With `runner_parallelism = 16`, `avg_parse_minutes = 2`, and shard jobs that run close to 6 hours, the mechanical ceiling is around 11,500 crates/day. That is not a recommendation. It is the platform upper bound before docs.rs politeness, paid minutes, R2 operations, and operational risk.

How to raise today's cap:

1. Stop emitting one matrix child per crate.
2. Emit a small matrix of worker or shard slots, for example 32, 64, or 128 jobs.
3. Let each job drain a deterministic shard or a durable queue for many crates, bounded by `--max-items` and `--max-duration-minutes`.
4. Build `codeview-cli` once, upload it as an artifact, and download it in parse jobs. Rebuilding the Rust binary in every matrix child will dominate minutes at high shard counts.
5. Pass shard matrices through job output, but pass full plans and shard reports via artifacts or R2.

## 2. Recommended scheduling model

Use two execution modes:

- Daily incremental: small, bounded, always safe to run. It updates std channels first, then high-value third-party crates, then eligible retries.
- Full backfill: manually triggered or separately scheduled. It walks the long tail over many runs with the same idempotent parse path.

### Corpus tiers

Use explicit tiers so the architect can select cost:

1. `std`: `std`, `core`, `alloc`, `proc_macro`, `test` across intended channels.
2. `top-500`: newest version of the top 500 crates by downloads.
3. `top-5000`: newest version of the top 5,000 crates by downloads.
4. `catalog`: crates already published in Codeview's catalog, for freshness maintenance.
5. `long-tail`: crates from the crates.io index or daily db dump not in the top-N set.
6. `full`: all selected crates. Open question: "all crates" likely means latest version per crate; all historical versions is a different and much larger product.

Do not crawl crates.io with one API call per crate. crates.io policy recommends the index first, then the daily db dump, and only then the API; direct API use requires a 1 request/second maximum and an identifying user agent. For top-N and full corpus planning, prefer the db dump or an offline-maintained corpus manifest.

### Priority ordering

Suggested priority sort:

1. Forced names from workflow dispatch.
2. Std channel work.
3. Top-download crates with parser/schema freshness changes.
4. Top-download crates with newer observed versions.
5. Catalog crates with parser/schema freshness changes.
6. Catalog crates with newer observed versions.
7. Eligible transient retries, ordered by priority tier and oldest `next_retry_at`.
8. Never-parsed top-N backfill.
9. Long-tail/full backfill.

Within a tier, sort by download rank, then canonical crate name for determinism. Permanent failures are excluded until parser revision, schema version, rustdoc format support, or the source crate version changes.

### Deterministic sharding

Shard by a stable work id:

```
work_id = "{kind}:{canonical_name}:{version}:{channel_or_target}"
bucket = fnv1a64(work_id) % shard_count
include if bucket == shard_index
```

Each shard job receives `--shard-index k --shard-count n` and processes only its bucket. This gives:

- no overlap between runners,
- stable resumption across runs,
- simple local reproduction,
- no need to pass huge crate lists through GHA outputs.

Use `--max-per-shard` for daily budgets. Example: 64 shards with `--max-per-shard 8` caps a run at 512 crates. Backfill can raise that to 40 or 100, bounded by 6 hour job runtime.

### Retry, backoff, and dead-letter handling

The existing parse exit codes are a good base:

- `0`: success or already fresh.
- `64`: transient. Retry later.
- `65`: permanent for the current parser/schema/source. Suppress until something material changes.
- `70`: internal bug. Fail the job and page a human.

Change/confirm error classification:

- docs.rs `429`, `408`, connection failures, timeouts, and `5xx` should be transient.
- docs.rs `404`/`410` for a crate/version JSON object should be permanent for that crate version, unless docs.rs rebuild availability changes.
- malformed gzip/zstd and unsupported `format_version` should be permanent until parser support changes.

Backoff policy:

```
attempt 1: next day
attempt 2: +2 days
attempt 3: +4 days
attempt 4: +7 days
attempt 5+: +14 days capped, with deterministic jitter
dead-letter: 7 consecutive transient attempts or 30 days without success
```

Dead-letter entries should remain visible in `rust/_index` aggregate metadata and be reportable through `codeview cron failures list`. A manual `requeue` command should clear or lower the backoff for selected crates.

### docs.rs politeness

docs.rs officially documents rustdoc JSON URLs and warns that older releases may 404 while rebuilds catch up. It also supports `.gz` and `.zst`; current code uses `.json.gz`, which is valid.

Source refs: docs.rs rustdoc JSON docs and rustdoc book unstable JSON/std component docs. No official docs.rs crawler rate limit was found.

Because I did not find an official docs.rs crawl rate, set conservative controls:

- Add `--docsrs-min-delay-ms` to shard/queue drains, default 10,000 to 30,000 ms per worker.
- Keep `max-parallel` modest, for example 8 to 16, until measured and cleared.
- Honor `Retry-After` if present.
- Include contact info in the user agent, not only `codeview-cron/{version}`.
- Prefer zstd later if it reduces bandwidth and CPU without complicating compatibility.

### Std channel coverage

Current `seed-std` is nightly-only and aliases `stable`, `beta`, and `latest` to nightly. That is not correct channel coverage.

The rustdoc book currently documents std JSON via `rust-docs-json` with a nightly toolchain command. Therefore stable/beta availability must be treated as unverified. The new std pipeline should fail visibly if the channel JSON cannot be obtained; it should not alias stable/beta to nightly as a silent substitute.

Proposed std behavior:

- `std-plan --channels stable,beta,nightly --crates std,core,alloc,proc_macro,test --strict-channels`
- For each channel, install the channel and attempt `rustup component add rust-docs-json --toolchain <channel>`.
- If stable/beta components are unavailable, write a channel status object and fail in strict mode.
- `parse-std-one --channel <channel> --toolchain <toolchain> --crate <crate>`
- Version aliases:
  - `stable` points only to artifacts produced from the stable toolchain/source.
  - `beta` points only to beta.
  - `nightly` points only to nightly.
  - `latest` should be a product decision, probably stable for public docs browsing.

If stable/beta JSON is not available from rustup, the architect needs to choose between nightly-only std for now, building channel std JSON from Rust source locally, or waiting for official components.

## 3. Proposed CLI shape

Keep the existing `parse-one` as the unit of publish work. Add orchestration commands around it.

New or changed commands:

```
codeview cron plan
  --mode daily|backfill
  --corpus catalog|top:N|all|file:<path>
  --tier top-500|top-5000|full
  --shard-count N
  --max-total N
  --max-per-shard N
  --include-retries
  --force <comma-list>
  --matrix-out <path>
  --plan-out <path|r2-key>
  --bucket <bucket>
```

Produces a small shard/worker matrix and a full plan artifact/R2 object. It reads the aggregate freshness index, not `list_all()`.

```
codeview cron parse-shard
  --plan <path|r2-key>
  --shard-index K
  --shard-count N
  --max-items N
  --max-duration-minutes N
  --docsrs-min-delay-ms N
  --run-id <id>
  --bucket <bucket>
```

Processes deterministic shard work sequentially within one runner. It writes a run delta/report.

```
codeview cron queue-enqueue
  --plan <path|r2-key>
  --queue-mode cloudflare
  --queue-prefix codeview-parse
  --dedupe-run-id <id>
```

Enqueues durable work messages into priority queues.

```
codeview cron queue-drain
  --queues codeview-parse-std,codeview-parse-high,codeview-parse-normal,codeview-parse-low
  --max-items N
  --max-duration-minutes N
  --visibility-timeout-seconds N
  --docsrs-min-delay-ms N
  --run-id <id>
```

Pulls from Cloudflare Queues, drains high priority before lower priority, parses idempotently, acknowledges successes/permanent failures, and retries transient failures with delay/backoff.

```
codeview cron freshness-merge
  --run-id <id>
  --delta-prefix rust/_runs/<id>/
  --index-shards 256
  --write-catalog
  --bucket <bucket>
```

Single-writer finalizer. It applies run deltas to the aggregate index and writes `rust/catalog.json`.

```
codeview cron failures list|requeue|suppress
```

Operational tooling for dead letters and permanent parser gaps.

Std-specific:

```
codeview cron std-plan --channels stable,beta,nightly --strict-channels --matrix-out <path>
codeview cron parse-std-one --channel stable|beta|nightly --toolchain <toolchain> --crate <crate>
```

Existing commands can remain as compatibility wrappers:

- `sweep` becomes a thin daily `plan --mode daily`.
- `catalog` becomes a thin `freshness-merge --write-catalog` or reads the aggregate index.
- `seed-std` remains for local dev, but hosted CI should move to `std-plan` + `parse-std-one`.

## 4. Workflow sketches

### Recommended `parse.yml` steady state: Cloudflare Queues + GHA pull workers

Cloudflare Queues gives the real durable queue. GitHub Actions remains the compute fleet.

```yaml
name: parse

on:
  schedule:
    - cron: "0 3 * * *"
  workflow_dispatch:
    inputs:
      mode:
        default: daily
      corpus:
        default: top:5000
      workers:
        default: "32"
      max_items_per_worker:
        default: "25"

concurrency:
  group: codeview-parse-${{ inputs.mode || 'daily' }}
  queue: max

env:
  R2_BUCKET: crate-graphs
  STATIC_R2_TARGET: remote
  PARSER_REVISION: ${{ github.sha }}
  CODEVIEW_SKIP_SIDECAR: "1"

jobs:
  build-cli:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: dtolnay/rust-toolchain@3c5f7ea28cd621ae0bf5283f0e981fb97b8a7af9
        with: { toolchain: nightly }
      - uses: Swatinem/rust-cache@v2
        with: { shared-key: cron-release }
      - run: cargo build --release -p codeview-cli
      - uses: actions/upload-artifact@v4
        with:
          name: codeview-cli
          path: target/release/codeview
          retention-days: 2

  plan:
    needs: build-cli
    runs-on: ubuntu-latest
    outputs:
      worker_matrix: ${{ steps.plan.outputs.worker_matrix }}
      run_id: ${{ steps.plan.outputs.run_id }}
    steps:
      - uses: actions/download-artifact@v4
        with: { name: codeview-cli, path: bin }
      - id: plan
        run: |
          chmod +x bin/codeview
          bin/codeview cron plan \
            --mode "${{ inputs.mode || 'daily' }}" \
            --corpus "${{ inputs.corpus || 'top:5000' }}" \
            --shard-count "${{ inputs.workers || '32' }}" \
            --max-per-shard "${{ inputs.max_items_per_worker || '25' }}" \
            --include-retries \
            --bucket "$R2_BUCKET" \
            --plan-out "rust/_runs/${GITHUB_RUN_ID}/plan.json" \
            --matrix-out "$GITHUB_OUTPUT"

  enqueue:
    needs: plan
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
        with: { name: codeview-cli, path: bin }
      - run: |
          chmod +x bin/codeview
          bin/codeview cron queue-enqueue \
            --plan "rust/_runs/${{ needs.plan.outputs.run_id }}/plan.json" \
            --queue-prefix codeview-parse \
            --bucket "$R2_BUCKET"

  parse-workers:
    needs: [plan, enqueue]
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      max-parallel: 16
      matrix: ${{ fromJSON(needs.plan.outputs.worker_matrix) }}
    steps:
      - uses: actions/download-artifact@v4
        with: { name: codeview-cli, path: bin }
      - run: |
          chmod +x bin/codeview
          bin/codeview cron queue-drain \
            --queues codeview-parse-std,codeview-parse-high,codeview-parse-normal,codeview-parse-low \
            --max-items "${{ inputs.max_items_per_worker || '25' }}" \
            --max-duration-minutes 330 \
            --visibility-timeout-seconds 21600 \
            --docsrs-min-delay-ms 15000 \
            --run-id "${{ needs.plan.outputs.run_id }}" \
            --bucket "$R2_BUCKET"

  finalize:
    needs: [plan, parse-workers]
    if: always()
    runs-on: ubuntu-latest
    concurrency:
      group: codeview-r2-index-finalize
      queue: max
    steps:
      - uses: actions/download-artifact@v4
        with: { name: codeview-cli, path: bin }
      - run: |
          chmod +x bin/codeview
          bin/codeview cron freshness-merge \
            --run-id "${{ needs.plan.outputs.run_id }}" \
            --delta-prefix "rust/_runs/${{ needs.plan.outputs.run_id }}/" \
            --index-shards 256 \
            --write-catalog \
            --bucket "$R2_BUCKET"
```

Transition/fallback mode: replace `queue-enqueue` and `queue-drain` with `parse-shard`. This is simpler and likely enough for top-500/top-5000 daily maintenance, but it is not a durable queue.

### Proposed `std.yml`

```yaml
name: std

on:
  schedule:
    - cron: "0 2 * * *"
  workflow_dispatch:
    inputs:
      channels:
        default: stable,beta,nightly

concurrency:
  group: codeview-std
  queue: max

jobs:
  plan:
    runs-on: ubuntu-latest
    outputs:
      matrix: ${{ steps.plan.outputs.matrix }}
      run_id: ${{ steps.plan.outputs.run_id }}
    steps:
      - uses: actions/checkout@v6
      - run: cargo build --release -p codeview-cli
      - id: plan
        run: |
          target/release/codeview cron std-plan \
            --channels "${{ inputs.channels || 'stable,beta,nightly' }}" \
            --strict-channels \
            --matrix-out "$GITHUB_OUTPUT" \
            --bucket "$R2_BUCKET"

  parse-std:
    needs: plan
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      max-parallel: 5
      matrix: ${{ fromJSON(needs.plan.outputs.matrix) }}
    steps:
      - uses: actions/checkout@v6
      - uses: dtolnay/rust-toolchain@3c5f7ea28cd621ae0bf5283f0e981fb97b8a7af9
        with:
          toolchain: ${{ matrix.toolchain }}
          components: rust-docs-json
      - run: cargo build --release -p codeview-cli
      - run: |
          target/release/codeview cron parse-std-one \
            --channel "${{ matrix.channel }}" \
            --toolchain "${{ matrix.toolchain }}" \
            --crate "${{ matrix.crate }}" \
            --run-id "${{ needs.plan.outputs.run_id }}" \
            --bucket "$R2_BUCKET"

  finalize:
    needs: [plan, parse-std]
    if: always()
    runs-on: ubuntu-latest
    concurrency:
      group: codeview-r2-index-finalize
      queue: max
    steps:
      - uses: actions/checkout@v6
      - run: cargo build --release -p codeview-cli
      - run: |
          target/release/codeview cron freshness-merge \
            --run-id "${{ needs.plan.outputs.run_id }}" \
            --delta-prefix "rust/_runs/${{ needs.plan.outputs.run_id }}/" \
            --index-shards 256 \
            --write-catalog \
            --bucket "$R2_BUCKET"
```

This sketch intentionally uses strict channel behavior. If stable/beta `rust-docs-json` cannot be installed, the pipeline should report that gap instead of publishing misleading aliases.

## 5. Freshness and catalog at scale

Current state:

- `FreshnessRegistry::record` writes `rust/_index/{name}.json`.
- `FreshnessRegistry::list_all()` lists `rust/_index/` then GETs every crate freshness object.
- `catalog` calls `list_all()`, so catalog rebuild is O(N) R2 GETs.

Replace this with a sharded aggregate index.

Source refs: current `freshness.rs`/`catalog.rs` behavior in the repo and Cloudflare R2 consistency docs. R2's strong read-after-write consistency makes a manifest-pointer publication protocol viable, but it does not itself solve concurrent read-modify-write races.

### Data structure

Keep per-crate freshness files for compatibility during migration, but stop using them for whole-corpus operations.

```
rust/_index/manifest.json
{
  "schema": 1,
  "generation": "2026-07-04T03:00:00Z-gh123",
  "generatedAt": "...",
  "parserRevision": "...",
  "graphSchemaVersion": 3,
  "shards": [
    { "id": "00", "key": "rust/_index/generations/<gen>/shards/00.json", "sha256": "...", "count": 812 },
    ...
  ]
}
```

Each shard object:

```
{
  "schema": 1,
  "shard": "00",
  "entries": {
    "tokio": {
      "name": "tokio",
      "storageName": "tokio",
      "version": "1.47.0",
      "parsedAt": "...",
      "source": "docs.rs",
      "parserRevision": "...",
      "schemaVersion": 3,
      "graphHash": "...",
      "rustdocHash": "...",
      "nodes": 12345,
      "edges": 67890,
      "priorityTier": "top-500",
      "downloadRank": 12,
      "failure": null
    }
  }
}
```

For 200k crates and 256 shards, each shard has about 780 entries. A sweep reads 1 manifest plus 256 shard objects, not one GET per crate. A single-crate check reads only the relevant shard and can cache it in memory.

### Update protocol

Do not let parse jobs read-modify-write the aggregate index. That would race. R2 is strongly read-after-write globally, but the current trait does not expose compare-and-swap or conditional writes, and local Miniflare parity would be harder.

Use append-only run deltas plus one finalizer:

1. `plan` reads the current aggregate manifest and shards.
2. Each parse worker writes normal artifacts, the existing per-crate freshness object, and a run delta:
   `rust/_runs/<run_id>/deltas/<worker>.jsonl`.
3. Each delta includes success, no-op, transient, permanent, and dead-letter state changes.
4. `freshness-merge` runs once after workers complete, under `codeview-r2-index-finalize`.
5. The finalizer reads the previous aggregate shards plus run deltas, applies updates in memory, writes only changed new generation shard objects, writes the new generation manifest, then writes the public pointer `rust/_index/manifest.json` last.
6. `rust/catalog.json` is generated from the same merged in-memory aggregate, not by listing per-crate files.

Readers will see either the old complete manifest or the new complete manifest. Because the pointer is written last and R2 reads are strongly consistent, the new manifest should not point at missing shard objects.

Garbage collection can delete old generations and run deltas after a retention window. Catalog should keep running as a single finalizer to avoid concurrent catalog races.

## 6. Queue options

### A. GHA-only dynamic sharded matrices

Pros:

- Smallest implementation step from current workflow.
- Uses only GitHub Actions, R2, and the existing CLI.
- Deterministic sharding gives no overlap and easy resumption next run.
- Enough for daily maintenance and top-500/top-5000 if budgets are modest.

Cons:

- Not a true durable work queue.
- No per-item leasing or central priority once the run starts.
- Large backfills are awkward to pause, resume, reprioritize, or observe.
- Global docs.rs rate limiting is approximate through `max-parallel` and per-worker delays.

Use as phase 1 or fallback.

### B. Durable queue in R2/D1

Pros:

- Full control over priority, claim, lease, retry, and reporting.
- Can be tailored exactly to Codeview's freshness model.
- D1 gives SQL-native claims if the queue table is designed carefully.

Cons:

- R2-only claims are unsafe without conditional writes or another lock.
- D1 is single-threaded per database and has a 10 GB per-database limit; it can work for queue metadata, but it becomes another database system to operate.
- More custom queue code means more failure modes than using Cloudflare Queues.

Use only if Cloudflare Queues cannot express the desired drain model or if priority/search/reporting must be deeply custom.

### C. Cloudflare Queues

Pros:

- Managed durable queue with retries, delayed retry, DLQ, message retention, and backlog metrics.
- Supports HTTP pull consumers from outside Workers, which fits GHA parse workers and long-running upstream tasks.
- Multiple concurrent pull consumers receive unique leased batches.
- Limits are comfortable for this workload: 128 KB messages, 100 message batches, 12 hour pull visibility timeout, 100 retries, 25 GB backlog, 5,000 messages/sec per queue.
- Pricing is low for build orchestration. A message usually costs write + read + delete operations; Workers Paid includes 1M operations/month and extra operations are currently $0.40/million.

Cons:

- Requires Cloudflare queue setup, API token management, and queue client code in `codeview-cli`.
- No native strict priority in one queue. Use separate priority queues and drain them in order.
- Workers push consumers are not the right compute substrate for Rust parsing because consumer wall time is 15 minutes and the parser/build toolchain belongs on GHA or self-hosted runners.

Recommended steady state.

Source refs: Cloudflare Queues pull consumer docs, limits docs, retry/DLQ docs, and pricing docs.

### D. External queue/runner

Examples: AWS SQS plus ECS/Batch, Buildkite, self-hosted Kubernetes, dedicated VM fleet.

Pros:

- Best for very large full-corpus backfills, custom autoscaling, and strict global rate limiting.
- Can use self-hosted runners or long-lived workers to avoid repeated checkout/toolchain setup.

Cons:

- Highest operational cost and complexity.
- Moves the project away from the current GHA/R2-centered static build model.
- More secrets, IAM, monitoring, and failure handling.

Use only if full crates.io backfill becomes a standing workload rather than an occasional batch.

### Recommendation

Recommended architecture: Cloudflare Queues with GHA pull-worker consumers, plus the sharded GHA mode as a transition/fallback.

Rationale:

- It gives Codeview a real queue/priority/retry/DLQ model without moving parse compute off GitHub Actions.
- It keeps parse work idempotent because `parse-one` and freshness checks already make duplicate delivery tolerable.
- It supports daily incremental and long-running backfills with the same worker.
- It gives better observability and resumption than static matrices while remaining much simpler than a custom D1 queue.

## 7. Rough cost/time model

Assumptions for planning only:

- Average third-party parse + publish: 2 runner-minutes/crate.
- Small crates may be much faster; large crates may be 5-15 minutes. Add telemetry before committing to budgets.
- Std crates are larger: assume 5-10 minutes per crate/channel until measured.
- Parse worker parallelism: 16.
- One prebuilt CLI artifact per workflow, not one Rust build per parse job.
- R2 writes: roughly 50-250 Class A operations per crate depending on populated shards/search output.
- Queue operations: roughly 3 operations per crate message before retries.
- Private Linux runner overage: currently $0.006/minute for baseline 2-core Linux, after included minutes. Public standard runner usage is free.
- The 200k full-corpus row below is an illustrative scale, not a verified current crates.io count. The exact count should come from the crates.io db dump at planning time.

| Corpus | Work items | Runner-min estimate | Wall time at 16 workers | Private overage estimate | Notes |
|---|---:|---:|---:|---:|---|
| Std nightly only | 5 | 25-50 | 5-10 min | <$1 | Current correctness is nightly only. |
| Std stable+beta+nightly | 15 | 75-150 | 10-30 min | <$1 | Stable/beta JSON availability unverified. |
| Top 500 | 500 | ~1,000 | ~1 hour | ~$6 | Fits daily or manual run. |
| Top 5,000 | 5,000 | ~10,000 | ~10.5 hours | ~$60 | Better as manual backfill or 500/day for 10 days. |
| Full latest crates.io | illustrative 200k | ~400,000 | ~17 days at 16 workers, ~4.3 days at 64 workers | ~$2,400 | Exact count should come from the crates.io db dump. This is not a casual GHA workload. |

R2 operation cost is usually lower than runner cost but not zero at full scale. At 100 PUT-like operations per crate:

- Top 5,000: ~500k Class A ops, within the 1M/month R2 free operations if little else is writing.
- Full 200k: ~20M Class A ops, roughly $90 at current standard R2 pricing after the first 1M.

Cloudflare Queue cost is negligible for top-N and modest for full corpus. 200k messages with no retries is about 600k operations, under the 1M/month Workers Paid included operations if that allocation is otherwise unused.

Storage depends heavily on artifact size. If average stored static artifacts are 1-5 MB/crate, then:

- Top 5,000: 5-25 GB, around $0.08-$0.38/month after free tier effects.
- Full 200k: 200 GB-1 TB, around $3-$15/month.

The actual architectural limiter is not R2 price. It is parse runner minutes, docs.rs politeness, and whether "full crates.io" means latest versions only or all versions.

## 8. Open questions for the architect

1. Does "all crates" mean latest version per crate, all semver-major lines, or every historical crate version?
2. What is the target daily budget: 100, 500, 2,000, or more third-party parses/day?
3. Is the repository public for Actions billing purposes, or should private minute overage be modeled as a hard cost?
4. What global docs.rs request rate is acceptable? This should be confirmed with docs.rs maintainers before full backfill.
5. For std stable/beta, should Codeview fail until official JSON exists, build JSON from Rust source, or publish nightly-only std with explicit UI labeling?
6. Should `latest` for std resolve to stable, nightly, or a separate "latest parsed channel" concept?
7. Is Cloudflare Queues acceptable infrastructure now, or should phase 1 be GHA-only sharded matrices plus the aggregate freshness index?
8. Should the corpus source be the crates.io db dump, sparse index, or a curated manifest checked into/R2-stored by Codeview?
9. What retention window is desired for run deltas, old freshness generations, and DLQ entries?
10. Do we need artifact-level delete/GC for old crate versions, or is storage append-only for now?
