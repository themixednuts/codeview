import type { Ecosystem } from '../registry/types';
import type { SourceAdapter } from './types';
import { createRustSourceAdapter } from './rust';

const adapters = new Map<Ecosystem, SourceAdapter>();

export function getSourceAdapter(ecosystem: Ecosystem): SourceAdapter {
	let adapter = adapters.get(ecosystem);
	if (adapter) return adapter;

	switch (ecosystem) {
		case 'rust':
			adapter = createRustSourceAdapter();
			break;
		default:
			throw new Error(`No source adapter for ecosystem: ${ecosystem}`);
	}

	adapters.set(ecosystem, adapter);
	return adapter;
}
