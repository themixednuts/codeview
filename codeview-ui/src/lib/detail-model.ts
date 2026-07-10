import type {
	DetailDocModel,
	DetailMethodGroup,
	Edge,
	Node,
	NodeDetail,
	TocEntry,
	WhereUsedRef,
} from '$lib/schema';
import { isPublic } from '$lib/display-names';

export type SelectedEdges = {
	incoming: Edge[];
	outgoing: Edge[];
};

export type { DetailDocModel, DetailMethodGroup, TocEntry, WhereUsedRef } from '$lib/schema';

export type MaterializedMethodGroup = {
	impl: Node;
	methods: Node[];
};

export type MaterializedDetailDocModel = Omit<
	DetailDocModel,
	| 'methodGroups'
	| 'traitImplGroups'
	| 'relatedNodeIds'
	| 'implBlockIds'
	| 'sourceImplIds'
	| 'blanketImplIds'
	| 'requiredTraitMethodIds'
	| 'providedTraitMethodIds'
	| 'traitAssocItemIds'
> & {
	relatedNodeMap: Map<string, Node>;
	implBlocks: Node[];
	sourceImpls: Node[];
	blanketImpls: Node[];
	methodGroups: MaterializedMethodGroup[];
	traitImplGroups: MaterializedMethodGroup[];
	/** Trait-definition required methods (no body). */
	requiredTraitMethods: Node[];
	/** Trait-definition provided/default methods (has body). */
	providedTraitMethods: Node[];
	/** Trait-definition associated types/consts. */
	traitAssocItems: Node[];
	directItems: Node[];
};

const DIRECT_ITEM_KINDS = new Set<Node['kind']>([
	'Module',
	'Struct',
	'Enum',
	'Union',
	'Trait',
	'TraitAlias',
	'Function',
	'TypeAlias',
	'Constant',
	'Static',
	'Macro',
	'ProcMacro',
	'Primitive',
]);

const DIRECT_ITEM_KIND_ORDER = new Map<Node['kind'], number>(
	Array.from(DIRECT_ITEM_KINDS, (kind, index) => [kind, index]),
);

function collectDirectItems(detail: NodeDetail, relatedNodeMap: Map<string, Node>): Node[] {
	if (detail.node.kind !== 'Crate' && detail.node.kind !== 'Module') return [];
	const publicOnly = detail.node.kind === 'Crate';
	const seen = new Set<string>();
	const items: Node[] = [];
	for (const edge of detail.edges) {
		if (
			edge.from !== detail.node.id ||
			!['Contains', 'Defines', 'ReExports'].includes(edge.kind) ||
			seen.has(edge.to)
		) {
			continue;
		}
		const node = relatedNodeMap.get(edge.to);
		if (
			!node ||
			node.is_external ||
			!DIRECT_ITEM_KINDS.has(node.kind) ||
			(publicOnly && !isPublic(node.visibility)) ||
			(node.kind === 'Module' && node.name === detail.node.name)
		) {
			continue;
		}
		seen.add(node.id);
		items.push(node);
	}
	return items.sort((a, b) => {
		const kindOrder =
			(DIRECT_ITEM_KIND_ORDER.get(a.kind) ?? Number.MAX_SAFE_INTEGER) -
			(DIRECT_ITEM_KIND_ORDER.get(b.kind) ?? Number.MAX_SAFE_INTEGER);
		return kindOrder || a.name.localeCompare(b.name);
	});
}

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
	return (
		node.impl_type === 'Inherent' || (!node.name.includes(' for ') && node.impl_type !== 'Trait')
	);
}

function isTypeNode(node: Node): boolean {
	return ['Struct', 'Enum', 'Union', 'Trait', 'TraitAlias', 'TypeAlias'].includes(node.kind);
}

function isImplMember(node: Node): boolean {
	return ['Function', 'AssocType', 'AssocConst', 'Constant', 'TypeAlias'].includes(node.kind);
}

function isTraitAssocItem(node: Node): boolean {
	return ['AssocType', 'AssocConst', 'Constant', 'TypeAlias'].includes(node.kind);
}

function isWhereUsedEdge(edge: Edge, selected: Node): boolean {
	if (edge.kind === 'Contains' || edge.kind === 'Defines') return false;
	return selected.kind !== 'Crate' && selected.kind !== 'Module';
}

/**
 * Collect associated items defined directly on a trait (not via an impl).
 * Partition methods into required (name in `required_trait_methods`) vs
 * provided/default (everything else, including names listed under
 * `default_trait_methods`). Assoc types/consts land in their own bucket.
 */
function collectTraitItems(
	detail: NodeDetail,
	relatedNodeMap: Map<string, Node>,
): {
	required: Node[];
	provided: Node[];
	assoc: Node[];
} {
	const selected = detail.node;
	if (selected.kind !== 'Trait') {
		return { required: [], provided: [], assoc: [] };
	}

	const requiredNames = new Set(selected.required_trait_methods ?? []);
	const required: Node[] = [];
	const provided: Node[] = [];
	const assoc: Node[] = [];

	for (const edge of detail.edges) {
		if ((edge.kind !== 'Contains' && edge.kind !== 'Defines') || edge.from !== selected.id) {
			continue;
		}
		const target = relatedNodeMap.get(edge.to);
		if (!target || !isImplMember(target)) continue;

		if (target.kind === 'Function') {
			if (requiredNames.has(target.name)) required.push(target);
			else provided.push(target);
		} else if (isTraitAssocItem(target)) {
			assoc.push(target);
		}
	}

	const byName = (a: Node, b: Node) => a.name.localeCompare(b.name);
	required.sort(byName);
	provided.sort(byName);
	assoc.sort((a, b) => implMemberSortValue(a).localeCompare(implMemberSortValue(b)));
	return { required, provided, assoc };
}

function displayNode(id: string, relatedNodeMap: Map<string, Node>): string {
	return relatedNodeMap.get(id)?.name ?? id.split('::').pop() ?? id;
}

function implMemberSortValue(node: Node): string {
	const order =
		node.kind === 'AssocType'
			? '0'
			: node.kind === 'AssocConst' || node.kind === 'Constant'
				? '1'
				: node.kind === 'TypeAlias'
					? '2'
					: '3';
	return `${order}:${node.name}`;
}

function buildImplMemberGroups(
	detail: NodeDetail,
	impls: Node[],
	relatedNodeMap: Map<string, Node>,
): MaterializedMethodGroup[] {
	const buckets = new Map<string, MaterializedMethodGroup>();
	for (const impl of impls) buckets.set(impl.id, { impl, methods: [] });

	for (const edge of detail.edges) {
		if ((edge.kind !== 'Contains' && edge.kind !== 'Defines') || !buckets.has(edge.from)) {
			continue;
		}
		const target = relatedNodeMap.get(edge.to);
		if (target && isImplMember(target)) buckets.get(edge.from)?.methods.push(target);
	}

	return Array.from(buckets.values())
		.filter((group) => group.methods.length > 0)
		.map((group) => ({
			impl: group.impl,
			methods: [...group.methods].sort((a, b) =>
				implMemberSortValue(a).localeCompare(implMemberSortValue(b)),
			),
		}));
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
			traitImplGroups: [],
			requiredTraitMethodIds: [],
			providedTraitMethodIds: [],
			traitAssocItemIds: [],
			methodCount: 0,
			totalImpls: 0,
			tocEntries: [],
			whereUsed: [],
		};
	}

	const selected = detail.node;
	const relatedNodeMap = buildRelatedNodeMap(detail);
	const directItems = collectDirectItems(detail, relatedNodeMap);
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

	const methodGroups = buildImplMemberGroups(detail, inherentImpls, relatedNodeMap);
	const traitImplGroups = buildImplMemberGroups(detail, sourceImpls, relatedNodeMap);
	const traitItems = collectTraitItems(detail, relatedNodeMap);
	const methodCount = methodGroups.reduce((sum, group) => sum + group.methods.length, 0);
	const traitImplMemberCount = traitImplGroups.reduce(
		(sum, group) => sum + group.methods.length,
		0,
	);
	const totalImpls = sourceImpls.length + blanketImpls.length;
	const tocEntries: TocEntry[] = [];
	if ((selected.fields?.length ?? 0) > 0)
		tocEntries.push({ anchor: 'fields', title: 'Fields', count: selected.fields?.length ?? 0 });
	if ((selected.variants?.length ?? 0) > 0)
		tocEntries.push({
			anchor: 'variants',
			title: 'Variants',
			count: selected.variants?.length ?? 0,
		});
	if (selected.docs)
		tocEntries.push({ anchor: 'documentation', title: 'Documentation', count: null });
	if (directItems.length > 0)
		tocEntries.push({ anchor: 'items', title: 'Items', count: directItems.length });
	if (traitItems.assoc.length > 0) {
		tocEntries.push({
			anchor: 'associated-items',
			title: 'Associated items',
			count: traitItems.assoc.length,
		});
	}
	if (traitItems.required.length > 0) {
		tocEntries.push({
			anchor: 'required-methods',
			title: 'Required methods',
			count: traitItems.required.length,
		});
	}
	if (traitItems.provided.length > 0) {
		tocEntries.push({
			anchor: 'provided-methods',
			title: 'Provided methods',
			count: traitItems.provided.length,
		});
	}
	if (methodCount > 0) tocEntries.push({ anchor: 'methods', title: 'Methods', count: methodCount });
	if (totalImpls > 0) {
		tocEntries.push({
			anchor: 'trait-impls',
			title: 'Trait implementations',
			count: traitImplMemberCount > 0 ? traitImplMemberCount : totalImpls,
		});
	}
	// Implementers section (traits only) — surfaces incoming Implements edges.
	if (selected.kind === 'Trait' || selected.kind === 'TraitAlias') {
		let implCount = 0;
		for (const edge of filteredEdges.incoming) {
			if (!isWhereUsedEdge(edge, selected)) continue;
			if (edge.from === selected.id) continue;
			implCount++;
			if (implCount >= 8) break;
		}
		if (implCount > 0)
			tocEntries.push({ anchor: 'implementers', title: 'Implementers', count: implCount });
	}

	const seen = new Set<string>();
	const whereUsed: WhereUsedRef[] = [];
	for (const edge of filteredEdges.incoming) {
		if (!isWhereUsedEdge(edge, selected)) continue;
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
		traitImplGroups: traitImplGroups.map((group) => ({
			implId: group.impl.id,
			methodIds: group.methods.map((method) => method.id),
		})),
		requiredTraitMethodIds: traitItems.required.map((node) => node.id),
		providedTraitMethodIds: traitItems.provided.map((node) => node.id),
		traitAssocItemIds: traitItems.assoc.map((node) => node.id),
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
	detail: NodeDetail | null | undefined,
): MaterializedDetailDocModel {
	const resolvedModel = buildDetailDocModel(detail);
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
		traitImplGroups: resolvedModel.traitImplGroups
			.map((group) => {
				const impl = relatedNodeMap.get(group.implId);
				if (!impl) return null;
				return {
					impl,
					methods: nodeList(group.methodIds, relatedNodeMap),
				};
			})
			.filter((group): group is MaterializedMethodGroup => Boolean(group)),
		requiredTraitMethods: nodeList(resolvedModel.requiredTraitMethodIds, relatedNodeMap),
		providedTraitMethods: nodeList(resolvedModel.providedTraitMethodIds, relatedNodeMap),
		traitAssocItems: nodeList(resolvedModel.traitAssocItemIds, relatedNodeMap),
		directItems: detail ? collectDirectItems(detail, relatedNodeMap) : [],
	};
}
