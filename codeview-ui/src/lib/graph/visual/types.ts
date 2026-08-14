export type NodeGlyph =
  | "rect"
  | "rounded-rect"
  | "pill"
  | "diamond"
  | "hexagon"
  | "parallelogram"
  | "chamfered-rect";

export type NodeVisual = {
  glyph: NodeGlyph;
  width: number;
  height: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
  strokeDasharray?: string;
  cornerRadius: number;
  svgPath: string;
  headerPath: string;
  headerHeight: number;
  labelFontSize: number;
  labelColor: string;
};

export type GlyphSpec = {
  glyph: NodeGlyph;
  width: number;
  height: number;
  cornerRadius: number;
  strokeDasharray?: string;
};
