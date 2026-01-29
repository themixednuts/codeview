import type { Ecosystem, RegistryAdapter } from './types';
import { createCratesIoAdapter } from './crates-io';

const adapters = new Map<Ecosystem, RegistryAdapter>();

export function getRegistry(ecosystem: Ecosystem): RegistryAdapter {
	let adapter = adapters.get(ecosystem);
	if (adapter) return adapter;

	switch (ecosystem) {
		case 'rust':
			adapter = createCratesIoAdapter();
			break;
		default:
			throw new Error(`No registry adapter for ecosystem: ${ecosystem}`);
	}

	adapters.set(ecosystem, adapter);
	return adapter;
}
