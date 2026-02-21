import { error } from '@sveltejs/kit';
import type { Result } from 'better-result';
import { isValidCrateName, isValidVersion } from '$lib/server/validation';

const VERSION_ALIASES = new Set(['latest']);

function isAllowedVersion(version: string): boolean {
	return VERSION_ALIASES.has(version) || isValidVersion(version);
}

export function assertCrateName(name: string): void {
	if (!isValidCrateName(name)) {
		throw error(400, 'Invalid crate name');
	}
}

export function assertCrateRef(name: string, version: string): void {
	if (!isValidCrateName(name) || !isAllowedVersion(version)) {
		throw error(400, 'Invalid crate name or version');
	}
}

type ProviderError = { _tag: string; message: string };

export function throwIfProviderErr(
	result: Result<unknown, ProviderError>,
	statusByTag: Partial<Record<string, number>> = {},
	defaultStatus = 422,
): void {
	if (!result.isErr()) return;
	const err = result.error;
	throw error(statusByTag[err._tag] ?? defaultStatus, err.message);
}
