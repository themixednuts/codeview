# Project Rules

## Running the Project

Build + run via cargo (the `--` separates cargo args from binary args):
```
cargo run -p codeview-cli -- ui {path}
```

Examples:
- `cargo run -p codeview-cli -- ui .`
- `cargo run -p codeview-cli -- ui e:\projects\my-crate`
- `cargo run -p codeview-cli -- ui . --open` (also opens the browser)
- `cargo run -p codeview-cli -- ui . -- --all-features`

This compiles the CLI, runs rustdoc analysis, spawns the UI server, and prints the URL. The server picks a **random port** each time — read the port from the output line `Codeview UI running at http://127.0.0.1:{port}`. Pass `--open` to also open the browser. The server process is tied to the CLI lifetime and terminates automatically when the CLI exits.

After starting the local server as a background task, wait for it to be ready:
```bash
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:{port}/ 2>/dev/null)
  [ "$code" = "200" ] && echo "ready" && break
  sleep 2
done
```

The binary is named `codeview` (not `codeview-cli`). Once built, you can run it directly:
```
codeview ui .
codeview ui . --open
```

To list running server instances:
```
cargo run -p codeview-cli -- ps
```

To generate a graph without opening the UI:
```
cargo run -p codeview-cli -- analyze --manifest-path {path/Cargo.toml} --out {output.json}
```

## Package Manager

Use **bun** for all package management operations:
- Install: `bun add <package>` or `bun add -D <package>` for dev dependencies
- Run scripts: `bun run <script>`
- Execute: `bunx <command>`

Do not use npm, yarn, or pnpm.

## Cloudflare Dev Server

Run the hosted/Cloudflare mode dev server with:
```
cd /e/Projects/codeview/codeview-ui && bun run cf:dev
```

This runs `cf:build` first (builds the SvelteKit app), then starts wrangler dev. Use `/e/...` Unix-style paths in Bash (not `E:\...` Windows paths — Git Bash doesn't handle them).

Run this as a **background task**. When you need to restart (e.g. after changing server code or config), stop the existing task first, then re-run. After restarting, a hard refresh in the browser is sufficient — no need to stop/start manually between builds for client-only changes.

After starting the server, wait for it to be ready before navigating:
```bash
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/ 2>/dev/null)
  [ "$code" = "200" ] && echo "ready" && break
  sleep 2
done
```

To clear all wrangler persisted state (Durable Objects, R2, KV) and start fresh:
```
cd /e/Projects/codeview/codeview-ui && bun run cf:dev:clear
```

## Bash Commands

Never filter or truncate bash command output with `head`, `tail`, `2>&1`, or similar. The tool handles output limits automatically. If you need to search output, run the command first, then grep/search the result separately.

When using Playwright to test, the browser has a persistent HTTP disk cache. If you see `net::ERR_ABORTED` / 404 errors for `_app/immutable/chunks/` files that actually exist on disk (curl returns 200), clear the browser cache via CDP before navigating:
```js
const client = await page.context().newCDPSession(page);
await client.send('Network.clearBrowserCache');
```
