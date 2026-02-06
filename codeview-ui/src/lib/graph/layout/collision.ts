import type { Node } from '$lib/graph';
import type { VisNode } from './types';
import { MIN_NODE_SPACING } from './types';
import { getNodeVisual } from '$lib/graph/visual/node-visual';
import { isRectLike } from '$lib/graph/visual/shapes';
import { LABEL_CHAR_WIDTH, ARROWHEAD_LENGTH } from './types';

export function getNodeBoundingBox(node: Node, isCenter: boolean): { width: number; height: number } {
  const visual = getNodeVisual(node.kind, isCenter);
  const labelWidth = node.name.length * LABEL_CHAR_WIDTH;

  const effectiveWidth = isRectLike(visual.shape)
    ? visual.width
    : Math.max(visual.width, labelWidth + 8);

  const withArrowPadding = effectiveWidth + ARROWHEAD_LENGTH;

  return {
    width: withArrowPadding,
    height: visual.height
  };
}

export function resolveCollisionPair(
  a: VisNode, b: VisNode,
  boxA: { width: number; height: number },
  boxB: { width: number; height: number },
  centerId: string
): boolean {
  const halfWidthA = boxA.width / 2;
  const halfHeightA = boxA.height / 2;
  const halfWidthB = boxB.width / 2;
  const halfHeightB = boxB.height / 2;

  const dx = b.x - a.x;
  const dy = b.y - a.y;

  const overlapX = (halfWidthA + halfWidthB + MIN_NODE_SPACING) - Math.abs(dx);
  const overlapY = (halfHeightA + halfHeightB + MIN_NODE_SPACING) - Math.abs(dy);

  if (overlapX > 0 && overlapY > 0) {
    let pushX = 0;
    let pushY = 0;

    if (overlapX < overlapY) {
      pushX = dx >= 0 ? overlapX : -overlapX;
    } else {
      pushY = dy >= 0 ? overlapY : -overlapY;
    }

    if (a.node.id === centerId) {
      b.x += pushX;
      b.y += pushY;
    } else if (b.node.id === centerId) {
      a.x -= pushX;
      a.y -= pushY;
    } else {
      a.x -= pushX * 0.5;
      a.y -= pushY * 0.5;
      b.x += pushX * 0.5;
      b.y += pushY * 0.5;
    }
    return true;
  }
  return false;
}

export function resolveCollisions(
  visNodes: VisNode[],
  centerId: string,
  iterations: number = 15
): void {
  const n = visNodes.length;

  const boxes = visNodes.map(v => getNodeBoundingBox(v.node, v.isCenter));

  if (n < 30) {
    for (let iter = 0; iter < iterations; iter++) {
      let moved = false;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          if (resolveCollisionPair(visNodes[i], visNodes[j], boxes[i], boxes[j], centerId)) {
            moved = true;
          }
        }
      }
      if (!moved) break;
    }
  } else {
    let maxW = 0, maxH = 0;
    for (const box of boxes) {
      if (box.width > maxW) maxW = box.width;
      if (box.height > maxH) maxH = box.height;
    }
    const cellSize = Math.max(maxW, maxH) + MIN_NODE_SPACING;

    for (let iter = 0; iter < iterations; iter++) {
      let moved = false;

      const grid = new Map<string, number[]>();
      for (let i = 0; i < n; i++) {
        const v = visNodes[i];
        const hw = boxes[i].width / 2;
        const hh = boxes[i].height / 2;
        const minCX = Math.floor((v.x - hw) / cellSize);
        const maxCX = Math.floor((v.x + hw) / cellSize);
        const minCY = Math.floor((v.y - hh) / cellSize);
        const maxCY = Math.floor((v.y + hh) / cellSize);
        for (let cx = minCX; cx <= maxCX; cx++) {
          for (let cy = minCY; cy <= maxCY; cy++) {
            const key = `${cx},${cy}`;
            let cell = grid.get(key);
            if (!cell) {
              cell = [];
              grid.set(key, cell);
            }
            cell.push(i);
          }
        }
      }

      const checked = new Set<number>();
      for (const cell of grid.values()) {
        for (let a = 0; a < cell.length; a++) {
          for (let b = a + 1; b < cell.length; b++) {
            const i = cell[a], j = cell[b];
            const pairKey = i * n + j;
            if (checked.has(pairKey)) continue;
            checked.add(pairKey);
            if (resolveCollisionPair(visNodes[i], visNodes[j], boxes[i], boxes[j], centerId)) {
              moved = true;
            }
          }
        }
      }

      if (!moved) break;
    }
  }

  for (const node of visNodes) {
    node.baseX = node.x;
    node.baseY = node.y;
  }
}
