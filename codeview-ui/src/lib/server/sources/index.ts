import { Result } from 'better-result';
import type { Ecosystem } from '../registry/types';
import type { SourceAdapter } from './types';
import { createRustSourceAdapter } from './rust';
import { UnsupportedEcosystemError } from '../errors';

const adapters = new Map<Ecosystem, SourceAdapter>();

export function getSourceAdapter(ecosystem: Ecosystem): Result<SourceAdapter, UnsupportedEcosystemError> {
	let adapter = adapters.get(ecosystem);
	if (adapter) return Result.ok(adapter);

	switch (ecosystem) {
		case 'rust':
			adapter = createRustSourceAdapter();
			break;
		default:
			return Result.err(new UnsupportedEcosystemError({ ecosystem, adapterKind: 'source' }));
	}

	adapters.set(ecosystem, adapter);
	return Result.ok(adapter);
}
