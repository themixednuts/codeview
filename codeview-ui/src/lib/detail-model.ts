import type { Edge, Node, NodeDetail } from '$lib/schema';

export type SelectedEdges = {
	incoming: Edge[];
	outgoing: Edge[];
};

export type MethodGroup = {
	impl: Node;
	methods: Node[];
};

export type TocEntry = {
	anchor: string;
	title: string;
	count: number | null;
};

export type WhereUsedRef = {
	id: string;
	name: string;
};

export type DetailDocModel = {
	selectedEdges: SelectedEdges;
	filteredEdges: SelectedEdges;
	relatedNodeMap: Map<string, Node>;
	implBlocks: Node[];
	sourceImpls: Node[];
	blanketImpls: Node[];
	methodGroups: MethodGroup[];
	methodCount: number;
	totalImpls: number;
	tocEntries: TocEntry[];
	whereUsed: WhereUsedRef[];
};

function isTraitImpl(node: Node): boolean {
	if (node.kind !== 'Impl') return false;
	return (
		node.impl_type === 'Trait' ||
		node.impl_category === 'Trait' ||
		node.impl_category === 'Blanket' ||
		node.impl_category === 'Negative' ||
		node.impl_category === 'Synthetic' ||
		node.name.includes(' for ')
	);
}

function isInherentImpl(node: Node): boolean {
	if (node.kind !== 'Impl') return false;
	return node.impl_type === 'Inherent' || (!node.name.includes(' for ') && node.impl_type !== 'Trait');
}

function isTypeNode(node: Node): boolean {
	return ['Struct', 'Enum', 'Union', 'Trait', 'TraitAlias', 'TypeAlias'].includes(node.kind);
}

function displayNode(id: string, relatedNodeMap: Map<string, Node>): string {
	return relatedNodeMap.get(id)?.name ?? id.split('::').pop() ?? id;
}

export function buildDetailDocModel(detail: NodeDetail | null | undefined): DetailDocModel {
	if (!detail) {
		return {
			selectedEdges: { incoming: [], outgoing: [] },
			filteredEdges: { incoming: [], outgoing: [] },
			relatedNodeMap: new Map(),
			implBlocks: [],
			sourceImpls: [],
			blanketImpls: [],
			methodGroups: [],
			methodCount: 0,
			totalImpls: 0,
			tocEntries: [],
			whereUsed: [],
		};
	}

	const selected = detail.node;
	const relatedNodeMap = new Map<string, Node>([
		[selected.id, selected],
		...detail.relatedNodes.map((node) => [node.id, node] as const),
	]);
	const selectedEdges = {
		incoming: detail.edges.filter((edge) => edge.to === selected.id),
		outgoing: detail.edges.filter((edge) => edge.from === selected.id),
	};

	const implBlocks: Node[] = [];
	for (const edge of detail.edges) {
		if (edge.kind !== 'Defines' || edge.from !== selected.id) continue;
		const target = relatedNodeMap.get(edge.to);
		if (target && isTraitImpl(target)) implBlocks.push(target);
	}

	const sourceImpls = implBlocks.filter(
		(impl) => impl.impl_category !== 'Blanket' && impl.impl_category !== 'Synthetic',
	);
	const blanketImpls = implBlocks.filter(
		(impl) => impl.impl_category === 'Blanket' || impl.impl_category === 'Synthetic',
	);
	const implBlockIds = new Set(implBlocks.map((impl) => impl.id));

	const filteredEdges = isTypeNode(selected)
		? {
				outgoing: selectedEdges.outgoing.filter(
					(edge) => !(edge.kind === 'Defines' && implBlockIds.has(edge.to)),
				),
				incoming: selectedEdges.incoming.filter(
					(edge) => !(edge.kind === 'UsesType' && implBlockIds.has(edge.from)),
				),
			}
		: selectedEdges;

	const inherentImpls: Node[] = [];
	for (const edge of detail.edges) {
		if (edge.kind !== 'Defines' || edge.from !== selected.id) continue;
		const target = relatedNodeMap.get(edge.to);
		if (target && isInherentImpl(target)) inherentImpls.push(target);
	}

	const methodBuckets = new Map<string, MethodGroup>();
	for (const impl of inherentImpls) methodBuckets.set(impl.id, { impl, methods: [] });

	for (const edge of detail.edges) {
		if ((edge.kind !== 'Contains' && edge.kind !== 'Defines') || !methodBuckets.has(edge.from)) {
			continue;
		}
		const target = relatedNodeMap.get(edge.to);
		if (target?.kind === 'Function') {
			methodBuckets.get(edge.from)?.methods.push(target);
		}
	}

	const methodGroups = Array.from(methodBuckets.values())
		.filter((group) => group.methods.length > 0)
		.map((group) => ({
			impl: group.impl,
			methods: [...group.methods].sort((a, b) => a.name.localeCompare(b.name)),
		}));
	const methodCount = methodGroups.reduce((sum, group) => sum + group.methods.length, 0);
	const totalImpls = sourceImpls.length + blanketImpls.length;
	const relCount = filteredEdges.outgoing.length + filteredEdges.incoming.length;
	const tocEntries: TocEntry[] = [];
	if (selected.docs) tocEntries.push({ anchor: 'documentation', title: 'Documentation', count: null });
	if (methodCount > 0) tocEntries.push({ anchor: 'methods', title: 'Methods', count: methodCount });
	if (totalImpls > 0) {
		tocEntries.push({ anchor: 'trait-impls', title: 'Trait implementations', count: totalImpls });
	}
	tocEntries.push({ anchor: 'relationships', title: 'Relationships', count: relCount });
	if (selected.attrs && selected.attrs.length > 0) {
		tocEntries.push({ anchor: 'attributes', title: 'Attributes', count: selected.attrs.length });
	}

	const seen = new Set<string>();
	const whereUsed: WhereUsedRef[] = [];
	for (const edge of filteredEdges.incoming) {
		if (edge.from === selected.id || seen.has(edge.from)) continue;
		seen.add(edge.from);
		whereUsed.push({ id: edge.from, name: displayNode(edge.from, relatedNodeMap) });
		if (whereUsed.length >= 8) break;
	}

	return {
		selectedEdges,
		filteredEdges,
		relatedNodeMap,
		implBlocks,
		sourceImpls,
		blanketImpls,
		methodGroups,
		methodCount,
		totalImpls,
		tocEntries,
		whereUsed,
	};
}
