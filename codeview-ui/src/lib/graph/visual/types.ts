export type NodeShape =
  | 'rect'
  | 'rounded-rect'
  | 'pill'
  | 'diamond'
  | 'hexagon'
  | 'parallelogram'
  | 'chamfered-rect';

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
  headerPath: string;
  headerHeight: number;
  labelFontSize: number;
  labelColor: string;
};

export type ShapeSpec = {
  shape: NodeShape;
  width: number;
  height: number;
  cornerRadius: number;
  strokeDasharray?: string;
};
