import type { Edge, Node, NodeViewBase } from '$lib/schema';

const MEMBER_KINDS = new Set<Node['kind']>([
	'Function',
	'AssocType',
	'AssocConst',
	'Constant',
	'TypeAlias',
]);

function memberKey(node: Node): string {
	return `${node.kind}:${node.name}`;
}

function inheritTraitDocumentation(member: Node, traitMember: Node): Node {
	return {
		...member,
		docs: member.docs ?? traitMember.docs,
		doc_links:
			member.doc_links && Object.keys(member.doc_links).length > 0
				? member.doc_links
				: traitMember.doc_links,
		deprecation: member.deprecation ?? traitMember.deprecation,
		stability: member.stability ?? traitMember.stability,
		const_stability: member.const_stability ?? traitMember.const_stability,
		default_unstable: member.default_unstable ?? traitMember.default_unstable,
	};
}

function needsTraitDocumentation(member: Node, traitMember: Node): boolean {
	return Boolean(
		(!member.docs && traitMember.docs) ||
		((!member.doc_links || Object.keys(member.doc_links).length === 0) &&
			traitMember.doc_links &&
			Object.keys(traitMember.doc_links).length > 0) ||
		(!member.deprecation && traitMember.deprecation) ||
		(!member.stability && traitMember.stability) ||
		(!member.const_stability && traitMember.const_stability) ||
		(!member.default_unstable && traitMember.default_unstable),
	);
}

export function mergeTraitMemberDocumentation(
	view: NodeViewBase,
	traitViews: ReadonlyMap<string, NodeViewBase>,
): NodeViewBase {
	if (traitViews.size === 0) return view;

	const related = view.detail.relatedNodes.map((node) => ({ ...node }));
	const relatedById = new Map(related.map((node) => [node.id, node]));
	const edges = view.detail.edges.map((edge) => ({ ...edge }));
	const edgeKeys = new Set(edges.map((edge) => `${edge.from}|${edge.to}|${edge.kind}`));
	let changed = false;

	for (const implNode of related) {
		if (
			implNode.kind !== 'Impl' ||
			implNode.impl_category !== 'Trait' ||
			!implNode.impl_trait
		) {
			continue;
		}
		const traitView = traitViews.get(implNode.impl_trait);
		if (!traitView) continue;

		const traitRelated = new Map(
			traitView.detail.relatedNodes.map((node) => [node.id, node]),
		);
		const traitMembers = new Map<string, Node>();
		for (const edge of traitView.detail.edges) {
			if (
				edge.from !== traitView.detail.node.id ||
				!['Defines', 'Contains'].includes(edge.kind)
			) {
				continue;
			}
			const member = traitRelated.get(edge.to);
			if (member && MEMBER_KINDS.has(member.kind)) traitMembers.set(memberKey(member), member);
		}

		const implementedNames = new Set<string>();
		for (const edge of edges) {
			if (edge.from !== implNode.id || edge.kind !== 'Defines') continue;
			const member = relatedById.get(edge.to);
			if (!member || !MEMBER_KINDS.has(member.kind)) continue;
			implementedNames.add(member.name);
			const traitMember = traitMembers.get(memberKey(member));
			if (!traitMember || !needsTraitDocumentation(member, traitMember)) continue;
			Object.assign(member, inheritTraitDocumentation(member, traitMember));
			changed = true;
		}

		for (const name of implNode.provided_trait_methods ?? []) {
			if (implementedNames.has(name)) continue;
			const traitMember = Array.from(traitMembers.values()).find((member) => member.name === name);
			if (!traitMember) continue;
			if (!relatedById.has(traitMember.id)) {
				const clone = { ...traitMember };
				related.push(clone);
				relatedById.set(clone.id, clone);
			}
			const edge: Edge = {
				from: implNode.id,
				to: traitMember.id,
				kind: 'Defines',
				confidence: 'Static',
				occurrences: [],
				is_glob: false,
			};
			const key = `${edge.from}|${edge.to}|${edge.kind}`;
			if (!edgeKeys.has(key)) {
				edges.push(edge);
				edgeKeys.add(key);
			}
			changed = true;
		}
	}

	if (!changed) return view;
	return {
		...view,
		detail: {
			...view.detail,
			edges,
			relatedNodes: related,
		},
	};
}
