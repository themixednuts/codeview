import type { NodeKind } from '$lib/graph';
import { rectangleIntersectLineSegment, ellipseSegmentInterceptPoints } from '$lib/geo';

// ---------------------------------------------------------------------------
// Shape vocabulary
// ---------------------------------------------------------------------------

export type NodeShape =
  | 'rect'
  | 'rounded-rect'
  | 'pill'
  | 'diamond'
  | 'hexagon'
  | 'parallelogram'
  | 'chamfered-rect';

// ---------------------------------------------------------------------------
// Color palette — dual-mode safe (fill + stroke pairs)
// ---------------------------------------------------------------------------

export const kindVisuals: Record<NodeKind, { fill: string; stroke: string }> = {
  Crate:      { fill: '#e8720c', stroke: '#b85a09' },
  Module:     { fill: '#2d8a5e', stroke: '#1e6b45' },
  Struct:     { fill: '#9d4edd', stroke: '#7b2cbf' },
  Union:      { fill: '#7c5cbf', stroke: '#5e3fa3' },
  Enum:       { fill: '#4a90ff', stroke: '#2b6ddb' },
  Trait:      { fill: '#10b981', stroke: '#059669' },
  TraitAlias: { fill: '#0db39e', stroke: '#0a8f7e' },
  Impl:       { fill: '#8d99ae', stroke: '#6b7b8d' },
  Function:   { fill: '#f43f7a', stroke: '#d6336c' },
  Method:     { fill: '#c026d3', stroke: '#a21caf' },
  TypeAlias:  { fill: '#f97316', stroke: '#d96012' },
};

// ---------------------------------------------------------------------------
// NodeVisual — full rendering descriptor
// ---------------------------------------------------------------------------

export type NodeVisual = {
  shape: NodeShape;
  width: number;
  height: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
  strokeDasharray?: string;
  cornerRadius: number;
  svgPath: string;
  labelFontSize: number;
  labelColor: string;
};

// ---------------------------------------------------------------------------
// Shape → dimensions / corner-radius / shape mapping
// ---------------------------------------------------------------------------

type ShapeSpec = {
  shape: NodeShape;
  width: number;
  height: number;
  cornerRadius: number;
  strokeDasharray?: string;
};

const BASE_SPECS: Record<NodeKind, ShapeSpec> = {
  Crate:      { shape: 'rounded-rect', width: 140, height: 48, cornerRadius: 12 },
  Module:     { shape: 'rounded-rect', width: 120, height: 40, cornerRadius: 10 },
  Struct:     { shape: 'rect',         width: 132, height: 44, cornerRadius: 2 },
  Enum:       { shape: 'chamfered-rect', width: 132, height: 44, cornerRadius: 2 },
  Union:      { shape: 'rect',         width: 132, height: 44, cornerRadius: 2, strokeDasharray: '6 3' },
  Trait:      { shape: 'diamond',      width: 90,  height: 60, cornerRadius: 0 },
  TraitAlias: { shape: 'diamond',      width: 78,  height: 52, cornerRadius: 0 },
  Impl:       { shape: 'hexagon',      width: 110, height: 48, cornerRadius: 0 },
  Function:   { shape: 'pill',         width: 120, height: 44, cornerRadius: 22 },
  Method:     { shape: 'pill',         width: 100, height: 38, cornerRadius: 19 },
  TypeAlias:  { shape: 'parallelogram', width: 120, height: 44, cornerRadius: 0 },
};

const CENTER_SCALE = 1.15;

// ---------------------------------------------------------------------------
// SVG path builders — all centered at (0,0)
// ---------------------------------------------------------------------------

/**
 * Build a closed SVG `d` attribute for a given shape, centered at (0,0).
 */
export function nodeSvgPath(shape: NodeShape, w: number, h: number, cr: number): string {
  const hw = w / 2;
  const hh = h / 2;

  switch (shape) {
    case 'rect': {
      const r = Math.min(cr, hw, hh);
      if (r <= 0) {
        return `M ${-hw} ${-hh} H ${hw} V ${hh} H ${-hw} Z`;
      }
      return (
        `M ${-hw + r} ${-hh}` +
        ` H ${hw - r} A ${r} ${r} 0 0 1 ${hw} ${-hh + r}` +
        ` V ${hh - r} A ${r} ${r} 0 0 1 ${hw - r} ${hh}` +
        ` H ${-hw + r} A ${r} ${r} 0 0 1 ${-hw} ${hh - r}` +
        ` V ${-hh + r} A ${r} ${r} 0 0 1 ${-hw + r} ${-hh}` +
        ` Z`
      );
    }

    case 'rounded-rect': {
      const r = Math.min(cr, hw, hh);
      return (
        `M ${-hw + r} ${-hh}` +
        ` H ${hw - r} A ${r} ${r} 0 0 1 ${hw} ${-hh + r}` +
        ` V ${hh - r} A ${r} ${r} 0 0 1 ${hw - r} ${hh}` +
        ` H ${-hw + r} A ${r} ${r} 0 0 1 ${-hw} ${hh - r}` +
        ` V ${-hh + r} A ${r} ${r} 0 0 1 ${-hw + r} ${-hh}` +
        ` Z`
      );
    }

    case 'pill': {
      // Stadium: full half-circle caps
      const r = Math.min(hh, hw);
      return (
        `M ${-hw + r} ${-hh}` +
        ` H ${hw - r}` +
        ` A ${r} ${r} 0 0 1 ${hw - r} ${hh}` +
        ` H ${-hw + r}` +
        ` A ${r} ${r} 0 0 1 ${-hw + r} ${-hh}` +
        ` Z`
      );
    }

    case 'diamond': {
      return `M 0 ${-hh} L ${hw} 0 L 0 ${hh} L ${-hw} 0 Z`;
    }

    case 'hexagon': {
      // Flat-top hexagon: indented by 1/4 width at top/bottom
      const indent = w * 0.22;
      return (
        `M ${-hw + indent} ${-hh}` +
        ` L ${hw - indent} ${-hh}` +
        ` L ${hw} 0` +
        ` L ${hw - indent} ${hh}` +
        ` L ${-hw + indent} ${hh}` +
        ` L ${-hw} 0` +
        ` Z`
      );
    }

    case 'parallelogram': {
      // Skew ~12px
      const skew = Math.min(12, hw * 0.2);
      return (
        `M ${-hw + skew} ${-hh}` +
        ` L ${hw} ${-hh}` +
        ` L ${hw - skew} ${hh}` +
        ` L ${-hw} ${hh}` +
        ` Z`
      );
    }

    case 'chamfered-rect': {
      // Rectangle with top-right corner chamfered
      const chamfer = Math.min(10, hw * 0.15, hh * 0.4);
      const r = Math.min(cr, hw, hh);
      return (
        `M ${-hw + r} ${-hh}` +
        ` H ${hw - chamfer}` +
        ` L ${hw} ${-hh + chamfer}` +
        ` V ${hh - r} A ${r} ${r} 0 0 1 ${hw - r} ${hh}` +
        ` H ${-hw + r} A ${r} ${r} 0 0 1 ${-hw} ${hh - r}` +
        ` V ${-hh + r} A ${r} ${r} 0 0 1 ${-hw + r} ${-hh}` +
        ` Z`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

/**
 * Get full visual descriptor for a node kind + center flag.
 * Deterministic — safe to call in tight loops and derived computations.
 */
export function getNodeVisual(kind: NodeKind, isCenter: boolean): NodeVisual {
  const spec = BASE_SPECS[kind];
  const scale = isCenter ? CENTER_SCALE : 1;
  const w = Math.round(spec.width * scale);
  const h = Math.round(spec.height * scale);
  const cr = spec.cornerRadius;
  const colors = kindVisuals[kind];

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
    labelFontSize: isCenter ? 14 : 11,
    labelColor: '#ffffff',
  };
}

// ---------------------------------------------------------------------------
// Edge anchoring per shape
// ---------------------------------------------------------------------------

/**
 * Compute the anchor point on the perimeter of a shape centered at (cx, cy),
 * in the direction toward (tx, ty).
 *
 * Uses exact intersection algorithms from geo.ts for rect and ellipse shapes.
 */
export function shapeEdgeAnchor(
  visual: NodeVisual,
  cx: number, cy: number,
  tx: number, ty: number,
): { x: number; y: number } {
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };

  const hw = visual.width / 2;
  const hh = visual.height / 2;

  switch (visual.shape) {
    case 'rect':
    case 'rounded-rect':
    case 'chamfered-rect':
    case 'parallelogram': {
      // Exact ray-rect intersection via geo.ts
      // Extend segment well past the rect boundary
      const len = Math.hypot(dx, dy);
      const farX = cx + (dx / len) * (hw + hh + len);
      const farY = cy + (dy / len) * (hw + hh + len);
      const rect = { x: cx - hw, y: cy - hh, w: visual.width, h: visual.height };
      const hits = rectangleIntersectLineSegment(rect, [{ x: cx, y: cy }, { x: farX, y: farY }]);
      if (hits.length > 0) {
        // Pick closest hit to center
        let best = hits[0];
        let bestDist = (best.x - cx) ** 2 + (best.y - cy) ** 2;
        for (let i = 1; i < hits.length; i++) {
          const d = (hits[i].x - cx) ** 2 + (hits[i].y - cy) ** 2;
          if (d < bestDist) { best = hits[i]; bestDist = d; }
        }
        return best;
      }
      // Fallback: parametric ray-rect
      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);
      const s = Math.min(hw / (absDx || 1), hh / (absDy || 1));
      return { x: cx + dx * s, y: cy + dy * s };
    }

    case 'pill': {
      // Pill (stadium) — use ellipse intersection for the circular caps
      const hits = ellipseSegmentInterceptPoints(
        { center: { x: cx, y: cy }, halfWidth: hw, halfHeight: hh },
        [{ x: cx, y: cy }, { x: tx, y: ty }]
      );
      if (hits.length > 0) {
        let best = hits[0];
        let bestDist = (best.x - tx) ** 2 + (best.y - ty) ** 2;
        for (let i = 1; i < hits.length; i++) {
          const d = (hits[i].x - tx) ** 2 + (hits[i].y - ty) ** 2;
          if (d < bestDist) { best = hits[i]; bestDist = d; }
        }
        return best;
      }
      // Fallback
      const angle = Math.atan2(dy, dx);
      return { x: cx + hw * Math.cos(angle), y: cy + hh * Math.sin(angle) };
    }

    case 'diamond': {
      // Diamond (rhombus) intersection: |dx/hw| + |dy/hh| = 1 on the boundary
      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);
      const t = (absDx / hw) + (absDy / hh);
      if (t === 0) return { x: cx, y: cy };
      const s = 1 / t;
      return { x: cx + dx * s, y: cy + dy * s };
    }

    case 'hexagon': {
      // Exact ellipse intersection for hexagon approximation
      const hits = ellipseSegmentInterceptPoints(
        { center: { x: cx, y: cy }, halfWidth: hw, halfHeight: hh },
        [{ x: cx, y: cy }, { x: tx, y: ty }]
      );
      if (hits.length > 0) {
        let best = hits[0];
        let bestDist = (best.x - tx) ** 2 + (best.y - ty) ** 2;
        for (let i = 1; i < hits.length; i++) {
          const d = (hits[i].x - tx) ** 2 + (hits[i].y - ty) ** 2;
          if (d < bestDist) { best = hits[i]; bestDist = d; }
        }
        return best;
      }
      const angle = Math.atan2(dy, dx);
      return { x: cx + hw * Math.cos(angle), y: cy + hh * Math.sin(angle) };
    }
  }
}

/**
 * Shape classification helpers for layout decisions.
 */
export function isRectLike(shape: NodeShape): boolean {
  return shape === 'rect' || shape === 'rounded-rect' || shape === 'chamfered-rect'
    || shape === 'pill' || shape === 'parallelogram';
}

export function isHeaderShape(shape: NodeShape): boolean {
  return shape === 'rect' || shape === 'rounded-rect' || shape === 'chamfered-rect';
}
