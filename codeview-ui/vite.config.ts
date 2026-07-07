import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite-plus';
import { randomUUID } from 'node:crypto';

const isCloudflare = process.env.PUBLIC_CODEVIEW_PLATFORM === 'cloudflare';

/** Fixed port for the dev-mode Bun WebSocket server. */
const DEV_WS_PORT = 15173;

function readWsMessage(msg: unknown): string {
	if (typeof msg === 'string') return msg;
	if (Buffer.isBuffer(msg)) return msg.toString('utf8');
	if (Array.isArray(msg)) return Buffer.concat(msg).toString('utf8');
	if (msg instanceof ArrayBuffer) return Buffer.from(msg).toString('utf8');
	return String(msg);
}

/**
 * Dev-mode WebSocket bridge using Bun's native WebSocket API.
 *
 * Vite intercepts WebSocket upgrades before SvelteKit routes, so the
 * `/api/events/ws` route never fires in `vite dev`. This plugin starts
 * a Bun.serve() with native WebSocket on a side port. The client
 * connects directly via import.meta.env.DEV.
 */
function localWebSocket(): Plugin {
	return {
		name: 'local-websocket',
		apply: 'serve',
		async configureServer(viteServer) {
			if (isCloudflare) return;
			if (process.env.VITEST) return;

			// Shared module references (loaded lazily via Vite SSR pipeline)
			let wsMod: Record<string, any> | null = null;
			let providerMod: Record<string, any> | null = null;

			const loadModules = async () => {
				if (wsMod && providerMod) return;
				[wsMod, providerMod] = await Promise.all([
					viteServer.ssrLoadModule('/src/lib/server/local/ws.ts'),
					viteServer.ssrLoadModule('/src/lib/server/local/provider.ts'),
				]);
				console.log('[local-ws] modules loaded via ssrLoadModule');
			};

			if (typeof Bun === 'undefined' || typeof Bun.serve !== 'function') {
				const [{ createServer }, { WebSocketServer }] = await Promise.all([
					import('node:http'),
					import('ws'),
				]);
				const httpServer = createServer((_, res) => {
					res.writeHead(426, { 'content-type': 'text/plain' });
					res.end('WebSocket upgrade required');
				});
				const wss = new WebSocketServer({ server: httpServer, path: '/api/events/ws' });

				wss.on('connection', (socket) => {
					const connectionId = randomUUID();
					const send = (data: string) => {
						if (socket.readyState === socket.OPEN) socket.send(data);
					};

					loadModules()
						.then(() => {
							wsMod!.connections.set(connectionId, { ws: { send }, tags: new Set<string>() });
							send(JSON.stringify({ type: 'connected', connectionId }));
							console.log('[local-ws] node open connectionId=' + connectionId);
						})
						.catch((err) => {
							console.error('[local-ws] node module load error:', err);
							socket.close();
						});

					socket.on('message', (msg) => {
						if (!wsMod) return;
						const raw = readWsMessage(msg);
						let parsed: { action?: string; tags?: string[] };
						try {
							parsed = JSON.parse(raw);
						} catch {
							return;
						}

						const conn = wsMod.connections.get(connectionId);
						if (!conn) return;

						if (parsed.action === 'ping') {
							send(JSON.stringify({ type: 'pong' }));
							return;
						}

						if (parsed.action === 'subscribe' && parsed.tags?.length) {
							for (const tag of parsed.tags) conn.tags.add(tag);
							const internals = providerMod?.getProviderInternals?.();
							if (internals) {
								void wsMod.sendInitialState({ send }, parsed.tags, internals);
							}
						} else if (parsed.action === 'unsubscribe' && parsed.tags?.length) {
							for (const tag of parsed.tags) conn.tags.delete(tag);
						}
					});

					socket.on('close', () => {
						console.log('[local-ws] node close connectionId=' + connectionId);
						wsMod?.connections.delete(connectionId);
					});
				});

				httpServer.listen(DEV_WS_PORT, '127.0.0.1', () => {
					console.log(`[local-ws] Node WebSocket server on port ${DEV_WS_PORT}`);
				});
				viteServer.httpServer?.once('close', () => {
					wss.close();
					httpServer.close();
				});
				return;
			}

			type WsData = { connectionId: string };

			Bun.serve<WsData>({
				port: DEV_WS_PORT,
				fetch(req, server) {
					if (server.upgrade(req, { data: { connectionId: randomUUID() } })) {
						return undefined as unknown as Response;
					}
					return new Response('WebSocket upgrade required', { status: 426 });
				},
				websocket: {
					open(ws) {
						const connectionId = ws.data.connectionId;
						console.log('[local-ws] open connectionId=' + connectionId);

						loadModules()
							.then(() => {
								const conn = {
									ws: ws as unknown as { send(data: string): void },
									tags: new Set<string>(),
								};
								wsMod!.connections.set(connectionId, conn);
								ws.send(JSON.stringify({ type: 'connected', connectionId }));
								console.log('[local-ws] sent connected, id=' + connectionId);
							})
							.catch((err) => {
								console.error('[local-ws] module load error:', err);
								ws.close();
							});
					},
					message(ws, msg) {
						if (!wsMod) return;
						const raw = typeof msg === 'string' ? msg : new TextDecoder().decode(msg);
						let parsed: { action?: string; tags?: string[] };
						try {
							parsed = JSON.parse(raw);
						} catch {
							return;
						}

						const conn = wsMod.connections.get(ws.data.connectionId);
						if (!conn) return;

						if (parsed.action === 'ping') {
							ws.send(JSON.stringify({ type: 'pong' }));
							return;
						}

						if (parsed.action === 'subscribe' && parsed.tags?.length) {
							for (const tag of parsed.tags) conn.tags.add(tag);
							const internals = providerMod?.getProviderInternals?.();
							if (internals) {
								wsMod.sendInitialState(ws, parsed.tags, internals);
							}
						} else if (parsed.action === 'unsubscribe' && parsed.tags?.length) {
							for (const tag of parsed.tags) conn.tags.delete(tag);
						}
					},
					close(ws) {
						console.log('[local-ws] close connectionId=' + ws.data.connectionId);
						wsMod?.connections.delete(ws.data.connectionId);
					},
				},
			});

			console.log(`[local-ws] Bun WebSocket server on port ${DEV_WS_PORT}`);
		},
	};
}

export default defineConfig({
	plugins: [tailwindcss(), sveltekit(), localWebSocket()],
	css: { devSourcemap: true },
	server: {
		watch: {
			ignored: [
				'**/.wrangler/**',
				'**/.codeview-static/**',
				'**/build/**',
				'**/dist/**',
				'**/test-results/**',
				'**/playwright-report/**',
			],
		},
	},
	build: {
		sourcemap: !isCloudflare,
		minify: false,
	},
	resolve: {
		...(process.env.VITEST ? { conditions: ['browser'] } : {}),
	},
	test: {
		include: ['src/**/*.{test,spec}.{js,ts}'],
	},
});
