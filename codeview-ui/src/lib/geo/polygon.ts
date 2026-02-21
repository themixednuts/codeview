import type { Point, Polygon, Triangle } from './types';
import { PRECISION } from './utils';
import { pointOnLineSegment } from './segment';

/** Ray casting point-in-polygon test. */
export function polygonIncludesPoint(point: Point, polygon: Polygon): boolean {
	const n = polygon.length;
	let inside = false;
	for (let i = 0, j = n - 1; i < n; j = i++) {
		const xi = polygon[i].x,
			yi = polygon[i].y;
		const xj = polygon[j].x,
			yj = polygon[j].y;
		if (yi > point.y !== yj > point.y && point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi) {
			inside = !inside;
		}
	}
	return inside;
}

/** Winding number point-in-polygon test. */
export function polygonIncludesPointNonZero(point: Point, polygon: Polygon): boolean {
	const n = polygon.length;
	let winding = 0;
	for (let i = 0, j = n - 1; i < n; j = i++) {
		const xi = polygon[i].x,
			yi = polygon[i].y;
		const xj = polygon[j].x,
			yj = polygon[j].y;
		if (yj <= point.y) {
			if (yi > point.y) {
				if ((xj - point.x) * (yi - point.y) - (xi - point.x) * (yj - point.y) > 0) {
					winding++;
				}
			}
		} else {
			if (yi <= point.y) {
				if ((xj - point.x) * (yi - point.y) - (xi - point.x) * (yj - point.y) < 0) {
					winding--;
				}
			}
		}
	}
	return winding !== 0;
}

export function pointOnPolygon(p: Point, poly: Polygon, threshold: number = PRECISION): boolean {
	const n = poly.length;
	for (let i = 0, j = n - 1; i < n; j = i++) {
		if (pointOnLineSegment(p, [poly[j], poly[i]], threshold)) return true;
	}
	return false;
}

/** Barycentric coordinate point-in-triangle test. */
export function triangleIncludesPoint(triangle: Triangle, p: Point): boolean {
	const [a, b, c] = triangle;
	function sign(p1: Point, p2: Point, p3: Point): number {
		return (p1.x - p3.x) * (p2.y - p3.y) - (p2.x - p3.x) * (p1.y - p3.y);
	}
	const d1 = sign(p, a, b);
	const d2 = sign(p, b, c);
	const d3 = sign(p, c, a);
	const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
	const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
	return !(hasNeg && hasPos);
}
