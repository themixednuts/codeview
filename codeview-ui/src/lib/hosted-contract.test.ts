import { describe, expect, test } from 'vitest';
import {
	HOSTED_ARTIFACT_CACHE_NAMESPACE,
	isCurrentHostedArtifactMetadata,
} from './hosted-contract';

function metadata(schemaVersion = 2) {
	return {
		schema_version: schemaVersion,
		name: 'serde',
		version: '1.0.228',
		index: {},
		artifacts: {
			kindIndex: true,
			nodeViewBucketCount: 128,
			treeChildrenBucketCount: 128,
			aliasBucketCount: 128,
			searchPrefixLength: 2,
		},
	};
}

describe('hosted artifact contract', () => {
	test('ties worker cache identity to the artifact schema', () => {
		expect(HOSTED_ARTIFACT_CACHE_NAMESPACE).toBe('hosted-artifact-v2');
	});

	test('accepts current metadata for the expected crate', () => {
		expect(isCurrentHostedArtifactMetadata(metadata(), { name: 'serde', version: '1.0.228' })).toBe(
			true,
		);
	});

	test('rejects stale and mismatched metadata', () => {
		expect(isCurrentHostedArtifactMetadata(metadata(1))).toBe(false);
		expect(isCurrentHostedArtifactMetadata(metadata(), { name: 'serde', version: '1.0.227' })).toBe(
			false,
		);
	});
});
