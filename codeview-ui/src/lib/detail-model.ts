import type {
	DetailDocModel,
	DetailMethodGroup,
	Edge,
	Node,
	NodeDetail,
	TocEntry,
	WhereUsedRef,
} from '$lib/schema';

export type SelectedEdges = {
	incoming: Edge[];
	outgoing: Edge[];
};

export type {
	DetailDocModel,
	DetailMethodGroup,
	TocEntry,
	WhereUsedRef,
} from '$lib/schema';

export type MaterializedMethodGroup = {
	impl: Node;
	methods: Node[];
};

export type MaterializedDetailDocModel = Omit<
	DetailDocModel,
	'methodGroups' | 'relatedNodeIds' | 'implBlockIds' | 'sourceImplIds' | 'blanketImplIds'
> & {
	relatedNodeMap: Map<string, Node>;
	implBlocks: Node[];
	sourceImpls: Node[];
	blanketImpls: Node[];
	methodGroups: MaterializedMethodGroup[];
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
			relatedNodeIds: [],
			implBlockIds: [],
			sourceImplIds: [],
			blanketImplIds: [],
			methodGroups: [],
			methodCount: 0,
			totalImpls: 0,
			tocEntries: [],
			whereUsed: [],
		};
	}

	const selected = detail.node;
	const relatedNodeMap = buildRelatedNodeMap(detail);
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

	const methodBuckets = new Map<string, MaterializedMethodGroup>();
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
		relatedNodeIds: Array.from(relatedNodeMap.keys()),
		implBlockIds: implBlocks.map((node) => node.id),
		sourceImplIds: sourceImpls.map((node) => node.id),
		blanketImplIds: blanketImpls.map((node) => node.id),
		methodGroups: methodGroups.map((group) => ({
			implId: group.impl.id,
			methodIds: group.methods.map((method) => method.id),
		})),
		methodCount,
		totalImpls,
		tocEntries,
		whereUsed,
	};
}

export function buildRelatedNodeMap(detail: NodeDetail | null | undefined): Map<string, Node> {
	if (!detail) return new Map();
	return new Map<string, Node>([
		[detail.node.id, detail.node],
		...detail.relatedNodes.map((node) => [node.id, node] as const),
	]);
}

function nodeList(ids: string[], relatedNodeMap: Map<string, Node>): Node[] {
	const nodes: Node[] = [];
	for (const id of ids) {
		const node = relatedNodeMap.get(id);
		if (node) nodes.push(node);
	}
	return nodes;
}

export function materializeDetailDocModel(
	model: DetailDocModel | null | undefined,
	detail: NodeDetail | null | undefined,
): MaterializedDetailDocModel {
	const resolvedModel = model ?? buildDetailDocModel(null);
	const relatedNodeMap = buildRelatedNodeMap(detail);
	return {
		...resolvedModel,
		relatedNodeMap,
		implBlocks: nodeList(resolvedModel.implBlockIds, relatedNodeMap),
		sourceImpls: nodeList(resolvedModel.sourceImplIds, relatedNodeMap),
		blanketImpls: nodeList(resolvedModel.blanketImplIds, relatedNodeMap),
		methodGroups: resolvedModel.methodGroups
			.map((group) => {
				const impl = relatedNodeMap.get(group.implId);
				if (!impl) return null;
				return {
					impl,
					methods: nodeList(group.methodIds, relatedNodeMap),
				};
			})
			.filter((group): group is MaterializedMethodGroup => Boolean(group)),
	};
}
