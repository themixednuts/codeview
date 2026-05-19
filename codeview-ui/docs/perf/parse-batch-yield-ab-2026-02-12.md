# Hosted parse scheduler A/B notes (2026-02-12)

## Goal

Compare hosted parse scheduler settings for:

- route responsiveness while parsing (`/windows-sys/0.61.2` <-> `/`)
- parse completion speed
- dedupe/lease stability (single enqueue/workflow, no reclaim)
- parse-to-ready correctness (kinds non-zero, root children non-zero after ready)

## Method

For each variant:

1. Resolve Windows locks via `handle .wrangler` / `handle .svelte-kit` and `taskkill` stale `node.exe`/`workerd.exe` PIDs.
2. Start fresh state with `bun run cf:dev:clear`.
3. Use one Playwright context/tab and clear HTTP disk cache via CDP.
4. Run 3 nav cycles:
   - `GET /windows-sys/0.61.2` (cold while parse active)
   - `GET /`
   - `GET /windows-sys/0.61.2`
5. Wait for parse completion markers in logs.
6. Verify dedupe/finalize/ready/kinds/tree-children in logs.

## Variants tested

- `80/40` -> `tmp/ab-b80y40.stdout.log`, `tmp/ab-b80y40.stderr.log`
- `120/40` -> `tmp/ab-b120y40.stdout.log`, `tmp/ab-b120y40.stderr.log`
- `80/20` -> `tmp/ab-b80y20.stdout.log`, `tmp/ab-b80y20.stderr.log`
- `120/80` -> `tmp/ab-b120y80.stdout.log`, `tmp/ab-b120y80.stderr.log`

## Results

### `80/40`

- crate DCL: `419, 74, 60` (median `74`)
- home DCL: `117, 99, 239` (median `117`)
- back DCL: `58, 57, 76` (median `58`)
- parse finalize: `finalizeMs=5258.0` (`tmp/ab-b80y40.stdout.log:1131`)

### `120/40`

- crate DCL: `150, 41, 59` (median `59`)
- home DCL: `61, 147, 126` (median `126`)
- back DCL: `60, 53, 54` (median `54`)
- parse finalize: `finalizeMs=5103.0` (`tmp/ab-b120y40.stdout.log:1067`)

### `80/20`

- crate DCL: `148, 48, 63` (median `63`)
- home DCL: `40, 161, 244` (median `161`)
- back DCL: `100, 69, 71` (median `71`)
- parse finalize: `finalizeMs=5305.0` (`tmp/ab-b80y20.stdout.log:1107`)

### `120/80`

- crate DCL: `151, 53, 56` (median `56`)
- home DCL: `69, 141, 159` (median `141`)
- back DCL: `98, 70, 59` (median `70`)
- parse finalize: `finalizeMs=4986.0` (`tmp/ab-b120y80.stdout.log:1065`)

## Stability and correctness checks (all variants)

- No `parse.enqueue.reclaim` observed.
- Exactly one `parse.enqueue.create` and one `workflow.run.start/end` per run window.
- `parse.finalize.done` and ready transition present.
- `getCrateMeta` moved from `kinds=0` during parse to `kinds=11` after ready.
- `getTreeChildren ... parent=windows_sys` moved from `children=0` during parse to `children=5` after ready.
- No `[500]` or EPERM failures in variant run logs.

## Decision

Use `120/40` as the default balance point:

- better/more stable navigation latency than `80/20` and `120/80`
- better parse completion than `80/40` and `80/20`
- only slightly slower finalize than `120/80`

## Follow-up

- This pass used 3 nav cycles per variant; for publishable benchmarking, run a longer soak (>=10 cycles per variant) and report median/p95.
- WebSocket `1006` warning bursts were seen in some runs and can skew user-visible responsiveness; include WS stability as a separate dimension in future docs.
