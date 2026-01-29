import type { Ecosystem } from '../registry/types';
import type { ParserAdapter } from './types';
import { createRustdocWasmParser } from './rustdoc-wasm';

const adapters = new Map<Ecosystem, ParserAdapter>();

export function getParser(ecosystem: Ecosystem): ParserAdapter {
	let adapter = adapters.get(ecosystem);
	if (adapter) return adapter;

	switch (ecosystem) {
		case 'rust':
			adapter = createRustdocWasmParser();
			break;
		default:
			throw new Error(`No parser adapter for ecosystem: ${ecosystem}`);
	}

	adapters.set(ecosystem, adapter);
	return adapter;
}
