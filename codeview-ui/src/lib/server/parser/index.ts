import { Result } from 'better-result';
import type { Ecosystem } from '../registry/types';
import type { ParserAdapter } from './types';
import { createRustdocParser } from './rustdoc';
import { UnsupportedEcosystemError } from '../errors';

const adapters = new Map<Ecosystem, ParserAdapter>();

export function getParser(ecosystem: Ecosystem): Result<ParserAdapter, UnsupportedEcosystemError> {
	let adapter = adapters.get(ecosystem);
	if (adapter) return Result.ok(adapter);

	switch (ecosystem) {
		case 'rust':
			adapter = createRustdocParser();
			break;
		default:
			return Result.err(new UnsupportedEcosystemError({ ecosystem, adapterKind: 'parser' }));
	}

	adapters.set(ecosystem, adapter);
	return Result.ok(adapter);
}
