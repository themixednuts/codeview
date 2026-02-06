import type { Point, Ellipse, LineSegment } from './types';
import { PRECISION } from './utils';
import { clamp } from './utils';
import { pointDistance } from './point';

export function ellipseIncludesPoint(p: Point, e: Ellipse): boolean {
	const nx = (p.x - e.center.x) / e.halfWidth;
	const ny = (p.y - e.center.y) / e.halfHeight;
	return nx * nx + ny * ny <= 1;
}

export function ellipseTouchesPoint(
	point: Point,
	e: Ellipse,
	threshold: number = PRECISION
): boolean {
	return ellipseDistanceFromPoint(point, e) <= threshold;
}

/**
 * Iterative Newton approximation of the distance from a point to the closest
 * point on an ellipse outline. Uses 3 iterations.
 */
export function ellipseDistanceFromPoint(p: Point, e: Ellipse): number {
	const px = Math.abs(p.x - e.center.x);
	const py = Math.abs(p.y - e.center.y);
	const a = e.halfWidth;
	const b = e.halfHeight;

	let tx = 0.70710678118; // 1/sqrt(2)
	let ty = 0.70710678118;

	for (let i = 0; i < 3; i++) {
		const ex = ((a * a - b * b) * tx ** 3) / a;
		const ey = ((b * b - a * a) * ty ** 3) / b;
		const rx = a * tx - ex;
		const ry = b * ty - ey;
		const qx = px - ex;
		const qy = py - ey;
		const r = Math.hypot(ry, rx);
		const q = Math.hypot(qy, qx);
		tx = clamp((qx * r / q + ex) / a, 0, 1);
		ty = clamp((qy * r / q + ey) / b, 0, 1);
		const t = Math.hypot(ty, tx);
		tx /= t;
		ty /= t;
	}

	return Math.hypot(px - a * tx, py - b * ty);
}

/** Parametric quadratic intersection of ellipse with a line segment. */
export function ellipseSegmentInterceptPoints(
	e: Ellipse,
	segment: LineSegment
): Point[] {
	const { center, halfWidth: a, halfHeight: b } = e;
	const dx = segment[1].x - segment[0].x;
	const dy = segment[1].y - segment[0].y;
	const ox = segment[0].x - center.x;
	const oy = segment[0].y - center.y;

	const A = (dx * dx) / (a * a) + (dy * dy) / (b * b);
	const B = 2 * ((ox * dx) / (a * a) + (oy * dy) / (b * b));
	const C = (ox * ox) / (a * a) + (oy * oy) / (b * b) - 1;

	const disc = B * B - 4 * A * C;
	if (disc < 0) return [];

	const results: Point[] = [];
	if (disc === 0) {
		const t = -B / (2 * A);
		if (t >= 0 && t <= 1) {
			results.push({
				x: segment[0].x + dx * t,
				y: segment[0].y + dy * t
			});
		}
	} else {
		const sqrtDisc = Math.sqrt(disc);
		for (const sign of [-1, 1]) {
			const t = (-B + sign * sqrtDisc) / (2 * A);
			if (t >= 0 && t <= 1) {
				results.push({
					x: segment[0].x + dx * t,
					y: segment[0].y + dy * t
				});
			}
		}
	}
	return results;
}

/** Intersection of an ellipse with an infinite line (defined by two points). */
export function ellipseLineIntersectionPoints(
	e: Ellipse,
	line: LineSegment
): Point[] {
	const { center, halfWidth: a, halfHeight: b } = e;
	const gx = line[0].x - center.x;
	const gy = line[0].y - center.y;
	const hx = line[1].x - center.x;
	const hy = line[1].y - center.y;
	const dx = hx - gx;
	const dy = hy - gy;

	const A = (dx * dx) / (a * a) + (dy * dy) / (b * b);
	const B = 2 * ((gx * dx) / (a * a) + (gy * dy) / (b * b));
	const C = (gx * gx) / (a * a) + (gy * gy) / (b * b) - 1;

	const disc = B * B - 4 * A * C;
	if (disc < 0) return [];

	const results: Point[] = [];
	const sqrtDisc = Math.sqrt(disc);
	for (const sign of [-1, 1]) {
		const t = (-B + sign * sqrtDisc) / (2 * A);
		const px = line[0].x + dx * t;
		const py = line[0].y + dy * t;
		if (!isNaN(px) && !isNaN(py)) {
			results.push({ x: px, y: py });
		}
	}

	// Deduplicate nearly-identical points
	if (results.length === 2 && pointDistance(results[0], results[1]) < PRECISION) {
		return [results[0]];
	}
	return results;
}
