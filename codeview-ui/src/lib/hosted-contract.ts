import { STATIC_ARTIFACT_SCHEMA_VERSION } from '$lib/schema';

export const HOSTED_ARTIFACT_CACHE_NAMESPACE = `hosted-artifact-v${STATIC_ARTIFACT_SCHEMA_VERSION}`;

type HostedArtifactExpectation = {
	name: string;
	version: string;
};

export function isCurrentHostedArtifactMetadata(
	value: unknown,
	expected?: HostedArtifactExpectation,
): boolean {
	if (typeof value !== 'object' || value === null) return false;
	const metadata = value as Record<string, unknown>;
	if (metadata.schema_version !== STATIC_ARTIFACT_SCHEMA_VERSION) return false;
	if (typeof metadata.name !== 'string' || typeof metadata.version !== 'string') return false;
	if (expected && (metadata.name !== expected.name || metadata.version !== expected.version)) {
		return false;
	}
	if (typeof metadata.index !== 'object' || metadata.index === null) return false;
	if (typeof metadata.artifacts !== 'object' || metadata.artifacts === null) return false;

	const artifacts = metadata.artifacts as Record<string, unknown>;
	return (
		artifacts.kindIndex === true &&
		isPositiveInteger(artifacts.nodeViewBucketCount) &&
		isPositiveInteger(artifacts.treeChildrenBucketCount) &&
		isPositiveInteger(artifacts.aliasBucketCount) &&
		artifacts.searchPrefixLength === 2
	);
}

function isPositiveInteger(value: unknown): value is number {
	return Number.isInteger(value) && Number(value) > 0;
}
