import type { NodeKind } from '$lib/graph';
import type { Point } from '$lib/geo';
import { rectangleIntersectLineSegment, ellipseSegmentInterceptPoints } from '$lib/geo';
import type { NodeVisual } from './types';
import { getNodeVisual } from './node-visual';

/**
 * Compute the anchor point on the perimeter of a shape centered at (cx, cy),
 * in the direction toward (tx, ty).
 *
 * Uses exact intersection algorithms from geo for rect and ellipse shapes.
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
      const len = Math.hypot(dx, dy);
      const farX = cx + (dx / len) * (hw + hh + len);
      const farY = cy + (dy / len) * (hw + hh + len);
      const rect = { x: cx - hw, y: cy - hh, w: visual.width, h: visual.height };
      const hits = rectangleIntersectLineSegment(rect, [{ x: cx, y: cy }, { x: farX, y: farY }]);
      if (hits.length > 0) {
        let best = hits[0];
        let bestDist = (best.x - cx) ** 2 + (best.y - cy) ** 2;
        for (let i = 1; i < hits.length; i++) {
          const d = (hits[i].x - cx) ** 2 + (hits[i].y - cy) ** 2;
          if (d < bestDist) { best = hits[i]; bestDist = d; }
        }
        return best;
      }
      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);
      const s = Math.min(hw / (absDx || 1), hh / (absDy || 1));
      return { x: cx + dx * s, y: cy + dy * s };
    }

    case 'pill': {
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

    case 'diamond': {
      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);
      const t = (absDx / hw) + (absDy / hh);
      if (t === 0) return { x: cx, y: cy };
      const s = 1 / t;
      return { x: cx + dx * s, y: cy + dy * s };
    }

    case 'hexagon': {
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
 * Compute the edge anchor point on the perimeter of `from` in the direction of `to`.
 */
export function getVisNodeEdgeAnchor(from: { node: { kind: NodeKind }; isCenter: boolean; x: number; y: number }, to: { x: number; y: number }): Point {
  const visual = getNodeVisual(from.node.kind, from.isCenter);
  return shapeEdgeAnchor(visual, from.x, from.y, to.x, to.y);
}
