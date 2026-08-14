import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import * as Predicate from "effect/Predicate";
import { defineConfig, lazyPlugins, type Plugin } from "vite-plus";
import type { RawData } from "ws";
import type { LocalProviderInternals } from "./src/lib/server/local/ws";

type LocalWsModule = {
  connections: Map<string, { ws: { send(data: string): void }; tags: Set<string> }>;
  sendInitialState: (
    socket: { send: (data: string) => void },
    tags: string[],
    internals: LocalProviderInternals,
  ) => void;
};

type LocalProviderModule = {
  getProviderInternals?: () => LocalProviderInternals | undefined;
};

const isCloudflare = process.env.PUBLIC_CODEVIEW_PLATFORM === "cloudflare";
const appVersion =
  process.env.CODEVIEW_VERSION ??
  process.env.GITHUB_SHA ??
  process.env.CF_VERSION_METADATA_ID ??
  "dev";

const DEV_WS_PORT = 15173;

function readWsMessage(msg: RawData): string {
  if (Predicate.isString(msg)) return msg;
  if (Buffer.isBuffer(msg)) return msg.toString("utf8");
  if (Array.isArray(msg)) return Buffer.concat(msg).toString("utf8");
  if (msg instanceof ArrayBuffer) return Buffer.from(msg).toString("utf8");
  return String(msg);
}

function localWebSocket(): Plugin {
  return {
    name: "local-websocket",
    apply: "serve",
    async configureServer(viteServer) {
      if (isCloudflare) return;
      if (process.env.VITEST) return;

      let wsMod: LocalWsModule | null = null;
      let providerMod: LocalProviderModule | null = null;

      const loadModules = async () => {
        if (wsMod && providerMod) return;
        const [nextWs, nextProvider] = await Promise.all([
          viteServer.ssrLoadModule("/src/lib/server/local/ws.ts"),
          viteServer.ssrLoadModule("/src/lib/server/local/provider.ts"),
        ]);
        if (
          !Predicate.isObject(nextWs) ||
          !("connections" in nextWs) ||
          !("sendInitialState" in nextWs) ||
          !Predicate.isFunction(nextWs.sendInitialState)
        ) {
          throw new TypeError("local websocket module is missing sendInitialState");
        }
        // SAFETY: the module was checked above for connections and sendInitialState.
        wsMod = nextWs as LocalWsModule;
        // SAFETY: Vite SSR reload returns a module object; we only use createProvider.
        providerMod = Predicate.isObject(nextProvider)
          ? (nextProvider as LocalProviderModule)
          : null;
      };

      const [{ createServer }, { WebSocketServer }] = await Promise.all([
        import("node:http"),
        import("ws"),
      ]);
      const httpServer = createServer((_, res) => {
        res.writeHead(426, { "content-type": "text/plain" });
        res.end("WebSocket upgrade required");
      });
      const wss = new WebSocketServer({ server: httpServer, path: "/api/events/ws" });

      wss.on("connection", (socket) => {
        const connectionId = randomUUID();
        const send = (data: string) => {
          if (socket.readyState === socket.OPEN) socket.send(data);
        };

        loadModules()
          .then(() => {
            wsMod!.connections.set(connectionId, { ws: { send }, tags: new Set<string>() });
            send(JSON.stringify({ type: "connected", connectionId }));
          })
          .catch((err) => {
            console.error("[local-ws] module load error:", err);
            socket.close();
          });

        socket.on("message", (msg) => {
          if (!wsMod) return;
          let parsed: { action?: string; tags?: string[] };
          try {
            parsed = JSON.parse(readWsMessage(msg));
          } catch {
            return;
          }

          const conn = wsMod.connections.get(connectionId);
          if (!conn) return;

          if (parsed.action === "ping") {
            send(JSON.stringify({ type: "pong" }));
            return;
          }

          if (parsed.action === "subscribe" && parsed.tags?.length) {
            for (const tag of parsed.tags) conn.tags.add(tag);
            const internals = providerMod?.getProviderInternals?.();
            if (internals) {
              wsMod.sendInitialState({ send }, parsed.tags, internals);
            }
          } else if (parsed.action === "unsubscribe" && parsed.tags?.length) {
            for (const tag of parsed.tags) conn.tags.delete(tag);
          }
        });

        socket.on("close", () => {
          wsMod?.connections.delete(connectionId);
        });
      });

      httpServer.listen(DEV_WS_PORT, "127.0.0.1", () => {
        console.log(`[local-ws] Node WebSocket server on port ${DEV_WS_PORT}`);
      });
      viteServer.httpServer?.once("close", () => {
        wss.close();
        httpServer.close();
      });
    },
  };
}

type ViteResolve = {
  alias: {
    $cloudflare: string;
    $provider: string;
    $realtime: string;
  };
  conditions?: string[];
};

const viteResolve: ViteResolve = {
  alias: {
    $cloudflare: resolve("src/lib/server/cloudflare"),
    $provider: isCloudflare
      ? resolve("src/lib/server/cloudflare/provider.ts")
      : resolve("src/lib/server/local/provider.ts"),
    $realtime: resolve("src/lib/ws/client.ts"),
  },
};
if (process.env.VITEST) viteResolve.conditions = ["browser"];

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {},
  lint: {
    ignorePatterns: [
      "src/service-worker.ts",
      "scripts/**",
      "tools/oxlint/**",
      "src/lib/components/ui/**",
      "playwright.config.ts",
      "e2e/**",
    ],
    jsPlugins: [
      { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
      { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
    ],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      "anti-slop/no-chained-type-assertions": "error",
      "anti-slop/no-conditional-empty-object-spread": "error",
      "anti-slop/no-known-value-widening": "error",
      "anti-slop/no-module-mocking": "error",
      "anti-slop/no-object-parameters": "error",
      "anti-slop/no-reflect-apply": "error",
      "anti-slop/no-reflect-get": "error",
      "anti-slop/no-runtime-typeof": "error",
      "anti-slop/no-shape-in-symbol-names": "error",
      "anti-slop/no-unknown-parameters": "error",
      "anti-slop/no-unknown-returns": "error",
      "anti-slop/no-unknown-type-aliases": "error",
      "anti-slop/no-unsafe-dictionary-type": "error",
      "anti-slop/no-widen-then-assert": "error",
      "anti-slop/require-safety-comment-for-type-assertion": "error",
    },
    options: { typeAware: true, typeCheck: true },
  },
  plugins: lazyPlugins(async () => {
    const adapter = isCloudflare
      ? undefined
      : (await import("@jesterkit/exe-sveltekit")).default({ binaryName: "codeview-server" });

    const kitPlugins = await sveltekit({
      adapter,
      compilerOptions: {
        runes: ({ filename }) =>
          filename.split(/[/\\]/).includes("node_modules") ? undefined : true,
        experimental: { async: true },
      },
      experimental: { remoteFunctions: true },
      version: {
        name: appVersion,
        pollInterval: 60_000,
      },
    });
    // Kit 3 stores sveltekit() options on api.options. Alchemy still looks for
    // the Kit 2 svelte.config.js shape api.options.kit when injecting its adapter.
    for (const plugin of kitPlugins) {
      if (plugin.name !== "vite-plugin-sveltekit-setup") continue;
      const api = plugin.api;
      if (!Predicate.isObject(api) || !("options" in api) || !Predicate.isObject(api.options)) {
        continue;
      }
      if (!("kit" in api.options) || api.options.kit === undefined) {
        api.options.kit = api.options;
      }
    }

    return [tailwindcss(), ...kitPlugins, localWebSocket()];
  }),
  css: { devSourcemap: true },
  server: {
    watch: {
      ignored: [
        "**/.wrangler/**",
        "**/.alchemy/**",
        "**/.codeview-static/**",
        "**/build/**",
        "**/dist/**",
        "**/test-results/**",
        "**/playwright-report/**",
      ],
    },
  },
  build: {
    sourcemap: !isCloudflare,
    minify: false,
  },
  resolve: viteResolve,
  test: {
    include: ["src/**/*.test.ts"],
  },
});
