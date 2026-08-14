import type { NodeKind } from "#lib/graph.js";
import type { NodeGlyph, GlyphSpec } from "./types";

export const BASE_SPECS = {
  Crate: { glyph: "rounded-rect", width: 140, height: 48, cornerRadius: 12 },
  Module: { glyph: "rounded-rect", width: 120, height: 40, cornerRadius: 10 },
  Struct: { glyph: "rect", width: 132, height: 44, cornerRadius: 2 },
  StructField: { glyph: "rect", width: 100, height: 32, cornerRadius: 2 },
  Enum: { glyph: "chamfered-rect", width: 132, height: 44, cornerRadius: 2 },
  Variant: { glyph: "chamfered-rect", width: 100, height: 32, cornerRadius: 2 },
  Union: { glyph: "rect", width: 132, height: 44, cornerRadius: 2, strokeDasharray: "6 3" },
  Trait: { glyph: "diamond", width: 90, height: 60, cornerRadius: 0 },
  TraitAlias: { glyph: "diamond", width: 78, height: 52, cornerRadius: 0 },
  Impl: { glyph: "hexagon", width: 110, height: 48, cornerRadius: 0 },
  Function: { glyph: "pill", width: 120, height: 44, cornerRadius: 22 },
  TypeAlias: { glyph: "parallelogram", width: 120, height: 44, cornerRadius: 0 },
  AssocType: { glyph: "parallelogram", width: 100, height: 36, cornerRadius: 0 },
  Constant: { glyph: "rect", width: 100, height: 36, cornerRadius: 2 },
  AssocConst: { glyph: "rect", width: 100, height: 32, cornerRadius: 2 },
  Static: { glyph: "rect", width: 100, height: 36, cornerRadius: 2, strokeDasharray: "4 2" },
  Macro: { glyph: "chamfered-rect", width: 110, height: 40, cornerRadius: 2 },
  Primitive: { glyph: "rounded-rect", width: 90, height: 36, cornerRadius: 8 },
  ExternCrate: {
    glyph: "rounded-rect",
    width: 120,
    height: 40,
    cornerRadius: 10,
    strokeDasharray: "6 3",
  },
  Import: { glyph: "parallelogram", width: 100, height: 36, cornerRadius: 0 },
  ProcMacro: { glyph: "chamfered-rect", width: 110, height: 40, cornerRadius: 2 },
} as const satisfies { [K in NodeKind]: GlyphSpec };

/**
 * Build a closed SVG `d` attribute for a given glyph, centered at (0,0).
 */
export function nodeSvgPath(glyph: NodeGlyph, w: number, h: number, cr: number): string {
  const hw = w / 2;
  const hh = h / 2;

  switch (glyph) {
    case "rect": {
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

    case "rounded-rect": {
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

    case "pill": {
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

    case "diamond": {
      return `M 0 ${-hh} L ${hw} 0 L 0 ${hh} L ${-hw} 0 Z`;
    }

    case "hexagon": {
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

    case "parallelogram": {
      const skew = Math.min(12, hw * 0.2);
      return (
        `M ${-hw + skew} ${-hh}` +
        ` L ${hw} ${-hh}` +
        ` L ${hw - skew} ${hh}` +
        ` L ${-hw} ${hh}` +
        ` Z`
      );
    }

    case "chamfered-rect": {
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

type HeaderPath = {
  headerPath: string;
  headerHeight: number;
};

export function buildHeaderPath(
  glyph: NodeGlyph,
  w: number,
  h: number,
  cr: number,
  isCenter: boolean,
): HeaderPath {
  if (!isHeaderGlyph(glyph)) {
    return { headerPath: "", headerHeight: 0 };
  }

  const hw = w / 2;
  const hh = h / 2;
  const hHeight = Math.min(BASE_HEADER_HEIGHT + (isCenter ? 2 : 0), h - 12);
  const r = Math.min(cr, hw, hh);
  const headerR = Math.min(r, hHeight);
  const topY = -hh;
  const headerBottomY = topY + hHeight;

  if (glyph === "chamfered-rect") {
    const chamfer = Math.min(10, hw * 0.15, hh * 0.4);
    const rightXAtHeaderBottom = hHeight <= chamfer ? hw - chamfer + hHeight : hw;

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
        headerHeight: hHeight,
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

export function isRectLike(glyph: NodeGlyph): boolean {
  return (
    glyph === "rect" ||
    glyph === "rounded-rect" ||
    glyph === "chamfered-rect" ||
    glyph === "pill" ||
    glyph === "parallelogram"
  );
}

export function isHeaderGlyph(glyph: NodeGlyph): boolean {
  return glyph === "rect" || glyph === "rounded-rect" || glyph === "chamfered-rect";
}
