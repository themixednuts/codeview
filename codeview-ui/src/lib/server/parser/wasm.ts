import { Result } from 'better-result';
import type { ParserAdapter, ParseResult } from './types';
import { resolveRootFileForCrate } from './manifest';

// vite-plugin-wasm-esm handles init: readFile in SSR, fetch in client.
const { extract_graph, extract_graph_with_sources, ensure_capacity } = await import('codeview-rustdoc');

const HYPHEN_RE = /-/g;
const textEncoder = new TextEncoder();

/** Yield to the event loop so SSE pushes and other I/O can proceed. */
const yieldTick = () => new Promise<void>((r) => setTimeout(r, 0));

export function createRustdocWasmParser(): ParserAdapter {
	return {
		async parse(artifact, name, version, sourceFiles) {
			// Convert to Uint8Array — avoid string → charCodeAt loop in wasm-bindgen
			let jsonBytes: Uint8Array;
			if (artifact instanceof Uint8Array) {
				jsonBytes = artifact;
			} else if (typeof artifact === 'string') {
				jsonBytes = textEncoder.encode(artifact);
			} else {
				jsonBytes = new Uint8Array(artifact);
			}

			const crateName = name.replace(HYPHEN_RE, '_');

			// Pre-grow WASM memory for the large input + overhead
			ensure_capacity(jsonBytes.byteLength * 2);

			// Yield before the blocking WASM call so SSE status updates flush
			await yieldTick();

			let resultJson: string;

			if (sourceFiles && sourceFiles.size > 0) {
				const sourcesObj: Record<string, string> = {};
				for (const [path, content] of sourceFiles) {
					sourcesObj[path] = content;
				}
				const sourcesStrResult = Result.try(() => JSON.stringify(sourcesObj));
				if (sourcesStrResult.isErr()) throw sourcesStrResult.error;
				const sourcesStr = sourcesStrResult.value;
				const sourcesBytes = textEncoder.encode(sourcesStr);
				const rootFile = resolveRootFileForCrate(name, sourceFiles) ?? 'src/lib.rs';

				resultJson = extract_graph_with_sources(
					jsonBytes, crateName, sourcesBytes, rootFile
				);
			} else {
				resultJson = extract_graph(jsonBytes, crateName);
			}

			const graphResult = Result.try(() => JSON.parse(resultJson));
			if (graphResult.isErr()) throw graphResult.error;
			const graph = graphResult.value;

			return {
				graph: {
					id: crateName,
					name: crateName,
					version,
					nodes: graph.nodes ?? [],
					edges: graph.edges ?? []
				},
				externalCrates: []
			} satisfies ParseResult;
		}
	};
}
