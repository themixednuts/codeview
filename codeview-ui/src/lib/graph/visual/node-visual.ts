import type { NodeKind } from '$lib/graph';
import type { NodeVisual } from './types';
import { kindVisuals } from './palette';
import { BASE_SPECS, nodeSvgPath, buildHeaderPath } from './shapes';

const CENTER_SCALE = 1.15;
const visualCache = new Map<string, NodeVisual>();

function buildNodeVisual(kind: NodeKind, isCenter: boolean): NodeVisual {
	const spec = BASE_SPECS[kind];
	const scale = isCenter ? CENTER_SCALE : 1;
	const w = Math.round(spec.width * scale);
	const h = Math.round(spec.height * scale);
	const cr = spec.cornerRadius;
	const colors = kindVisuals[kind];
	const { headerPath, headerHeight } = buildHeaderPath(spec.shape, w, h, cr, isCenter);

	return {
		shape: spec.shape,
		width: w,
		height: h,
		fill: colors.fill,
		stroke: colors.stroke,
		strokeWidth: isCenter ? 3 : 2,
		strokeDasharray: spec.strokeDasharray,
		cornerRadius: cr,
		svgPath: nodeSvgPath(spec.shape, w, h, cr),
		headerPath,
		headerHeight,
		labelFontSize: isCenter ? 14 : 11,
		labelColor: '#ffffff',
	};
}

/**
 * Get full visual descriptor for a node kind + center flag.
 * Deterministic and cached — safe to call in tight loops and derived computations.
 */
export function getNodeVisual(kind: NodeKind, isCenter: boolean): NodeVisual {
	const key = `${kind}:${isCenter}`;
	let v = visualCache.get(key);
	if (!v) {
		v = buildNodeVisual(kind, isCenter);
		visualCache.set(key, v);
	}
	return v;
}
