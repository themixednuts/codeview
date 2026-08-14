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

Use **pnpm** for all package management operations:
- Install: `pnpm add --save-exact <package>` or `pnpm add -D --save-exact <package>`
- Run scripts: `pnpm <script>` or `vp <script>`
- Execute: `pnpm dlx <command>` or `vp dlx <command>`

Do not use bun, npm, or yarn.

## Cloudflare Dev Server

Run the hosted/Cloudflare mode dev server with:
```
cd codeview-ui && pnpm infra:dev
```

Alchemy owns Cloudflare resources (`alchemy.run.ts`). `alchemy dev` runs Kit's Vite server with live bindings. After changing server or infra code, stop the existing task and re-run. Client-only changes only need a hard refresh.

After starting the server, wait for it to be ready before navigating:
```bash
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/ 2>/dev/null)
  [ "$code" = "200" ] && echo "ready" && break
  sleep 2
done
```

To clear Alchemy/Wrangler persisted state and start fresh:
```
cd codeview-ui && pnpm cf:dev:clear
```

## Build Lock Issues

If builds fail with `EPERM, Permission denied` on `.wrangler` or `.svelte-kit/cloudflare`, a process is holding a lock. Use Sysinternals Handle to find and kill it:

```bash
# Find what's holding the lock
handle .wrangler
handle .svelte-kit

# Kill the process by PID
taskkill //F //PID <pid>
```

Common culprits: `workerd.exe`, `node.exe`, `esbuild.exe`.

## Local Cache

The local mode uses a SQLite cache at `~/.codeview/cache.sqlite` (defined in `codeview-ui/src/lib/server/local/cache.ts`). To clear for a fresh start:
```bash
rm ~/.codeview/cache.sqlite
```

The local server also stores rustdoc analysis at `target/codeview/graph.json`.

## Bash Commands

Never filter or truncate bash command output with `head`, `tail`, `2>&1`, or similar. The tool handles output limits automatically. If you need to search output, run the command first, then grep/search the result separately.

When using Playwright to test, the browser has a persistent HTTP disk cache. If you see `net::ERR_ABORTED` / 404 errors for `_app/immutable/chunks/` files that actually exist on disk (curl returns 200), clear the browser cache via CDP before navigating:
```js
const client = await page.context().newCDPSession(page);
await client.send('Network.clearBrowserCache');
```
