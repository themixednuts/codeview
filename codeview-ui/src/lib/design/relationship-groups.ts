import type { Edge, Node, NodeDetail, RelationshipGroup, RelationshipGroups } from '$lib/schema';
import { summarizeNode } from '$lib/node-summary';
import { edgeKindToRelation, REL_ORDER, type DesignRelation } from './live-node';

export type RelationshipDirection = 'incoming' | 'outgoing';

export function buildRelationshipGroups(
	edges: Edge[],
	relatedNodeMap: Map<string, Node>,
	direction: RelationshipDirection,
): RelationshipGroup[] {
	const groups = new Map<DesignRelation, Map<string, RelationshipGroup['items'][number]>>();
	for (const edge of edges) {
		const relation = edgeKindToRelation(edge.kind);
		const otherId = direction === 'incoming' ? edge.from : edge.to;
		const other = relatedNodeMap.get(otherId);
		if (!other) continue;
		const bucket = groups.get(relation.token) ?? new Map();
		const existing = bucket.get(otherId);
		if (existing) existing.count += 1;
		else bucket.set(otherId, { node: summarizeNode(other), count: 1 });
		groups.set(relation.token, bucket);
	}
	return REL_ORDER.filter((rel) => groups.has(rel)).map((rel) => {
		const info = groups.get(rel)!;
		const firstEdge = edges.find((edge) => edgeKindToRelation(edge.kind).token === rel);
		const relation = firstEdge ? edgeKindToRelation(firstEdge.kind) : null;
		return {
			rel,
			label: relation ? (direction === 'incoming' ? relation.in : relation.out) : rel,
			color: relation?.color ?? 'var(--edge-default)',
			items: Array.from(info.values()).sort((a, b) => a.node.name.localeCompare(b.node.name)),
		};
	});
}

export function buildNodeRelationshipGroups(
	detail: NodeDetail | null | undefined,
	selectedEdges?: { incoming: Edge[]; outgoing: Edge[] },
): RelationshipGroups {
	if (!detail) return { incoming: [], outgoing: [] };
	const edges =
		selectedEdges ??
		({
			incoming: detail.edges.filter((edge) => edge.to === detail.node.id),
			outgoing: detail.edges.filter((edge) => edge.from === detail.node.id),
		} satisfies { incoming: Edge[]; outgoing: Edge[] });
	const relatedNodeMap = new Map<string, Node>([
		[detail.node.id, detail.node],
		...detail.relatedNodes.map((node) => [node.id, node] as const),
	]);
	return {
		incoming: buildRelationshipGroups(edges.incoming, relatedNodeMap, 'incoming'),
		outgoing: buildRelationshipGroups(edges.outgoing, relatedNodeMap, 'outgoing'),
	};
}
