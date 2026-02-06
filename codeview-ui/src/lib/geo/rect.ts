import type { Point, Rect, LineSegment } from './types';
import { segmentsIntersectAt } from './segment';

/** Find all intersection points of a line segment with an axis-aligned rectangle. */
export function rectangleIntersectLineSegment(rect: Rect, segment: LineSegment): Point[] {
	const { x, y, w, h } = rect;
	const tl: Point = { x, y };
	const tr: Point = { x: x + w, y };
	const br: Point = { x: x + w, y: y + h };
	const bl: Point = { x, y: y + h };

	const edges: LineSegment[] = [
		[tl, tr],
		[tr, br],
		[br, bl],
		[bl, tl]
	];

	const results: Point[] = [];
	for (const edge of edges) {
		const pt = segmentsIntersectAt(segment, edge);
		if (pt) results.push(pt);
	}
	return results;
}

/** AABB overlap test (separating axis). */
export function rectangleIntersectRectangle(r1: Rect, r2: Rect): boolean {
	return (
		r1.x < r2.x + r2.w &&
		r1.x + r1.w > r2.x &&
		r1.y < r2.y + r2.h &&
		r1.y + r1.h > r2.y
	);
}
