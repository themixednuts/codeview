import { Result } from 'better-result';
import type { NodeKind, Visibility } from '$lib/graph';

export type CrossEdgeNodeSummary = {
	id: string;
	name: string;
	kind: NodeKind;
	visibility: Visibility;
	is_external?: boolean;
};

export function summarizeCrossEdgeNode(
	id: string,
	isExternal: boolean,
): Result<CrossEdgeNodeSummary, Error> {
	return Result.try(() => {
		const parts = id.split('::');
		const name = parts[parts.length - 1] || id;
		const kind: NodeKind = isExternal ? 'ExternCrate' : 'Module';
		const summary: CrossEdgeNodeSummary = {
			id,
			name,
			kind,
			visibility: 'Unknown',
			...(isExternal ? { is_external: true } : {}),
		};
		return summary;
	});
}
