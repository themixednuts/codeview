import type { Edge, EdgeKind, Graph, Node, NodeKind } from '$lib/graph';
import type { LayoutMode } from '$lib/graph/layout';
import { filterEdges } from '$lib/renderers/graph';

export const GRAPH_PROJECTION_NODE_CAP = 180;
export const GRAPH_PROJECTION_EDGE_CAP = 360;
export const GRAPH_PROJECTION_MAX_HOPS = 1;

const TRAIT_LIKE_KINDS = new Set<NodeKind>(['Trait', 'TraitAlias']);
const INTERNAL_ONLY_KINDS = new Set<NodeKind>([
	'Impl',
	'StructField',
	'Variant',
	'AssocType',
	'AssocConst',
]);
const SUMMARY_NODE_PREFIX = '__cv_graph_summary__';

type NodeTraitAccumulator = {
	ids: Set<string>;
	names: Set<string>;
};

type OverflowNodeInfo = {
	incoming: number;
	outgoing: number;
	incomingKinds: Set<EdgeKind>;
	outgoingKinds: Set<EdgeKind>;
};

export type GraphTraitMetadata = {
	traitCount: number;
	traitIds: string[];
	traitNames: string[];
};

export type GraphProjectionResult = {
	graph: Graph;
	traitMetadataByNodeId: Map<string, GraphTraitMetadata>;
	syntheticNodeIds: Set<string>;
};

type GraphProjectionOptions = {
	showStructural: boolean;
	showSemantic: boolean;
	layoutMode: LayoutMode;
	maxNodes?: number;
	maxEdges?: number;
	maxHops?: number;
	includeTraitNodes?: boolean;
	includeInternalNodes?: boolean;
};

function edgeKindPriority(kind: EdgeKind): number {
	switch (kind) {
		case 'UsesType':
			return 0;
		case 'CallsStatic':
			return 1;
		case 'CallsRuntime':
			return 2;
		case 'Implements':
			return 3;
		case 'Derives':
			return 4;
		case 'Contains':
			return 5;
		case 'Defines':
			return 6;
		case 'ReExports':
			return 7;
	}
}

function shouldHideNode(node: Node, selectedId: string, opts: GraphProjectionOptions): boolean {
	if (node.id === selectedId) return false;
	if (!opts.includeTraitNodes && TRAIT_LIKE_KINDS.has(node.kind)) return true;
	if (!opts.includeInternalNodes && INTERNAL_ONLY_KINDS.has(node.kind)) return true;
	return false;
}

function buildNodeMap(nodes: Node[]): Map<string, Node> {
	const map = new Map<string, Node>();
	for (const node of nodes) {
		map.set(node.id, node);
	}
	return map;
}

function collectTraitMetadata(
	nodeMap: Map<string, Node>,
	edges: Edge[],
): Map<string, GraphTraitMetadata> {
	const accumulators = new Map<string, NodeTraitAccumulator>();

	for (const edge of edges) {
		if (edge.kind !== 'Implements') continue;
		const source = nodeMap.get(edge.from);
		const target = nodeMap.get(edge.to);
		if (!source || !target) continue;
		if (!TRAIT_LIKE_KINDS.has(target.kind)) continue;

		let acc = accumulators.get(source.id);
		if (!acc) {
			acc = { ids: new Set<string>(), names: new Set<string>() };
			accumulators.set(source.id, acc);
		}
		acc.ids.add(target.id);
		acc.names.add(target.name);
	}

	const metadata = new Map<string, GraphTraitMetadata>();
	for (const [nodeId, acc] of accumulators) {
		metadata.set(nodeId, {
			traitCount: acc.ids.size,
			traitIds: Array.from(acc.ids).sort((a, b) => a.localeCompare(b)),
			traitNames: Array.from(acc.names).sort((a, b) => a.localeCompare(b)),
		});
	}

	return metadata;
}

function collectHopNodeIds(selectedId: string, edges: Edge[], maxHops: number): Set<string> {
	const adjacency = new Map<string, Set<string>>();
	for (const edge of edges) {
		if (!adjacency.has(edge.from)) adjacency.set(edge.from, new Set<string>());
		if (!adjacency.has(edge.to)) adjacency.set(edge.to, new Set<string>());
		adjacency.get(edge.from)!.add(edge.to);
		adjacency.get(edge.to)!.add(edge.from);
	}

	const seen = new Set<string>([selectedId]);
	let frontier = new Set<string>([selectedId]);

	for (let hop = 0; hop < maxHops; hop++) {
		const next = new Set<string>();
		for (const nodeId of frontier) {
			for (const neighbor of adjacency.get(nodeId) ?? []) {
				if (seen.has(neighbor)) continue;
				seen.add(neighbor);
				next.add(neighbor);
			}
		}
		if (next.size === 0) break;
		frontier = next;
	}

	return seen;
}

function capNodesAroundSelection(
	nodeIds: Set<string>,
	edges: Edge[],
	nodeMap: Map<string, Node>,
	selectedId: string,
	maxNodes: number,
): { keptNodeIds: Set<string>; overflow: OverflowNodeInfo } {
	const overflow: OverflowNodeInfo = {
		incoming: 0,
		outgoing: 0,
		incomingKinds: new Set<EdgeKind>(),
		outgoingKinds: new Set<EdgeKind>(),
	};

	if (nodeIds.size <= maxNodes) {
		return { keptNodeIds: nodeIds, overflow };
	}

	type NeighborStats = {
		id: string;
		weight: number;
		incoming: number;
		outgoing: number;
	};

	const neighborStats = new Map<string, NeighborStats>();
	for (const edge of edges) {
		if (edge.from === selectedId && nodeIds.has(edge.to) && edge.to !== selectedId) {
			const existing = neighborStats.get(edge.to) ?? {
				id: edge.to,
				weight: 0,
				incoming: 0,
				outgoing: 0,
			};
			existing.weight += 1;
			existing.outgoing += 1;
			neighborStats.set(edge.to, existing);
		}
		if (edge.to === selectedId && nodeIds.has(edge.from) && edge.from !== selectedId) {
			const existing = neighborStats.get(edge.from) ?? {
				id: edge.from,
				weight: 0,
				incoming: 0,
				outgoing: 0,
			};
			existing.weight += 1;
			existing.incoming += 1;
			neighborStats.set(edge.from, existing);
		}
	}

	const rankedNeighbors = Array.from(neighborStats.values()).sort((a, b) => {
		if (b.weight !== a.weight) return b.weight - a.weight;
		const nameA = nodeMap.get(a.id)?.name ?? a.id;
		const nameB = nodeMap.get(b.id)?.name ?? b.id;
		return nameA.localeCompare(nameB);
	});

	const reserveSummarySlot = maxNodes > 1 ? 1 : 0;
	const keepBudget = Math.max(0, maxNodes - 1 - reserveSummarySlot);
	const keepNeighborIds = new Set<string>(
		rankedNeighbors.slice(0, keepBudget).map((entry) => entry.id),
	);

	const keptNodeIds = new Set<string>([selectedId]);
	for (const nodeId of keepNeighborIds) {
		keptNodeIds.add(nodeId);
	}

	for (const entry of rankedNeighbors) {
		if (keepNeighborIds.has(entry.id)) continue;
		if (entry.incoming > 0) overflow.incoming += 1;
		if (entry.outgoing > 0) overflow.outgoing += 1;
	}

	for (const edge of edges) {
		if (edge.from === selectedId && !keptNodeIds.has(edge.to)) {
			overflow.outgoingKinds.add(edge.kind);
		}
		if (edge.to === selectedId && !keptNodeIds.has(edge.from)) {
			overflow.incomingKinds.add(edge.kind);
		}
	}

	return { keptNodeIds, overflow };
}

function chooseRepresentativeKind(kinds: Set<EdgeKind>, fallback: EdgeKind): EdgeKind {
	if (kinds.size === 0) return fallback;
	return Array.from(kinds).sort((a, b) => edgeKindPriority(a) - edgeKindPriority(b))[0] ?? fallback;
}

function createSummaryNode(selectedId: string, suffix: string, label: string): Node {
	return {
		id: `${SUMMARY_NODE_PREFIX}${selectedId}::${suffix}`,
		name: label,
		kind: 'Module',
		visibility: { kind: 'Unknown' },
		attrs: [],
		is_external: false,
	};
}

export function isSyntheticProjectionNodeId(nodeId: string): boolean {
	return nodeId.startsWith(SUMMARY_NODE_PREFIX);
}

export function projectGraphForRendering(
	graph: Graph,
	selected: Node,
	options: GraphProjectionOptions,
): GraphProjectionResult {
	const maxNodes = Math.max(1, options.maxNodes ?? GRAPH_PROJECTION_NODE_CAP);
	const maxEdges = Math.max(0, options.maxEdges ?? GRAPH_PROJECTION_EDGE_CAP);
	const maxHops = Math.max(1, options.maxHops ?? GRAPH_PROJECTION_MAX_HOPS);
	const selectedId = selected.id;

	const nodeMap = buildNodeMap(graph.nodes);
	const filteredEdges = filterEdges(graph.edges, {
		showStructural: options.showStructural,
		showSemantic: options.showSemantic,
	});

	const traitMetadata = collectTraitMetadata(nodeMap, filteredEdges);

	const hiddenNodeIds = new Set<string>();
	for (const node of graph.nodes) {
		if (shouldHideNode(node, selectedId, options)) {
			hiddenNodeIds.add(node.id);
		}
	}

	const traversableEdges = filteredEdges.filter((edge) => {
		if (hiddenNodeIds.has(edge.from) || hiddenNodeIds.has(edge.to)) return false;
		if (!nodeMap.has(edge.from) || !nodeMap.has(edge.to)) return false;
		return true;
	});

	const hopNodeIds = collectHopNodeIds(selectedId, traversableEdges, maxHops);
	const candidateNodeIds = new Set<string>();
	candidateNodeIds.add(selectedId);
	for (const nodeId of hopNodeIds) {
		if (hiddenNodeIds.has(nodeId)) continue;
		candidateNodeIds.add(nodeId);
	}

	let candidateEdges = traversableEdges.filter(
		(edge) => candidateNodeIds.has(edge.from) && candidateNodeIds.has(edge.to),
	);

	const { keptNodeIds, overflow } = capNodesAroundSelection(
		candidateNodeIds,
		candidateEdges,
		nodeMap,
		selectedId,
		maxNodes,
	);

	candidateEdges = candidateEdges.filter(
		(edge) => keptNodeIds.has(edge.from) && keptNodeIds.has(edge.to),
	);

	const syntheticNodes: Node[] = [];
	const syntheticEdges: Edge[] = [];
	const syntheticNodeIds = new Set<string>();

	if (overflow.outgoing > 0 && keptNodeIds.size + syntheticNodes.length < maxNodes) {
		const node = createSummaryNode(selectedId, 'overflow-out', `+${overflow.outgoing} more deps`);
		syntheticNodes.push(node);
		syntheticNodeIds.add(node.id);
		syntheticEdges.push({
			from: selectedId,
			to: node.id,
			kind: chooseRepresentativeKind(overflow.outgoingKinds, 'UsesType'),
			confidence: 'Inferred',
		});
	}

	if (overflow.incoming > 0 && keptNodeIds.size + syntheticNodes.length < maxNodes) {
		const node = createSummaryNode(selectedId, 'overflow-in', `+${overflow.incoming} more users`);
		syntheticNodes.push(node);
		syntheticNodeIds.add(node.id);
		syntheticEdges.push({
			from: node.id,
			to: selectedId,
			kind: chooseRepresentativeKind(overflow.incomingKinds, 'UsesType'),
			confidence: 'Inferred',
		});
	}

	const combinedEdges = [...candidateEdges, ...syntheticEdges];
	let cappedEdges = combinedEdges;
	let edgeOverflow = 0;

	if (combinedEdges.length > maxEdges) {
		const sorted = [...combinedEdges].sort((a, b) => {
			const aTouchesSelected = a.from === selectedId || a.to === selectedId;
			const bTouchesSelected = b.from === selectedId || b.to === selectedId;
			if (aTouchesSelected !== bTouchesSelected) return aTouchesSelected ? -1 : 1;
			const kindCmp = edgeKindPriority(a.kind) - edgeKindPriority(b.kind);
			if (kindCmp !== 0) return kindCmp;
			const fromCmp = a.from.localeCompare(b.from);
			if (fromCmp !== 0) return fromCmp;
			return a.to.localeCompare(b.to);
		});

		cappedEdges = sorted.slice(0, maxEdges);
		edgeOverflow = sorted.length - cappedEdges.length;
	}

	let edgeOverflowNode: Node | null = null;
	let edgeOverflowEdge: Edge | null = null;
	if (edgeOverflow > 0 && keptNodeIds.size + syntheticNodes.length < maxNodes && maxEdges > 0) {
		edgeOverflowNode = createSummaryNode(
			selectedId,
			'overflow-edges',
			`+${edgeOverflow} more links`,
		);
		syntheticNodeIds.add(edgeOverflowNode.id);
		edgeOverflowEdge = {
			from: selectedId,
			to: edgeOverflowNode.id,
			kind: 'UsesType',
			confidence: 'Inferred',
		};
		if (cappedEdges.length >= maxEdges) {
			cappedEdges = cappedEdges.slice(0, maxEdges - 1);
		}
		cappedEdges = [...cappedEdges, edgeOverflowEdge];
	}

	const finalNodeIds = new Set<string>();
	finalNodeIds.add(selectedId);
	for (const edge of cappedEdges) {
		finalNodeIds.add(edge.from);
		finalNodeIds.add(edge.to);
	}

	const finalNodes: Node[] = [];
	for (const node of graph.nodes) {
		if (finalNodeIds.has(node.id) && !hiddenNodeIds.has(node.id)) {
			finalNodes.push(node);
		}
	}

	if (!finalNodeIds.has(selectedId)) {
		finalNodeIds.add(selectedId);
	}

	if (!finalNodes.some((node) => node.id === selectedId)) {
		finalNodes.unshift(nodeMap.get(selectedId) ?? selected);
	}

	for (const node of syntheticNodes) {
		if (finalNodeIds.has(node.id)) {
			finalNodes.push(node);
		}
	}
	if (edgeOverflowNode && finalNodeIds.has(edgeOverflowNode.id)) {
		finalNodes.push(edgeOverflowNode);
	}

	finalNodes.sort((a, b) => {
		if (a.id === selectedId) return -1;
		if (b.id === selectedId) return 1;
		return 0;
	});

	if (finalNodes.length > maxNodes) {
		finalNodes.length = maxNodes;
	}

	const visibleNodeIdSet = new Set(finalNodes.map((node) => node.id));
	const finalEdges = cappedEdges.filter(
		(edge) => visibleNodeIdSet.has(edge.from) && visibleNodeIdSet.has(edge.to),
	);

	const visibleTraitMetadataByNodeId = new Map<string, GraphTraitMetadata>();
	for (const [nodeId, metadata] of traitMetadata) {
		if (visibleNodeIdSet.has(nodeId)) {
			visibleTraitMetadataByNodeId.set(nodeId, metadata);
		}
	}

	const visibleSyntheticNodeIds = new Set(
		Array.from(syntheticNodeIds).filter((nodeId) => visibleNodeIdSet.has(nodeId)),
	);

	return {
		graph: {
			nodes: finalNodes,
			edges: finalEdges,
		},
		traitMetadataByNodeId: visibleTraitMetadataByNodeId,
		syntheticNodeIds: visibleSyntheticNodeIds,
	};
}
