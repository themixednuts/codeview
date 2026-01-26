import type { Edge, Node } from './graph';

export type LayoutNode = Node & {
  x?: number | null;
  y?: number | null;
};

export type LayoutLink = Edge & {
  source: LayoutNode | string | number;
  target: LayoutNode | string | number;
};

export type LayoutState = {
  nodes: LayoutNode[];
  links: LayoutLink[];
};
