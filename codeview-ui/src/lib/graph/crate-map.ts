import { normalizeCrateName } from '$lib/crate-names';
import type { EdgeKind, Graph, NodeKind } from '$lib/graph';

const STRUCTURAL_EDGE_KINDS = new Set<EdgeKind>(['Contains', 'Defines']);

export type CrateMapSemanticKind = Exclude<EdgeKind, 'Contains' | 'Defines'>;

export type CrateMapModuleNode = {
	id: string;
	name: string;
	parentId: string | null;
	depth: number;
	directNodeCount: number;
	totalNodeCount: number;
	childModuleCount: number;
	kind: NodeKind;
};

export type CrateMapModuleEdge = {
	from: string;
	to: string;
	total: number;
	kindCounts: Partial<Record<CrateMapSemanticKind, number>>;
};

export type CrateMapData = {
	crateId: string;
	moduleNodes: CrateMapModuleNode[];
	matrixModuleIds: string[];
	moduleEdges: CrateMapModuleEdge[];
	totalNodeCount: number;
	totalEdgeCount: number;
	semanticEdgeCount: number;
	visibleSemanticEdgeCount: number;
	truncatedHierarchy: boolean;
	hiddenHierarchyModules: number;
	truncatedMatrix: boolean;
};

export type CrateMapOptions = {
	maxHierarchyModules?: number;
	maxMatrixModules?: number;
};

const DEFAULT_MAX_HIERARCHY_MODULES = 180;
const DEFAULT_MAX_MATRIX_MODULES = 24;

type MutableModuleInfo = CrateMapModuleNode;

type MutableModuleEdge = {
	from: string;
	to: string;
	total: number;
	kindCounts: Partial<Record<CrateMapSemanticKind, number>>;
};

function semanticKind(kind: EdgeKind): CrateMapSemanticKind | null {
	return STRUCTURAL_EDGE_KINDS.has(kind) ? null : (kind as CrateMapSemanticKind);
}

function parentScore(kind: NodeKind, edgeKind: EdgeKind): number {
	const base = kind === 'Crate' ? 0 : kind === 'Module' ? 1 : 2;
	const edgeBias = edgeKind === 'Contains' ? 0 : 1;
	return base * 10 + edgeBias;
}

function compareModule(a: MutableModuleInfo, b: MutableModuleInfo): number {
	if (b.totalNodeCount !== a.totalNodeCount) return b.totalNodeCount - a.totalNodeCount;
	if (a.depth !== b.depth) return a.depth - b.depth;
	return a.name.localeCompare(b.name);
}

function rootIdForGraph(graph: Graph, crateName: string): string | null {
	const normalizedName = normalizeCrateName(crateName);
	const internalNodes = graph.nodes.filter((node) => !node.is_external);
	if (internalNodes.length === 0) return null;

	const exact = internalNodes.find((node) => node.id === normalizedName && node.kind === 'Crate');
	if (exact) return exact.id;

	const byCrateKind = internalNodes.find(
		(node) => node.kind === 'Crate' && normalizeCrateName(node.id) === normalizedName,
	);
	if (byCrateKind) return byCrateKind.id;

	const firstCrate = internalNodes.find((node) => node.kind === 'Crate');
	if (firstCrate) return firstCrate.id;

	return internalNodes[0]?.id ?? null;
}

function nearestModuleParent(
	nodeId: string,
	parentByChild: Map<string, string>,
	moduleIds: Set<string>,
	rootId: string,
): string | null {
	if (nodeId === rootId) return null;

	const seen = new Set<string>([nodeId]);
	let cursor = parentByChild.get(nodeId) ?? null;
	while (cursor) {
		if (moduleIds.has(cursor)) return cursor;
		if (seen.has(cursor)) break;
		seen.add(cursor);
		cursor = parentByChild.get(cursor) ?? null;
	}

	return rootId;
}

function hasParentCycle(
	moduleId: string,
	parentId: string | null,
	moduleParentById: Map<string, string | null>,
): boolean {
	if (!parentId) return false;
	const seen = new Set<string>([moduleId]);
	let cursor: string | null = parentId;
	while (cursor) {
		if (seen.has(cursor)) return true;
		seen.add(cursor);
		cursor = moduleParentById.get(cursor) ?? null;
	}
	return false;
}

export function buildCrateMapData(
	graph: Graph,
	crateName: string,
	options: CrateMapOptions = {},
): CrateMapData {
	const maxHierarchyModules = Math.max(
		8,
		options.maxHierarchyModules ?? DEFAULT_MAX_HIERARCHY_MODULES,
	);
	const maxMatrixModules = Math.max(4, options.maxMatrixModules ?? DEFAULT_MAX_MATRIX_MODULES);

	const internalNodes = graph.nodes.filter((node) => !node.is_external);
	const nodeMap = new Map(internalNodes.map((node) => [node.id, node]));
	const rootId = rootIdForGraph(graph, crateName);

	if (!rootId) {
		return {
			crateId: normalizeCrateName(crateName),
			moduleNodes: [],
			matrixModuleIds: [],
			moduleEdges: [],
			totalNodeCount: 0,
			totalEdgeCount: graph.edges.length,
			semanticEdgeCount: 0,
			visibleSemanticEdgeCount: 0,
			truncatedHierarchy: false,
			hiddenHierarchyModules: 0,
			truncatedMatrix: false,
		};
	}

	const parentByChild = new Map<string, string>();
	const parentScoreByChild = new Map<string, number>();
	for (const edge of graph.edges) {
		if (!STRUCTURAL_EDGE_KINDS.has(edge.kind)) continue;
		const from = nodeMap.get(edge.from);
		const to = nodeMap.get(edge.to);
		if (!from || !to) continue;

		const score = parentScore(from.kind, edge.kind);
		const currentScore = parentScoreByChild.get(edge.to) ?? Number.POSITIVE_INFINITY;
		if (score < currentScore) {
			parentByChild.set(edge.to, edge.from);
			parentScoreByChild.set(edge.to, score);
		}
	}

	const moduleIds = new Set<string>();
	for (const node of internalNodes) {
		if (node.kind === 'Crate' || node.kind === 'Module') {
			moduleIds.add(node.id);
		}
	}
	moduleIds.add(rootId);

	const moduleParentById = new Map<string, string | null>();
	moduleParentById.set(rootId, null);
	for (const moduleId of moduleIds) {
		if (moduleId === rootId) continue;
		moduleParentById.set(moduleId, nearestModuleParent(moduleId, parentByChild, moduleIds, rootId));
	}

	for (const moduleId of moduleIds) {
		if (moduleId === rootId) continue;
		const parentId = moduleParentById.get(moduleId) ?? null;
		if (!parentId || parentId === moduleId || hasParentCycle(moduleId, parentId, moduleParentById)) {
			moduleParentById.set(moduleId, rootId);
		}
	}

	const depthMemo = new Map<string, number>();
	const moduleDepth = (moduleId: string): number => {
		const memoized = depthMemo.get(moduleId);
		if (memoized != null) return memoized;

		const seen = new Set<string>([moduleId]);
		let depth = 0;
		let cursor = moduleParentById.get(moduleId) ?? null;
		while (cursor) {
			if (seen.has(cursor)) break;
			seen.add(cursor);
			depth += 1;
			cursor = moduleParentById.get(cursor) ?? null;
		}

		depthMemo.set(moduleId, depth);
		return depth;
	};

	const moduleInfoById = new Map<string, MutableModuleInfo>();
	for (const moduleId of moduleIds) {
		const moduleNode = nodeMap.get(moduleId);
		moduleInfoById.set(moduleId, {
			id: moduleId,
			name: moduleNode?.name ?? moduleId.split('::').pop() ?? moduleId,
			kind: moduleNode?.kind ?? (moduleId === rootId ? 'Crate' : 'Module'),
			parentId: moduleParentById.get(moduleId) ?? null,
			depth: moduleDepth(moduleId),
			directNodeCount: 0,
			totalNodeCount: 0,
			childModuleCount: 0,
		});
	}

	const ownerByNodeId = new Map<string, string>();
	const ownerForNode = (nodeId: string): string => {
		const cached = ownerByNodeId.get(nodeId);
		if (cached) return cached;

		if (moduleIds.has(nodeId)) {
			ownerByNodeId.set(nodeId, nodeId);
			return nodeId;
		}

		const path: string[] = [nodeId];
		const seen = new Set<string>([nodeId]);
		let cursor = parentByChild.get(nodeId) ?? null;
		while (cursor) {
			if (moduleIds.has(cursor)) {
				for (const id of path) ownerByNodeId.set(id, cursor);
				ownerByNodeId.set(cursor, cursor);
				return cursor;
			}
			if (seen.has(cursor)) break;
			seen.add(cursor);
			path.push(cursor);
			cursor = parentByChild.get(cursor) ?? null;
		}

		for (const id of path) ownerByNodeId.set(id, rootId);
		return rootId;
	};

	for (const node of internalNodes) {
		const ownerId = ownerForNode(node.id);
		const owner = moduleInfoById.get(ownerId);
		if (owner) owner.directNodeCount += 1;
	}

	const childrenByParent = new Map<string, string[]>();
	for (const module of moduleInfoById.values()) {
		if (!module.parentId) continue;
		const children = childrenByParent.get(module.parentId) ?? [];
		children.push(module.id);
		childrenByParent.set(module.parentId, children);
	}

	for (const [parentId, children] of childrenByParent) {
		children.sort((a, b) => {
			const aNode = moduleInfoById.get(a);
			const bNode = moduleInfoById.get(b);
			if (!aNode || !bNode) return a.localeCompare(b);
			return aNode.name.localeCompare(bNode.name);
		});
		const parent = moduleInfoById.get(parentId);
		if (parent) parent.childModuleCount = children.length;
	}

	const totalMemo = new Map<string, number>();
	const computing = new Set<string>();
	const computeTotal = (moduleId: string): number => {
		const memoized = totalMemo.get(moduleId);
		if (memoized != null) return memoized;

		const module = moduleInfoById.get(moduleId);
		if (!module) return 0;
		if (computing.has(moduleId)) return module.directNodeCount;

		computing.add(moduleId);
		let total = module.directNodeCount;
		for (const childId of childrenByParent.get(moduleId) ?? []) {
			if (childId === moduleId) continue;
			total += computeTotal(childId);
		}
		computing.delete(moduleId);

		module.totalNodeCount = total;
		totalMemo.set(moduleId, total);
		return total;
	};

	for (const moduleId of moduleInfoById.keys()) {
		computeTotal(moduleId);
	}

	const allModuleInfos = Array.from(moduleInfoById.values());
	const hierarchyKeep = new Set<string>();
	hierarchyKeep.add(rootId);

	if (allModuleInfos.length <= maxHierarchyModules) {
		for (const module of allModuleInfos) hierarchyKeep.add(module.id);
	} else {
		const ranked = allModuleInfos
			.filter((module) => module.id !== rootId)
			.sort(compareModule)
			.slice(0, maxHierarchyModules - 1);

		for (const module of ranked) {
			hierarchyKeep.add(module.id);
			let cursor = module.parentId;
			while (cursor) {
				hierarchyKeep.add(cursor);
				cursor = moduleParentById.get(cursor) ?? null;
			}
		}
	}

	const hierarchyModules = Array.from(hierarchyKeep)
		.map((id) => moduleInfoById.get(id))
		.filter((module): module is MutableModuleInfo => Boolean(module))
		.map((module) => {
			const parentId =
				module.parentId && hierarchyKeep.has(module.parentId) ? module.parentId : null;
			return {
				...module,
				parentId,
			};
		})
		.sort((a, b) => {
			if (a.depth !== b.depth) return a.depth - b.depth;
			if (b.totalNodeCount !== a.totalNodeCount) return b.totalNodeCount - a.totalNodeCount;
			return a.name.localeCompare(b.name);
		});

	const matrixCandidates = [...hierarchyModules].sort(compareModule);
	const matrixModuleIds: string[] = [];
	if (hierarchyKeep.has(rootId)) {
		matrixModuleIds.push(rootId);
	}
	for (const module of matrixCandidates) {
		if (matrixModuleIds.length >= maxMatrixModules) break;
		if (module.id === rootId) continue;
		matrixModuleIds.push(module.id);
	}

	const matrixSet = new Set(matrixModuleIds);
	const moduleEdges = new Map<string, MutableModuleEdge>();
	let semanticEdgeCount = 0;
	let visibleSemanticEdgeCount = 0;

	for (const edge of graph.edges) {
		const kind = semanticKind(edge.kind);
		if (!kind) continue;

		if (!nodeMap.has(edge.from) || !nodeMap.has(edge.to)) continue;
		const fromOwner = ownerForNode(edge.from);
		const toOwner = ownerForNode(edge.to);
		if (!fromOwner || !toOwner) continue;

		semanticEdgeCount += 1;
		if (!matrixSet.has(fromOwner) || !matrixSet.has(toOwner)) continue;

		visibleSemanticEdgeCount += 1;
		const edgeKey = `${fromOwner}|${toOwner}`;
		let agg = moduleEdges.get(edgeKey);
		if (!agg) {
			agg = {
				from: fromOwner,
				to: toOwner,
				total: 0,
				kindCounts: {},
			};
			moduleEdges.set(edgeKey, agg);
		}

		agg.total += 1;
		agg.kindCounts[kind] = (agg.kindCounts[kind] ?? 0) + 1;
	}

	const visibleEdges = Array.from(moduleEdges.values()).sort((a, b) => {
		if (b.total !== a.total) return b.total - a.total;
		const fromCmp = a.from.localeCompare(b.from);
		if (fromCmp !== 0) return fromCmp;
		return a.to.localeCompare(b.to);
	});

	return {
		crateId: rootId,
		moduleNodes: hierarchyModules,
		matrixModuleIds,
		moduleEdges: visibleEdges,
		totalNodeCount: internalNodes.length,
		totalEdgeCount: graph.edges.length,
		semanticEdgeCount,
		visibleSemanticEdgeCount,
		truncatedHierarchy: hierarchyKeep.size < allModuleInfos.length,
		hiddenHierarchyModules: Math.max(0, allModuleInfos.length - hierarchyKeep.size),
		truncatedMatrix: matrixModuleIds.length < hierarchyModules.length,
	};
}

// ────────────────────────────────────────────────────
// Treemap layout (squarified algorithm)
// ────────────────────────────────────────────────────

export type TreemapRect = {
	module: CrateMapModuleNode;
	x: number;
	y: number;
	width: number;
	height: number;
	depth: number;
};

export type LayoutRect = { x: number; y: number; w: number; h: number };

/**
 * Build a parent→children lookup from the flat module list.
 * Shared by treemap + sunburst layout functions.
 */
function buildChildrenMap(
	modules: CrateMapModuleNode[],
): Map<string, CrateMapModuleNode[]> {
	const byParent = new Map<string, CrateMapModuleNode[]>();
	for (const m of modules) {
		if (!m.parentId) continue;
		let list = byParent.get(m.parentId);
		if (!list) {
			list = [];
			byParent.set(m.parentId, list);
		}
		list.push(m);
	}
	// Sort children by size descending (stable for squarify)
	for (const children of byParent.values()) {
		children.sort((a, b) => b.totalNodeCount - a.totalNodeCount || a.name.localeCompare(b.name));
	}
	return byParent;
}

/**
 * Squarified treemap layout (Bruls, Huizing & van Wijk, 2000).
 *
 * Takes a flat list of `CrateMapModuleNode` (with parentId hierarchy)
 * and a bounding rectangle; returns positioned rects for every module.
 */
export function computeSquarifiedLayout(
	modules: CrateMapModuleNode[],
	bounds: LayoutRect,
): TreemapRect[] {
	if (modules.length === 0) return [];

	const childrenMap = buildChildrenMap(modules);
	const root = modules.find((m) => m.parentId === null) ?? modules[0];
	if (!root) return [];

	const rects: TreemapRect[] = [];

	function squarify(
		items: CrateMapModuleNode[],
		totalValue: number,
		rect: LayoutRect,
	): void {
		if (items.length === 0 || rect.w <= 0 || rect.h <= 0) return;
		if (items.length === 1) {
			rects.push({
				module: items[0],
				x: rect.x,
				y: rect.y,
				width: rect.w,
				height: rect.h,
				depth: items[0].depth,
			});
			layoutChildren(items[0], { x: rect.x, y: rect.y, w: rect.w, h: rect.h });
			return;
		}

		// Determine whether to slice horizontally or vertically
		const isHorizontal = rect.w >= rect.h;
		const side = isHorizontal ? rect.h : rect.w;

		let row: CrateMapModuleNode[] = [];
		let rowValue = 0;
		let bestAspect = Infinity;
		let splitIdx = 0;

		for (let i = 0; i < items.length; i++) {
			const val = Math.max(1, items[i].totalNodeCount);
			const testValue = rowValue + val;
			const testRow = [...row, items[i]];

			const worstAspect = worstAspectRatio(testRow, testValue, totalValue, side);
			if (worstAspect <= bestAspect) {
				bestAspect = worstAspect;
				row = testRow;
				rowValue = testValue;
				splitIdx = i + 1;
			} else {
				break;
			}
		}

		// Layout the chosen row
		const rowFraction = rowValue / totalValue;
		const rowThickness = isHorizontal
			? rect.w * rowFraction
			: rect.h * rowFraction;

		let cursor = 0;
		for (let i = 0; i < row.length; i++) {
			const val = Math.max(1, row[i].totalNodeCount);
			const itemFraction = val / rowValue;
			const itemLength = (isHorizontal ? rect.h : rect.w) * itemFraction;

			const itemRect: LayoutRect = isHorizontal
				? { x: rect.x, y: rect.y + cursor, w: rowThickness, h: itemLength }
				: { x: rect.x + cursor, y: rect.y, w: itemLength, h: rowThickness };

			rects.push({
				module: row[i],
				x: itemRect.x,
				y: itemRect.y,
				width: itemRect.w,
				height: itemRect.h,
				depth: row[i].depth,
			});
			layoutChildren(row[i], itemRect);
			cursor += itemLength;
		}

		// Recurse on remaining items
		const remaining = items.slice(splitIdx);
		if (remaining.length > 0) {
			const remainingValue = totalValue - rowValue;
			const remainingRect: LayoutRect = isHorizontal
				? { x: rect.x + rowThickness, y: rect.y, w: rect.w - rowThickness, h: rect.h }
				: { x: rect.x, y: rect.y + rowThickness, w: rect.w, h: rect.h - rowThickness };
			squarify(remaining, remainingValue, remainingRect);
		}
	}

	function layoutChildren(parent: CrateMapModuleNode, parentRect: LayoutRect): void {
		const children = childrenMap.get(parent.id);
		if (!children || children.length === 0) return;

		const PADDING = 2;
		const inner: LayoutRect = {
			x: parentRect.x + PADDING,
			y: parentRect.y + PADDING,
			w: Math.max(0, parentRect.w - PADDING * 2),
			h: Math.max(0, parentRect.h - PADDING * 2),
		};
		if (inner.w <= 0 || inner.h <= 0) return;

		const childTotal = children.reduce((s, c) => s + Math.max(1, c.totalNodeCount), 0);
		squarify(children, childTotal, inner);
	}

	// Start: place root, then layout its children
	rects.push({
		module: root,
		x: bounds.x,
		y: bounds.y,
		width: bounds.w,
		height: bounds.h,
		depth: root.depth,
	});
	layoutChildren(root, bounds);

	return rects;
}

function worstAspectRatio(
	row: CrateMapModuleNode[],
	rowValue: number,
	totalValue: number,
	side: number,
): number {
	if (row.length === 0 || side <= 0 || totalValue <= 0) return Infinity;

	const rowArea = (rowValue / totalValue) * side * side;
	const rowWidth = rowArea / side;

	let worst = 0;
	for (const item of row) {
		const val = Math.max(1, item.totalNodeCount);
		const itemArea = (val / rowValue) * rowArea;
		const itemHeight = rowWidth > 0 ? itemArea / rowWidth : 0;
		const aspect = rowWidth > 0 && itemHeight > 0
			? Math.max(rowWidth / itemHeight, itemHeight / rowWidth)
			: Infinity;
		if (aspect > worst) worst = aspect;
	}
	return worst;
}

// ────────────────────────────────────────────────────
// Sunburst layout (radial partition)
// ────────────────────────────────────────────────────

export type SunburstArc = {
	module: CrateMapModuleNode;
	startAngle: number;
	endAngle: number;
	innerRadius: number;
	outerRadius: number;
	depth: number;
};

/**
 * Compute sunburst arcs for a radial partition chart.
 * Each module's angular extent is proportional to its totalNodeCount
 * relative to its parent.
 */
export function computeSunburstArcs(
	modules: CrateMapModuleNode[],
	ringWidth = 40,
): SunburstArc[] {
	if (modules.length === 0) return [];

	const childrenMap = buildChildrenMap(modules);
	const root = modules.find((m) => m.parentId === null) ?? modules[0];
	if (!root) return [];

	const arcs: SunburstArc[] = [];

	function layoutArc(
		node: CrateMapModuleNode,
		startAngle: number,
		endAngle: number,
		depth: number,
	): void {
		const innerR = depth * ringWidth;
		const outerR = (depth + 1) * ringWidth;

		arcs.push({
			module: node,
			startAngle,
			endAngle,
			innerRadius: innerR,
			outerRadius: outerR,
			depth,
		});

		const children = childrenMap.get(node.id);
		if (!children || children.length === 0) return;

		const totalChildValue = children.reduce(
			(s, c) => s + Math.max(1, c.totalNodeCount),
			0,
		);
		if (totalChildValue <= 0) return;

		const angularRange = endAngle - startAngle;
		let cursor = startAngle;

		for (const child of children) {
			const childFraction =
				Math.max(1, child.totalNodeCount) / totalChildValue;
			const childAngle = angularRange * childFraction;
			layoutArc(child, cursor, cursor + childAngle, depth + 1);
			cursor += childAngle;
		}
	}

	layoutArc(root, 0, Math.PI * 2, 0);
	return arcs;
}

/**
 * Generate an SVG path `d` attribute for an arc segment.
 */
export function arcPath(
	cx: number,
	cy: number,
	innerR: number,
	outerR: number,
	startAngle: number,
	endAngle: number,
): string {
	// Handle full-circle arcs (split into two halves to avoid SVG arc ambiguity)
	const span = endAngle - startAngle;
	if (span >= Math.PI * 2 - 1e-6) {
		const mid = startAngle + Math.PI;
		return (
			arcPath(cx, cy, innerR, outerR, startAngle, mid) +
			' ' +
			arcPath(cx, cy, innerR, outerR, mid, endAngle)
		);
	}

	const cos0 = Math.cos(startAngle - Math.PI / 2);
	const sin0 = Math.sin(startAngle - Math.PI / 2);
	const cos1 = Math.cos(endAngle - Math.PI / 2);
	const sin1 = Math.sin(endAngle - Math.PI / 2);

	const x0 = cx + outerR * cos0;
	const y0 = cy + outerR * sin0;
	const x1 = cx + outerR * cos1;
	const y1 = cy + outerR * sin1;
	const x2 = cx + innerR * cos1;
	const y2 = cy + innerR * sin1;
	const x3 = cx + innerR * cos0;
	const y3 = cy + innerR * sin0;

	const largeArc = span > Math.PI ? 1 : 0;

	return [
		`M ${x0} ${y0}`,
		`A ${outerR} ${outerR} 0 ${largeArc} 1 ${x1} ${y1}`,
		`L ${x2} ${y2}`,
		`A ${innerR} ${innerR} 0 ${largeArc} 0 ${x3} ${y3}`,
		'Z',
	].join(' ');
}

// ────────────────────────────────────────────────────
// Force-directed graph layout
// ────────────────────────────────────────────────────

export type CrateGraphNodePos = {
	module: CrateMapModuleNode;
	x: number;
	y: number;
	r: number;
};

/**
 * Compute a force-directed layout for module dependency graph.
 *
 * Repulsion between all pairs (capped at ~24 nodes), attraction along
 * coupling edges weighted by strength, center gravity, and a cooling
 * schedule over 80 iterations. Coupled modules cluster together.
 */
export function computeForceDirectedLayout(
	modules: CrateMapModuleNode[],
	edges: CrateMapModuleEdge[],
	width: number,
	height: number,
	nodeRadius: number,
): Map<string, CrateGraphNodePos> {
	const n = modules.length;
	const result = new Map<string, CrateGraphNodePos>();
	if (n === 0) return result;

	// If only 1 node, center it
	if (n === 1) {
		result.set(modules[0].id, {
			module: modules[0],
			x: width / 2,
			y: height / 2,
			r: nodeRadius,
		});
		return result;
	}

	// Initialize positions in a circle (deterministic starting layout)
	const cx = width / 2;
	const cy = height / 2;
	const initRadius = Math.min(width, height) * 0.3;
	const xs = new Float64Array(n);
	const ys = new Float64Array(n);
	const idToIdx = new Map<string, number>();

	for (let i = 0; i < n; i++) {
		const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
		xs[i] = cx + initRadius * Math.cos(angle);
		ys[i] = cy + initRadius * Math.sin(angle);
		idToIdx.set(modules[i].id, i);
	}

	// Pre-build edge index: [fromIdx, toIdx, weight] tuples
	const maxTotal = edges.reduce((max, e) => Math.max(max, e.total), 1);
	const edgeIdx: [number, number, number][] = [];
	for (const e of edges) {
		const fi = idToIdx.get(e.from);
		const ti = idToIdx.get(e.to);
		if (fi == null || ti == null || fi === ti) continue;
		// Normalised weight ∈ [0.3, 1.0]
		const w = 0.3 + 0.7 * (Math.log1p(e.total) / Math.log1p(maxTotal));
		edgeIdx.push([fi, ti, w]);
	}

	// Simulation constants
	const ITERATIONS = 80;
	const REPULSION = 6000;
	const ATTRACTION = 0.005;
	const GRAVITY = 0.02;
	const IDEAL_DISTANCE = Math.min(width, height) / Math.sqrt(n + 1);
	const MIN_DIST = 1;
	let temperature = Math.min(width, height) * 0.1;
	const cooling = temperature / (ITERATIONS + 1);

	const dxs = new Float64Array(n);
	const dys = new Float64Array(n);

	for (let iter = 0; iter < ITERATIONS; iter++) {
		// Reset forces
		dxs.fill(0);
		dys.fill(0);

		// Repulsion (all pairs)
		for (let i = 0; i < n; i++) {
			for (let j = i + 1; j < n; j++) {
				let dx = xs[i] - xs[j];
				let dy = ys[i] - ys[j];
				const dist = Math.max(MIN_DIST, Math.sqrt(dx * dx + dy * dy));
				const force = REPULSION / (dist * dist);
				dx = (dx / dist) * force;
				dy = (dy / dist) * force;
				dxs[i] += dx;
				dys[i] += dy;
				dxs[j] -= dx;
				dys[j] -= dy;
			}
		}

		// Attraction along edges
		for (const [fi, ti, w] of edgeIdx) {
			const dx = xs[ti] - xs[fi];
			const dy = ys[ti] - ys[fi];
			const dist = Math.max(MIN_DIST, Math.sqrt(dx * dx + dy * dy));
			const force = ATTRACTION * w * (dist - IDEAL_DISTANCE);
			const fx = (dx / dist) * force;
			const fy = (dy / dist) * force;
			dxs[fi] += fx;
			dys[fi] += fy;
			dxs[ti] -= fx;
			dys[ti] -= fy;
		}

		// Center gravity
		for (let i = 0; i < n; i++) {
			dxs[i] += (cx - xs[i]) * GRAVITY;
			dys[i] += (cy - ys[i]) * GRAVITY;
		}

		// Apply forces with temperature limiting
		for (let i = 0; i < n; i++) {
			const mag = Math.sqrt(dxs[i] * dxs[i] + dys[i] * dys[i]);
			if (mag > 0) {
				const capped = Math.min(mag, temperature) / mag;
				xs[i] += dxs[i] * capped;
				ys[i] += dys[i] * capped;
			}
			// Keep within bounds (with padding)
			const pad = nodeRadius + 10;
			xs[i] = Math.max(pad, Math.min(width - pad, xs[i]));
			ys[i] = Math.max(pad, Math.min(height - pad, ys[i]));
		}

		temperature -= cooling;
	}

	// Build result
	for (let i = 0; i < n; i++) {
		result.set(modules[i].id, {
			module: modules[i],
			x: xs[i],
			y: ys[i],
			r: nodeRadius,
		});
	}

	return result;
}

// ────────────────────────────────────────────────────
// Find containing module for a node ID
// ────────────────────────────────────────────────────

/**
 * Given a node ID (e.g. `serde::de::Deserialize`) and a list of modules,
 * find which module contains the node by walking up `::` path segments.
 */
export function findContainingModule(
	nodeId: string,
	modules: CrateMapModuleNode[],
): string | null {
	if (!nodeId || modules.length === 0) return null;

	const moduleIds = new Set(modules.map((m) => m.id));

	// Direct match (the node IS a module)
	if (moduleIds.has(nodeId)) return nodeId;

	// Walk up path segments: serde::de::Foo → serde::de → serde
	const parts = nodeId.split('::');
	for (let i = parts.length - 1; i >= 1; i--) {
		const candidate = parts.slice(0, i).join('::');
		if (moduleIds.has(candidate)) return candidate;
	}

	return null;
}

// ────────────────────────────────────────────────────
// Shared depth-color palette for all crate map visualizations
// ────────────────────────────────────────────────────

/** Consistent depth → color mapping used by treemap, sunburst, grid, and graph. */
const MODULE_DEPTH_COLORS = [
	'#e8720c', // depth 0: Crate (kindVisuals.Crate.fill)
	'#2d8a5e', // depth 1: Module (kindVisuals.Module.fill)
	'#3b82f6', // depth 2: blue
	'#8b5cf6', // depth 3: violet
	'#ec4899', // depth 4: pink
	'#f59e0b', // depth 5+: amber
];

/** Map a module depth to a color. Depths beyond the palette clamp to the last entry. */
export function moduleDepthColor(depth: number): string {
	return MODULE_DEPTH_COLORS[Math.min(depth, MODULE_DEPTH_COLORS.length - 1)];
}
