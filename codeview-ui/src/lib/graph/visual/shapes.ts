import type { NodeKind } from '$lib/graph';
import type { NodeShape, ShapeSpec } from './types';

export const BASE_SPECS: Record<NodeKind, ShapeSpec> = {
  Crate:      { shape: 'rounded-rect', width: 140, height: 48, cornerRadius: 12 },
  Module:     { shape: 'rounded-rect', width: 120, height: 40, cornerRadius: 10 },
  Struct:     { shape: 'rect',         width: 132, height: 44, cornerRadius: 2 },
  StructField:{ shape: 'rect',         width: 100, height: 32, cornerRadius: 2 },
  Enum:       { shape: 'chamfered-rect', width: 132, height: 44, cornerRadius: 2 },
  Variant:    { shape: 'chamfered-rect', width: 100, height: 32, cornerRadius: 2 },
  Union:      { shape: 'rect',         width: 132, height: 44, cornerRadius: 2, strokeDasharray: '6 3' },
  Trait:      { shape: 'diamond',      width: 90,  height: 60, cornerRadius: 0 },
  TraitAlias: { shape: 'diamond',      width: 78,  height: 52, cornerRadius: 0 },
  Impl:       { shape: 'hexagon',      width: 110, height: 48, cornerRadius: 0 },
  Function:   { shape: 'pill',         width: 120, height: 44, cornerRadius: 22 },
  TypeAlias:  { shape: 'parallelogram', width: 120, height: 44, cornerRadius: 0 },
  AssocType:  { shape: 'parallelogram', width: 100, height: 36, cornerRadius: 0 },
  Constant:   { shape: 'rect',         width: 100, height: 36, cornerRadius: 2 },
  AssocConst: { shape: 'rect',         width: 100, height: 32, cornerRadius: 2 },
  Static:     { shape: 'rect',         width: 100, height: 36, cornerRadius: 2, strokeDasharray: '4 2' },
  Macro:      { shape: 'chamfered-rect', width: 110, height: 40, cornerRadius: 2 },
  Primitive:  { shape: 'rounded-rect', width: 90,  height: 36, cornerRadius: 8 },
  ExternCrate:{ shape: 'rounded-rect', width: 120, height: 40, cornerRadius: 10, strokeDasharray: '6 3' },
  Import:     { shape: 'parallelogram', width: 100, height: 36, cornerRadius: 0 },
  ProcMacro:  { shape: 'chamfered-rect', width: 110, height: 40, cornerRadius: 2 },
};

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

const BASE_HEADER_HEIGHT = 18;

export function buildHeaderPath(shape: NodeShape, w: number, h: number, cr: number, isCenter: boolean): { headerPath: string; headerHeight: number } {
  if (!isHeaderShape(shape)) {
    return { headerPath: '', headerHeight: 0 };
  }

  const hw = w / 2;
  const hh = h / 2;
  const hHeight = Math.min(BASE_HEADER_HEIGHT + (isCenter ? 2 : 0), h - 12);
  const r = Math.min(cr, hw, hh);
  const headerR = Math.min(r, hHeight);
  const topY = -hh;
  const headerBottomY = topY + hHeight;

  if (shape === 'chamfered-rect') {
    const chamfer = Math.min(10, hw * 0.15, hh * 0.4);
    const rightXAtHeaderBottom =
      hHeight <= chamfer
        ? (hw - chamfer + hHeight)
        : hw;

    const headerPath =
      `M ${-hw + headerR} ${topY}` +
      ` H ${hw - chamfer}` +
      ` L ${hw} ${topY + chamfer}` +
      ` V ${headerBottomY}` +
      ` H ${-hw}` +
      ` V ${topY + headerR} A ${headerR} ${headerR} 0 0 1 ${-hw + headerR} ${topY}` +
      ` Z`;

    if (hHeight <= chamfer) {
      return {
        headerPath:
          `M ${-hw + headerR} ${topY}` +
          ` H ${hw - chamfer}` +
          ` L ${rightXAtHeaderBottom} ${headerBottomY}` +
          ` H ${-hw}` +
          ` V ${topY + headerR} A ${headerR} ${headerR} 0 0 1 ${-hw + headerR} ${topY}` +
          ` Z`,
        headerHeight: hHeight
      };
    }

    return { headerPath, headerHeight: hHeight };
  }

  const headerPath =
    `M ${-hw + headerR} ${topY}` +
    ` H ${hw - headerR} A ${headerR} ${headerR} 0 0 1 ${hw} ${topY + headerR}` +
    ` V ${headerBottomY}` +
    ` H ${-hw}` +
    ` V ${topY + headerR} A ${headerR} ${headerR} 0 0 1 ${-hw + headerR} ${topY}` +
    ` Z`;

  return { headerPath, headerHeight: hHeight };
}

export function isRectLike(shape: NodeShape): boolean {
  return shape === 'rect' || shape === 'rounded-rect' || shape === 'chamfered-rect'
    || shape === 'pill' || shape === 'parallelogram';
}

export function isHeaderShape(shape: NodeShape): boolean {
  return shape === 'rect' || shape === 'rounded-rect' || shape === 'chamfered-rect';
}
