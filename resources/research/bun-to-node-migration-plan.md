# Bun to Node runtime migration plan

Date: 2026-07-04

Scope: read-only research pass plus temporary experiments. All tracked source edits used for experiments were restored. No commit was made.

## Verdict

The production embed migration is feasible, but the dev-runtime premise is not proven yet.

The requested linchpin experiment was negative on this machine:

- Node v25.6.1 + vite-plus 0.2.2, with `localWebSocket()` temporarily removed from `vite.config.ts`, returned `http_code=500` after 65.066607s and logged the same Vite+ SSR `fetchModule` transport timeout.
- Node v24.18.0 + vite-plus 0.2.2, with `localWebSocket()` temporarily removed, returned `http_code=000` after the 75s curl timeout. It printed the VITE+ 0.2.2 banner but never returned 200.

So: do not start the full migration only to fix the dev hang until a smaller Vite+ repro proves that `vp dev` under Node works in the target Node version. The runtime migration is still a sound architecture direction because it removes Bun from the long-lived local server/runtime path, but the immediate dev-server outage needs one more upstream/runtime isolation step.

Recommended target if the team still wants a self-contained local server: `@sveltejs/adapter-node` plus a Node Single Executable Application (SEA), with a Node-compatible WebSocket server and Node-compatible local storage. SEA is the right Node-native embed mechanism if "no external Node install" is a hard requirement. If external Node is acceptable, adapter-node without SEA is much simpler.

## Evidence summary

Environment and dependency alignment:

```text
$ bun install --frozen-lockfile
bun install v1.3.9 (cf6cdbbb)

+ @sveltejs/kit@2.59.0
+ vite@0.2.2
+ vite-plus@0.2.2

16 packages installed [1407.00ms]
Resolving dependencies
Resolved, downloaded and extracted [1]

$ node --version
v25.6.1

$ npx -y node@24 --version
v24.18.0

$ bun --version
1.3.9

$ node -p "require('./codeview-ui/node_modules/vite-plus/package.json').version + ' / ' + require('./codeview-ui/node_modules/@voidzero-dev/vite-plus-core/package.json').version"
0.2.2 / 0.2.2
```

Cleanliness baseline before writing this doc:

```text
$ git status --short
?? .top30.log
?? .wrangler/
?? resources/
```

The `resources/` tree was already untracked before this pass; this file is added inside it.

## Current embed architecture

### SvelteKit adapter selection

`codeview-ui/svelte.config.js:3-11` selects the Cloudflare adapter only when `PUBLIC_CODEVIEW_PLATFORM === 'cloudflare'`. Otherwise it imports `@jesterkit/exe-sveltekit` with `binaryName: 'codeview-server'`.

Current local build scripts in `codeview-ui/package.json:7-10` are:

```json
"dev": "PUBLIC_CODEVIEW_PLATFORM=local bun --bun node_modules/vite-plus/bin/vp dev",
"build": "PUBLIC_CODEVIEW_PLATFORM=local bun --bun node_modules/vite-plus/bin/vp build",
"preview": "PUBLIC_CODEVIEW_PLATFORM=local bun --bun node_modules/vite-plus/bin/vp preview"
```

So the local SvelteKit build is a Vite+ build running under the Bun runtime. In the Rust build, `codeview-cli/build.rs:90-95` invokes `bun run build` in `codeview-ui` and sets `EXE_TARGET` for the adapter.

### What `@jesterkit/exe-sveltekit` produces

Installed adapter evidence:

- `codeview-ui/node_modules/@jesterkit/exe-sveltekit/package.json` version is `0.1.7`, and its README says Bun is required to build the executable, not to run it.
- `codeview-ui/node_modules/@jesterkit/exe-sveltekit/dist/index.js:116-124` runs `bun build --compile ... --outfile <out>/<binaryName>`.
- `codeview-ui/node_modules/@jesterkit/exe-sveltekit/dist/index.js:168-197` writes SvelteKit client, prerendered, and server output into `.svelte-kit`, embeds or copies assets, then calls that compile step.
- `codeview-ui/node_modules/@jesterkit/exe-sveltekit/dist/server/index.ts:107-131` starts the runtime server with `Bun.serve()`.

Local artifact evidence after the existing build:

```text
codeview-ui/dist/codeview-server.exe                  144521216 bytes
codeview-cli/sidecar/codeview-server-windows-x64.exe  144521216 bytes
```

Conclusion: the current adapter produces a Bun-compiled single-file executable named `dist/codeview-server.exe` on Windows, or `dist/codeview-server` on non-Windows.

### Rust CLI embed and spawn path

Build-time sidecar creation:

- `codeview-cli/build.rs:61-69` maps the Cargo target triple to the adapter `EXE_TARGET`.
- `codeview-cli/build.rs:72-80` creates `codeview-cli/sidecar/codeview-server-<exe_target>(.exe)`.
- `codeview-cli/build.rs:82-85` supports `CODEVIEW_SKIP_SIDECAR=1` by writing an empty placeholder sidecar.
- `codeview-cli/build.rs:88-95` runs `bun run build`.
- `codeview-cli/build.rs:101-115` copies `codeview-ui/dist/codeview-server(.exe)` into the sidecar path and exposes it to Rust with `cargo:rustc-env=SIDECAR_PATH=...`.

Runtime embedding and launch:

- `codeview-cli/src/main.rs:19` embeds the sidecar bytes directly in the Rust binary with `include_bytes!(env!("SIDECAR_PATH"))`.
- `codeview-cli/src/main.rs:28-52` defines the `ui` subcommand.
- `codeview-cli/src/main.rs:149-168` calls `serve_ui(...)` after either using a supplied `--graph` or analyzing a workspace.
- `codeview-cli/src/main.rs:544-551` writes the embedded sidecar bytes to a per-process temp dir.
- `codeview-cli/src/main.rs:559-572` spawns that temp sidecar and passes `PORT`, `CODEVIEW_WORKSPACE`, and `CODEVIEW_GRAPH`.
- `codeview-cli/src/main.rs:591-593` calls `.spawn()` on the extracted sidecar path.
- `codeview-cli/src/main.rs:595-600` assigns the child to a Windows Job Object so it dies with the CLI.
- `codeview-cli/src/main.rs:749-755` expects the extracted runtime file to be named `codeview-server.exe` on Windows and `codeview-server` elsewhere.

Conclusion: the UI server is embedded inside the Rust CLI executable as bytes, extracted to a temp executable at runtime, and spawned as a child process. It is not an external installed sidecar file at runtime.

## Every current Bun requirement

### Package management and scripts

- `codeview-ui/package.json:5` declares `packageManager: "bun@1.3.9"`.
- `codeview-ui/package.json:7-10` runs local `dev`, `build`, and `preview` under `bun --bun`.
- `codeview-ui/package.json:27-28` uses Bun for schema generation/checking: `bun scripts/generate-schema.ts`.
- `codeview-cli/build.rs:90-95` shells out to `bun run build` for sidecar construction.
- `codeview-cli/src/publisher/r2.rs:450-467` spawns `bun` for the local Miniflare bulk writer.
- `codeview-cli/src/publisher/r2.rs:557-563` uses `bunx wrangler`.

Package-manager usage can stay. The migration is about runtime/build runtime, not necessarily the dependency manager.

### Dev runtime

- `codeview-ui/package.json:7` runs `vp dev` under `bun --bun`.
- `codeview-ui/vite.config.ts:7-8` defines the fixed dev WS side-port `15173`.
- `codeview-ui/vite.config.ts:10-17` documents why the dev plugin exists: Vite intercepts upgrades, so `/api/events/ws` does not fire in `vite dev`.
- `codeview-ui/vite.config.ts:23-25` skips the plugin in Cloudflare, Vitest, or when `Bun.serve` is unavailable.
- `codeview-ui/vite.config.ts:31-37` loads `src/lib/server/local/ws.ts` and `src/lib/server/local/provider.ts` through `viteServer.ssrLoadModule`.
- `codeview-ui/vite.config.ts:42-103` starts `Bun.serve()` on port 15173 and implements native Bun websocket lifecycle handlers.
- `codeview-ui/src/lib/ws/client.ts:139-142` connects to `${location.hostname}:15173` in dev and `/api/events/ws` on the normal host in production.

### Production local server runtime

- `codeview-ui/node_modules/@jesterkit/exe-sveltekit/dist/server/index.ts:107-131` uses `Bun.serve()`.
- `codeview-ui/patches/@jesterkit%2Fexe-sveltekit@0.1.7.patch:7-17` patches the adapter server so `event.platform.server` is the Bun server and Bun websocket callbacks delegate to `ws.data`.
- `codeview-ui/src/app.d.ts:9-12` types `App.Platform.server` as `import('bun').Server`.
- `codeview-ui/src/lib/server/local/provider.ts:1397-1419` expects `event.platform?.server.upgrade(event.request, { data: handlers })` and returns status 101 after Bun handles the upgrade.
- `codeview-ui/src/lib/server/local/ws.ts:9` imports `ServerWebSocket` from `bun`.
- `codeview-ui/src/lib/server/local/ws.ts:114-166` creates Bun-shaped websocket lifecycle handlers.

### Local storage and file IO

- `codeview-ui/src/lib/server/local/cache.ts:1-31` imports Bun types and lazily requires `bun:sqlite` and `drizzle-orm/bun-sqlite`.
- `codeview-ui/src/lib/server/local/cache.ts:98-104` opens the local cache DB with Bun SQLite.
- `codeview-ui/src/lib/server/local/provider.ts:161-165` lazily instantiates `LocalCache`.
- `codeview-ui/src/lib/server/local/provider.ts:625-631` uses `Bun.file(stdInfo.jsonPath!).stream()` when parsing std JSON.

This is a production blocker for a Node runtime. The WS migration is not enough.

### Cloudflare path

The hosted Cloudflare path is separate:

- `codeview-ui/svelte.config.js:5-10` selects `@sveltejs/adapter-cloudflare` in Cloudflare mode.
- `codeview-ui/package.json:35-41` defines `cf:*` scripts that use Wrangler and Cloudflare builds.
- `codeview-ui/src/lib/server/cloudflare/provider.ts:974-977` returns 410 for hosted realtime websocket upgrades.

Cloudflare should remain unaffected if local-only Node code stays behind the existing `$provider` alias and `PUBLIC_CODEVIEW_PLATFORM=local` branch.

## Current WebSocket story

### Dev

Dev WS is a side server, not a SvelteKit route:

- Browser client: `codeview-ui/src/lib/ws/client.ts:139-142` uses side-port 15173 only in `import.meta.env.DEV`.
- Vite plugin: `codeview-ui/vite.config.ts:42-103` uses `Bun.serve()` to accept websocket upgrades.
- Shared contract: `codeview-ui/src/lib/server/local/ws.ts:31` exports the shared `connections` map, `:59-72` exports typed emit helpers, and `:172-203` exports `sendInitialState(...)` for the dev plugin.

The dev side server manually mirrors `createHandlers(...)`: it registers `connections`, sends the initial `connected` ack, handles ping/subscribe/unsubscribe, and calls `sendInitialState(...)`.

### Production local binary

Production local WS goes through the Bun adapter:

- Route: `codeview-ui/src/routes/api/events/ws/+server.ts:1-4` delegates GET to `$provider.handleWsUpgrade`.
- Local provider: `codeview-ui/src/lib/server/local/provider.ts:1397-1419` pulls `event.platform.server`, creates handlers, and calls Bun `server.upgrade(...)`.
- Adapter patch: `codeview-ui/patches/@jesterkit%2Fexe-sveltekit@0.1.7.patch:7-17` injects `platform.server` and adds Bun websocket lifecycle callbacks that delegate to `ws.data`.

So production WS is Bun-specific in both the adapter and the local provider. It is not a generic SvelteKit route implementation.

## Linchpin experiment

### Setup

I first reconciled the stale `node_modules` state to the committed 0.2.2 lockfile:

```text
$ bun install --frozen-lockfile
+ vite@0.2.2
+ vite-plus@0.2.2
```

I then temporarily edited `codeview-ui/vite.config.ts` from:

```ts
plugins: [tailwindcss(), sveltekit(), localWebSocket()],
```

to:

```ts
plugins: [tailwindcss(), sveltekit()],
```

After each probe, I restored the file with:

```text
git restore -- codeview-ui/vite.config.ts
```

`git status --short -- codeview-ui/vite.config.ts` and `git diff -- codeview-ui/vite.config.ts` were empty after restore.

### Node v25.6.1 result

Command shape:

```text
$env:PUBLIC_CODEVIEW_PLATFORM = 'local'
node node_modules/vite-plus/bin/vp dev --host 127.0.0.1 --port 5173 --strictPort
curl.exe -s -o NUL -w "http_code=%{http_code} time_total=%{time_total}" --max-time 75 http://localhost:5173/
```

Result:

```text
PROCESS_ID=54500 START_EXITED=False LISTENER_PID=55348
CURL_RESULT=http_code=500 time_total=65.066607
```

Dev stdout:

```text
VITE+ v0.2.2
Local: http://127.0.0.1:5173/
```

Dev stderr:

```text
[vite+] (ssr) Error when evaluating SSR module /@fs/E:/Projects/codeview/codeview-ui/node_modules/@sveltejs/kit/src/runtime/server/index.js: transport invoke timed out after 60000ms ... fetchModule ... @voidzero-dev/vite-plus-core/dist/vite/node/module-runner.js
```

### Node v24.18.0 result

Command shape:

```text
$env:PUBLIC_CODEVIEW_PLATFORM = 'local'
npx -y node@24 node_modules/vite-plus/bin/vp dev --host 127.0.0.1 --port 5173 --strictPort
curl.exe -s -o NUL -w "http_code=%{http_code} time_total=%{time_total}" --max-time 75 http://localhost:5173/
```

Result:

```text
PROCESS_ID=50556 START_EXITED=False LISTENER_PID=2860
CURL_RESULT=http_code=000 time_total=75.015595
```

Dev stdout:

```text
VITE+ v0.2.2
Local: http://127.0.0.1:5173/
```

No stderr was emitted before the bounded curl timed out.

### Linchpin conclusion

`/` did not return 200 under Node in either probe. The Node v25 probe reproduced the Vite+ SSR transport timeout even with `localWebSocket()` removed. This means "move `vp dev` from Bun to Node" is not yet a verified fix in this workspace.

Before implementation, isolate this with a minimal SvelteKit + Vite+ 0.2.2 repro under Node and Bun. If the minimal app works under Node, then Codeview has another config/module interaction causing the timeout. If the minimal app fails, this is likely an upstream Vite+ 0.2.x issue independent of Bun.

## Node migration design

### Dev runtime

Target script shape after the dev linchpin passes:

```json
"dev": "cross-env PUBLIC_CODEVIEW_PLATFORM=local node node_modules/vite-plus/bin/vp dev",
"build": "cross-env PUBLIC_CODEVIEW_PLATFORM=local node node_modules/vite-plus/bin/vp build",
"preview": "cross-env PUBLIC_CODEVIEW_PLATFORM=local node node_modules/vite-plus/bin/vp preview"
```

Use `cross-env` or a small Node runner script because the current POSIX-style env assignment works under the current Bun/Vite+ flow but is not a portable Windows shell contract.

Replace the dev `Bun.serve()` plugin with a Node side server:

- Keep port 15173 to preserve `codeview-ui/src/lib/ws/client.ts:139-142`.
- Add `ws` as a direct dependency. It exists transitively today (`node_modules/ws` is 8.20.0), but the app should declare it explicitly.
- In `vite.config.ts`, use `node:http` plus `new WebSocketServer({ noServer: true })`.
- On `upgrade`, require path `/api/events/ws`, call `wss.handleUpgrade(req, socket, head, cb)`, assign a `connectionId`, then register `{ ws, tags }` in `wsMod.connections`.
- Keep the lazy `viteServer.ssrLoadModule('/src/lib/server/local/ws.ts')` and provider module load pattern from `vite.config.ts:31-36`, but remove all Bun checks and Bun websocket types.
- Close the side server when the Vite server closes to avoid stale port 15173 listeners.

Refactor `codeview-ui/src/lib/server/local/ws.ts` from Bun-specific handlers to a runtime-neutral contract:

```ts
type LocalSocket = {
  send(data: string): void;
  close?(code?: number, reason?: string): void;
};
```

Then expose small lifecycle helpers such as:

- `openConnection(socket: LocalSocket, internals, connectionId = crypto.randomUUID())`
- `handleSocketMessage(connectionId, socket, raw, internals)`
- `closeConnection(connectionId)`

Both the dev Node side-port server and production Node custom server can call those helpers. This removes the `ServerWebSocket` import from `bun`.

### Local storage and std JSON IO

Replace Bun storage and file IO before trying to run production under Node:

- `codeview-ui/src/lib/server/local/cache.ts`: replace `bun:sqlite` plus `drizzle-orm/bun-sqlite` with a Node-compatible SQLite layer.
- Preferred for SEA: Node built-in `node:sqlite`, because it avoids native addon packaging. Node docs show `node:sqlite` added in v22.5.0, no longer behind `--experimental-sqlite` in v23.4.0/v22.13.0, and release-candidate in v25.7.0. The `DatabaseSync` API is synchronous and file-backed, which is close to the current `bun:sqlite` usage.
- Risk: Drizzle may not expose a mature `node:sqlite` driver. If not, either write a thin adapter for the current LocalCache query surface or use a Drizzle proxy/session adapter. Avoid `better-sqlite3` for SEA unless native addon packaging is explicitly accepted.
- `codeview-ui/src/lib/server/local/provider.ts:625-631`: replace `Bun.file(path).stream()` with Node file APIs, for example `createReadStream(path)` converted with `Readable.toWeb(...)` if `parseWithRustBinary` should keep receiving a Web `ReadableStream<Uint8Array>`.

### Production server under adapter-node

Switch local SvelteKit adapter:

- `svelte.config.js`: Cloudflare branch stays as-is; local branch changes from `@jesterkit/exe-sveltekit` to `@sveltejs/adapter-node`, likely with an explicit output such as `adapterNode({ out: 'build' })`.
- Installed adapter-node evidence: `node_modules/@sveltejs/adapter-node/index.js:23-37` defaults `out` to `build` and writes client/prerendered assets.
- `node_modules/@sveltejs/adapter-node/index.js:93-110` writes bundled server output and copies `index.js`, `handler.js`, env, and shims into the output.
- `node_modules/@sveltejs/adapter-node/files/index.js:235-288` shows the default server honors `HOST` and `PORT` and uses a Node `http.createServer()`.
- Svelte docs say adapter-node creates `index.js` and `handler.js`; `handler.js` can be imported into a custom server backed by Node `http.createServer`.

Do not rely on `/api/events/ws` running as a normal SvelteKit request for local production upgrades under adapter-node. Instead:

- Add a custom local server entry, for example `codeview-ui/server/codeview-server.mjs`.
- Import `handler` from `./build/handler.js`.
- Create `const server = http.createServer(handler)`.
- Attach `server.on('upgrade', ...)` and route `/api/events/ws` to a `ws` `WebSocketServer`.
- Import the runtime-neutral WS helpers from `build/server/...` or from a bundled local module.
- Ensure the local provider internals are initialized before accepting WS subscriptions. Current `providerInternals` is set inside `createLocalProvider()` (`provider.ts:1378-1383`), and `createProvider(_event)` ignores the event (`provider.ts:1388-1390`). Either export an explicit `ensureLocalProvider()` or make the Node WS adapter lazily call the same singleton initializer.
- Keep `src/routes/api/events/ws/+server.ts` for Cloudflare and non-upgrade HTTP behavior, but for local Node production actual websocket upgrades should be handled by the custom server before SvelteKit's handler.

### Node SEA packaging

Node SEA is feasible but not a drop-in replacement for Bun compile.

Important constraints from Node docs:

- Node 25.5.0 introduced `--build-sea`, replacing the older copy + `--experimental-sea-config` + `postject` flow with one core command. Backward compatibility with the old postject flow is still maintained.
- SEA config supports `main`, `mainFormat`, `executable`, `output`, `execArgv`, and `assets`.
- In the injected main script, default module loading does not read filesystem modules; only built-ins load unless the app is bundled or intentionally creates a filesystem `require`.

Recommended packaging spike:

1. Build SvelteKit with adapter-node to `build/`.
2. Build a custom Node server entry that includes HTTP + WS upgrade handling.
3. Bundle that custom server and adapter-node server graph into a single JS SEA entry with esbuild or Rollup, with no code splitting.
4. Embed static assets via SEA `assets`, or embed a compressed `build/` payload and extract it to a temp dir on startup.
5. Generate `dist/codeview-server.exe` on Windows:

```json
{
  "main": "dist/codeview-server.bundle.mjs",
  "mainFormat": "module",
  "output": "dist/codeview-server.exe",
  "disableExperimentalSEAWarning": true,
  "assets": {
    "client.tar.br": "dist/client.tar.br"
  }
}
```

For Node v25.5+:

```text
node --build-sea sea-config.json
```

For older Node build hosts:

```text
node --experimental-sea-config sea-config.json
node -e "require('fs').copyFileSync(process.execPath, 'dist/codeview-server.exe')"
postject dist/codeview-server.exe NODE_SEA_BLOB sea-prep.blob ...
```

Windows signing:

- The older postject flow may require removing an existing signature before injection.
- Signing after injection is optional for local execution but useful for distribution and SmartScreen/AV reputation.
- Treat Windows signing as release-pipeline work, not local dev work.

Rust sidecar contract after SEA:

- Keep output name `dist/codeview-server.exe` / `dist/codeview-server`.
- Keep `codeview-cli/src/main.rs` mostly unchanged: it embeds bytes, writes temp executable, sets `PORT`, `CODEVIEW_GRAPH`, and `CODEVIEW_WORKSPACE`, then spawns it.
- Update `codeview-cli/build.rs` build step from "run Bun build and copy Bun exe" to "run UI build plus SEA build and copy SEA exe".
- Cross-target build needs a new strategy. `@jesterkit/exe-sveltekit` accepted `EXE_TARGET`; Node SEA needs the target Node executable supplied by `executable` or a per-platform build host. CI can download Node binaries for `windows-x64`, `linux-x64`, `darwin-arm64`, etc., then run SEA with the matching executable.

### Alternatives

#### A. adapter-node + Node SEA

Pros:

- Preserves the current Rust CLI contract: one embedded executable sidecar.
- No external Node required on user machines.
- Node-native path; no Bun runtime dependency in dev/prod local server.

Cons:

- Not turnkey: adapter-node output is multi-file, while SEA wants a bundled main or an extraction/bootstrap design.
- Needs WS custom server work.
- Needs Bun SQLite replacement.
- Needs Windows signing and CI target-binary handling.

Recommendation: best long-term option if self-contained distribution is non-negotiable, but only after a SEA packaging spike and after the Vite+ dev linchpin is fixed.

#### B. adapter-node requiring Node installed

Pros:

- Simplest implementation.
- Uses adapter-node as documented: run `node build` or custom server.
- Easiest way to validate Node-compatible WS and storage before SEA.

Cons:

- Changes product requirements: end users need Node installed.
- Rust CLI either has to find `node` on PATH or bundle JS files separately.
- Weaker "single binary" story.

Recommendation: use as an intermediate milestone and test harness, not as final distribution unless external Node is acceptable.

#### C. Deno compile

Pros:

- `deno compile` creates a self-contained binary.
- Deno has Node/npm compatibility and official docs show SvelteKit support on Deno Deploy.

Cons:

- This app is already SvelteKit + Vite+ + Rust CLI + local SQLite + custom WS; Deno would be a second runtime migration, not just an embed swap.
- Deno Deploy support does not directly prove local compiled SvelteKit server compatibility with this app.
- Node-compatible modules/native assumptions still need testing.

Recommendation: not the primary path. Keep as a fallback spike only if Node SEA packaging fails.

## Impacted files

Expected source/config changes for the migration:

- `codeview-ui/package.json`
  - Change `dev`, `build`, `preview` from `bun --bun ... vp` to Node-based invocations after linchpin passes.
  - Add direct `ws` dependency.
  - Add `cross-env` or a small runner script for portable env setup.
  - Add SEA packaging scripts.
  - Later remove `@jesterkit/exe-sveltekit`, `@eslym/sveltekit-adapter-bun`, `@types/bun`, and the `patchedDependencies` entry if no Bun runtime types remain.
- `codeview-ui/svelte.config.js`
  - Replace the local `@jesterkit/exe-sveltekit` adapter branch at `:11` with `@sveltejs/adapter-node`.
  - Keep Cloudflare branch at `:5-10`.
- `codeview-ui/vite.config.ts`
  - Replace `localWebSocket()` implementation at `:18-108` with a Node `http` + `ws` side-port server.
  - Keep plugin registration at `:110-123`, but the plugin should no longer depend on global `Bun`.
- `codeview-ui/src/lib/server/local/ws.ts`
  - Remove `import type { ServerWebSocket } from 'bun'` at `:9`.
  - Replace Bun-specific `createHandlers(...)` at `:114-166` with runtime-neutral lifecycle helpers.
  - Preserve `connections`, emit helpers, and `sendInitialState(...)`.
- `codeview-ui/src/lib/server/local/provider.ts`
  - Replace `Bun.file(...)` at `:628`.
  - Replace `handleWsUpgrade(...)` at `:1397-1419` or make it a non-upgrade fallback while Node custom server handles actual upgrades.
  - Export an explicit local provider initializer for Node WS startup if needed.
- `codeview-ui/src/lib/server/local/cache.ts`
  - Replace Bun SQLite imports at `:1-31` and DB construction at `:98-104`.
- `codeview-ui/src/app.d.ts`
  - Replace `server?: import('bun').Server` at `:9-12` with no local server platform type, or with a Node-specific type only if still needed.
- `codeview-ui/src/routes/api/events/ws/+server.ts`
  - Keep route shape for Cloudflare/non-upgrade behavior, but local Node production should not rely on SvelteKit route handlers for HTTP upgrade.
- New `codeview-ui/server/codeview-server.mjs` or `codeview-ui/scripts/server-node.mjs`
  - Custom adapter-node HTTP server plus WS upgrade handling.
- New `codeview-ui/scripts/build-sea.mjs`
  - Bundle custom server, package assets, generate SEA config, run `node --build-sea` or old postject path.
- `codeview-cli/build.rs`
  - Replace `bun run build` plus `EXE_TARGET` assumptions at `:88-95` with UI build plus SEA build.
  - Continue copying `dist/codeview-server(.exe)` to `codeview-cli/sidecar/...` at `:101-115`.
- `codeview-cli/src/main.rs`
  - Likely unchanged for runtime spawn. Re-test `:544-593` and `:749-755` with the SEA output.
- CI/release pipeline
  - Add Node version pin.
  - Add target Node executable download or per-platform SEA build matrix.
  - Add optional Windows signing.
- Cloudflare path
  - No intended behavior change. Verify `cf:check` and `cf:build`.

## Migration sequence

### Phase 0: unblock the dev linchpin

Goal: prove Vite+ 0.2.2 dev SSR under Node returns 200 before touching architecture.

Steps:

1. Create or use a minimal SvelteKit app with the same `@sveltejs/kit`, Vite+, and Node versions.
2. Run `PUBLIC_CODEVIEW_PLATFORM=local node node_modules/vite-plus/bin/vp dev`.
3. Poll `http://localhost:5173/`.
4. Test Node 22 LTS, 24 LTS, and current.
5. If minimal fails, file upstream Vite+ issue with the `fetchModule` timeout log.
6. If minimal passes, bisect Codeview Vite/Svelte config and plugins until the Node dev timeout is isolated.

Exit criteria:

```text
curl.exe -s -o NUL -w "%{http_code}" http://localhost:5173/
200
```

### Phase 1: make local server code Node-compatible

1. Replace `bun:sqlite` in `LocalCache`.
2. Replace `Bun.file(...).stream()` with Node stream code.
3. Remove Bun websocket types from `ws.ts`.
4. Keep Cloudflare provider isolated through `$provider`.

Verify:

```text
cd codeview-ui
vp run check
vp test
```

Add focused tests for LocalCache migrations/status queries if current tests do not cover them.

### Phase 2: Node dev WS side-port

1. Implement Node `http` + `ws` side server in `vite.config.ts`.
2. Keep port 15173.
3. Reuse `sendInitialState(...)`, `connections`, and emit helpers.
4. Ensure Vite server close also closes the WS side server.

Verify:

```text
cd codeview-ui
PUBLIC_CODEVIEW_PLATFORM=local node node_modules/vite-plus/bin/vp dev
curl.exe -s -o NUL -w "%{http_code}" http://localhost:5173/
```

Then run a small browser or Node websocket client against:

```text
ws://localhost:15173/api/events/ws
```

Expected: `connected` ack, `ping` returns `pong`, subscribe receives initial state where applicable.

### Phase 3: adapter-node local production server

1. Switch local SvelteKit adapter to adapter-node.
2. Add custom Node server entry that imports adapter-node `handler.js`.
3. Attach `ws` upgrade handling on `/api/events/ws`.
4. Initialize local provider internals for WS.
5. Ensure `PORT`, `CODEVIEW_GRAPH`, and `CODEVIEW_WORKSPACE` still work.

Verify:

```text
cd codeview-ui
PUBLIC_CODEVIEW_PLATFORM=local node node_modules/vite-plus/bin/vp build
$env:PORT='5174'
$env:CODEVIEW_GRAPH='E:\path\to\graph.json'
node build/codeview-server.mjs
curl.exe -s -o NUL -w "%{http_code}" http://localhost:5174/
```

Also verify production websocket on:

```text
ws://localhost:5174/api/events/ws
```

### Phase 4: SEA packaging spike

1. Bundle custom server into one JS SEA entry.
2. Decide asset strategy:
   - preferred spike A: embed client/prerendered assets as SEA assets and serve from `node:sea`;
   - pragmatic spike B: embed compressed build payload, extract to temp, then run server from extracted files.
3. Generate `dist/codeview-server.exe`.
4. Run it directly with `PORT` and `CODEVIEW_GRAPH`.

Verify:

```text
cd codeview-ui
.\dist\codeview-server.exe
curl.exe -s -o NUL -w "%{http_code}" http://localhost:<port>/
```

### Phase 5: Rust build integration

1. Update `codeview-cli/build.rs` to invoke the new UI build and SEA packaging script.
2. Preserve sidecar output names.
3. Preserve `CODEVIEW_SKIP_SIDECAR=1`.
4. Keep `codeview-cli/src/main.rs` runtime extraction/spawn path unless the SEA artifact needs a different extension/name.

Verify:

```text
cargo run --manifest-path Cargo.toml -p codeview-cli -- ui --graph E:\path\to\graph.json --port 5175
curl.exe -s -o NUL -w "%{http_code}" http://localhost:5175/
```

### Phase 6: Cloudflare regression check

Verify hosted path remains isolated:

```text
cd codeview-ui
vp run cf:check
vp run cf:build
```

## Risks

- Dev fix not proven: the required Node `vp dev` experiment failed under Node 25.6.1 and Node 24.18.0.
- SEA packaging is not equivalent to Bun compile. Adapter-node output is multi-file; SEA wants a bundled main or deliberate extraction/bootstrap.
- Windows signing and AV reputation can affect distributability even when unsigned binaries run locally.
- Node `node:sqlite` is still marked release-candidate in current docs; Drizzle integration may require custom work.
- Avoid native SQLite addons if the final artifact must stay single-file and self-contained.
- WS upgrade behavior changes ownership from SvelteKit route/Bun adapter to a custom Node HTTP server. This must be tested for reconnect, heartbeat, subscribe/unsubscribe, and parse progress.
- Dev HMR and side-port WS must share the same Vite SSR module instances, or provider internals/connections can diverge.
- Cross-target SEA builds need target Node executables or per-platform CI jobs; `EXE_TARGET` from the Bun adapter does not carry over directly.
- The Rust CLI child-process contract depends on the sidecar being a normal executable that accepts `PORT`, `CODEVIEW_GRAPH`, and `CODEVIEW_WORKSPACE`.

## External documentation used

- Node.js Single Executable Applications: https://nodejs.org/api/single-executable-applications.html
- Node.js 25.5.0 release notes for `--build-sea`: https://nodejs.org/en/blog/release/v25.5.0
- Node.js SQLite: https://nodejs.org/api/sqlite.html
- SvelteKit adapter-node docs: https://svelte.dev/docs/kit/adapter-node
- Deno compile docs: https://docs.deno.com/runtime/reference/cli/compile/
- Deno Node/npm compatibility: https://docs.deno.com/runtime/fundamentals/node/
- Deno SvelteKit support notes: https://docs.deno.com/deploy/reference/frameworks/
