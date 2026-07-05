import type { Node, NodeSummary } from '$lib/schema';

export function summarizeNode(node: Node): NodeSummary {
	return {
		id: node.id,
		name: node.name,
		kind: node.kind,
		visibility: node.visibility,
		is_external: node.is_external,
		is_deprecated: node.is_deprecated,
		...(node.kind === 'Impl'
			? {
					impl_trait: node.impl_trait,
					impl_category: node.impl_category,
					generics: node.generics,
				}
			: {}),
	};
}
