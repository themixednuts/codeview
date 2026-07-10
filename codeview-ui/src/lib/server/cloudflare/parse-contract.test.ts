import { describe, expect, test } from 'vitest';
import {
	makeParseRequest,
	shouldAcceptQueuedParseRequest,
	type StoredParseStatus,
} from './parse-contract';

function storedStatus(
	status: StoredParseStatus['status'],
	updatedAt = '2026-07-09T12:00:00.000Z',
): StoredParseStatus {
	return {
		ecosystem: 'rust',
		kind: 'crate',
		name: 'serde',
		version: '1.0.228',
		status,
		createdAt: '2026-07-09T11:00:00.000Z',
		updatedAt,
		sequence: 1,
	};
}

describe('queued parse registration', () => {
	test('accepts work with no existing status', () => {
		expect(shouldAcceptQueuedParseRequest(null, makeParseRequest('serde', '1.0.228', false))).toBe(
			true,
		);
	});

	test('does not replace active work', () => {
		expect(
			shouldAcceptQueuedParseRequest(
				storedStatus('processing'),
				makeParseRequest('serde', '1.0.228', true),
			),
		).toBe(false);
	});

	test('replaces an older terminal status', () => {
		expect(
			shouldAcceptQueuedParseRequest(
				storedStatus('ready', '2020-01-01T00:00:00.000Z'),
				makeParseRequest('serde', '1.0.228', false),
			),
		).toBe(true);
	});

	test('rejects a delayed registration older than the terminal status', () => {
		const request = {
			...makeParseRequest('serde', '1.0.228', false),
			requestedAt: '2026-07-09T11:59:59.000Z',
		};
		expect(shouldAcceptQueuedParseRequest(storedStatus('failed'), request)).toBe(false);
	});
});
