// Re-export of the schema's data types so consumers can import everything
// graph-related from `$lib/graph`. Schema is the source of truth via
// schemars-generated TypeScript declarations.
export type {
	ArgumentInfo,
	AssocItemConstraint,
	Confidence,
	CrateGraph,
	Deprecation,
	Edge,
	EdgeKind,
	ExternalCrate,
	FieldInfo,
	FunctionPointerSig,
	FunctionSignature,
	GenericArg,
	GenericArgs,
	GenericBound,
	GenericParam,
	Generics,
	ImplCategory,
	ImplType,
	Node,
	NodeKind,
	PolyTrait,
	Span,
	Term,
	TypeRef,
	VariantInfo,
	VariantKind,
	Visibility,
	WherePredicate,
	Workspace,
} from '$lib/schema';

// Visual
export type { NodeShape, NodeVisual, ShapeSpec } from './visual';
export {
	kindVisuals,
	BASE_SPECS,
	nodeSvgPath,
	buildHeaderPath,
	isRectLike,
	isHeaderShape,
	getNodeVisual,
	shapeEdgeAnchor,
	getVisNodeEdgeAnchor,
} from './visual';

// Layout
export type { LayoutMode, VisNode, VisEdge, LayoutNode, LayoutLink, LayoutState } from './layout';
export {
	LAYOUT_WIDTH,
	LAYOUT_HEIGHT,
	CENTER_X,
	CENTER_Y,
	FLOW_COLUMN_GAP,
	FLOW_ROW_GAP,
	MAX_NODES_PER_COLUMN,
	FORCE_RADIUS,
	RADIAL_RADIUS,
	MIN_NODE_SPACING,
	LABEL_CHAR_WIDTH,
	ARROWHEAD_LENGTH,
	getNodeBoundingBox,
	resolveCollisionPair,
	resolveCollisions,
	computeEgoLayout,
	computeForceLayout,
	computeHierarchicalLayout,
	computeRadialLayout,
	computeLayout,
} from './layout';

// Labels
export type { LabelPosition, SimilarityInfo, LabelContext, LabelPositionProvider } from './labels';
export {
	egoLabelProvider,
	hierarchicalLabelProvider,
	radialLabelProvider,
	forceLabelProvider,
	getLabelProvider,
	computeAllLabelPositions,
} from './labels';

// Tree data structures
export { TreeIndex } from './tree-index';
