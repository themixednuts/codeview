import { Result } from 'better-result';
import type { Ecosystem, RegistryAdapter } from './types';
import { createCratesIoAdapter } from './cratesio';
import { UnsupportedEcosystemError } from '../errors';

const adapters = new Map<Ecosystem, RegistryAdapter>();

export function getRegistry(ecosystem: Ecosystem): Result<RegistryAdapter, UnsupportedEcosystemError> {
	let adapter = adapters.get(ecosystem);
	if (adapter) return Result.ok(adapter);

	switch (ecosystem) {
		case 'rust':
			adapter = createCratesIoAdapter();
			break;
		default:
			return Result.err(new UnsupportedEcosystemError({ ecosystem, adapterKind: 'registry' }));
	}

	adapters.set(ecosystem, adapter);
	return Result.ok(adapter);
}
