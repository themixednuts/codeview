import type { ParserAdapter, ParseResult, SourceFiles } from './types';
import { resolveRootFileForCrate } from './cargo-manifest';

/**
 * WASM-based rustdoc parser.
 *
 * Wraps codeview-rustdoc's `extract_graph` / `extract_graph_with_sources`
 * compiled to WASM via wasm-bindgen.
 *
 * TODO: Replace the stub with actual WASM import once codeview-rustdoc
 * is compiled with `wasm-pack build --target web --features wasm --no-default-features`.
 */

let wasmModule: WasmModule | null = null;

interface WasmModule {
	extract_graph(json: string, crate_name: string): string;
	extract_graph_with_sources(
		json: string,
		crate_name: string,
		source_files_json: string,
		root_file: string
	): string;
}

async function loadWasm(): Promise<WasmModule> {
	if (wasmModule) return wasmModule;

	// Dynamic import of the WASM package — path will be configured at build time
	// const mod = await import('codeview-rustdoc-wasm');
	// wasmModule = mod;
	// return wasmModule;

	throw new Error(
		'WASM parser not yet available. Build codeview-rustdoc with: wasm-pack build --target web --features wasm --no-default-features'
	);
}


export function createRustdocWasmParser(): ParserAdapter {
	return {
		async parse(artifact, name, version, sourceFiles) {
			const wasm = await loadWasm();

			const json = typeof artifact === 'string' ? artifact : new TextDecoder().decode(artifact);
			const crateName = name.replace(/-/g, '_');

			let resultJson: string;

			if (sourceFiles && sourceFiles.size > 0) {
				// Convert Map to plain object for JSON serialization
				const sourcesObj: Record<string, string> = {};
				for (const [path, content] of sourceFiles) {
					sourcesObj[path] = content;
				}
			const rootFile = resolveRootFileForCrate(name, sourceFiles) ?? 'src/lib.rs';
				resultJson = wasm.extract_graph_with_sources(
					json,
					crateName,
					JSON.stringify(sourcesObj),
				rootFile
				);
			} else {
				resultJson = wasm.extract_graph(json, crateName);
			}

			const graph = JSON.parse(resultJson);

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
