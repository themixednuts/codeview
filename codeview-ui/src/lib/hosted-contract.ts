import { STATIC_ARTIFACT_SCHEMA_VERSION } from "#lib/schema.js";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

export const HOSTED_ARTIFACT_CACHE_NAMESPACE = `hosted-artifact-v${STATIC_ARTIFACT_SCHEMA_VERSION}`;

type HostedArtifactExpectation = {
  name: string;
  version: string;
};

const HostedArtifactMetadata = Schema.Struct({
  schema_version: Schema.Literal(STATIC_ARTIFACT_SCHEMA_VERSION),
  name: Schema.String,
  version: Schema.String,
  index: Schema.Unknown,
  artifacts: Schema.Struct({
    kindIndex: Schema.Literal(true),
    nodeViewBucketCount: Schema.Number,
    treeChildrenBucketCount: Schema.Number,
    aliasBucketCount: Schema.Number,
    searchPrefixLength: Schema.Literal(2),
  }),
});

type HostedArtifactMetadataInput = {
  schema_version: number;
  name: string;
  version: string;
  artifacts: {
    kindIndex: boolean;
    nodeViewBucketCount: number;
    treeChildrenBucketCount: number;
    aliasBucketCount: number;
    searchPrefixLength: number;
  };
};

export function isCurrentHostedArtifactMetadata(
  value: HostedArtifactMetadataInput | Schema.Json | null,
  expected?: HostedArtifactExpectation,
): boolean {
  if (value === null) return false;
  const metadata = Option.getOrUndefined(Schema.decodeUnknownOption(HostedArtifactMetadata)(value));
  if (!metadata) return false;
  if (expected && (metadata.name !== expected.name || metadata.version !== expected.version)) {
    return false;
  }
  if (!Predicate.isObjectOrArray(metadata.index)) return false;

  const artifacts = metadata.artifacts;
  return (
    artifacts.kindIndex === true &&
    isPositiveInteger(artifacts.nodeViewBucketCount) &&
    isPositiveInteger(artifacts.treeChildrenBucketCount) &&
    isPositiveInteger(artifacts.aliasBucketCount) &&
    artifacts.searchPrefixLength === 2
  );
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && Number(value) > 0;
}
