import type { Point, LineSegment } from './types';
import { PRECISION } from './utils';
import { clamp } from './utils';
import { vectorCross } from './vector';

export function linesIntersectAt(
	lineA: LineSegment,
	lineB: LineSegment
): Point | null {
	const a1 = lineA[1].y - lineA[0].y;
	const b1 = lineA[0].x - lineA[1].x;
	const c1 = a1 * lineA[0].x + b1 * lineA[0].y;

	const a2 = lineB[1].y - lineB[0].y;
	const b2 = lineB[0].x - lineB[1].x;
	const c2 = a2 * lineB[0].x + b2 * lineB[0].y;

	const det = a1 * b2 - a2 * b1;
	if (Math.abs(det) < PRECISION) return null;

	return {
		x: (c1 * b2 - c2 * b1) / det,
		y: (a1 * c2 - a2 * c1) / det
	};
}

export function segmentsIntersectAt(a: LineSegment, b: LineSegment): Point | null {
	const r = { u: a[1].x - a[0].x, v: a[1].y - a[0].y };
	const s = { u: b[1].x - b[0].x, v: b[1].y - b[0].y };
	const crossRS = vectorCross(r, s);
	if (Math.abs(crossRS) < PRECISION) return null;

	const i = { u: b[0].x - a[0].x, v: b[0].y - a[0].y };
	const u = vectorCross(i, r) / crossRS;
	const t = vectorCross(i, s) / crossRS;

	if (t >= 0 && t < 1 && u >= 0 && u < 1) {
		return {
			x: a[0].x + r.u * t,
			y: a[0].y + r.v * t
		};
	}
	return null;
}

export function distanceToLineSegment(point: Point, line: LineSegment): number {
	const A = point.x - line[0].x;
	const B = point.y - line[0].y;
	const C = line[1].x - line[0].x;
	const D = line[1].y - line[0].y;

	const dot = A * C + B * D;
	const lenSq = C * C + D * D;
	let param = lenSq !== 0 ? dot / lenSq : -1;
	param = clamp(param, 0, 1);

	const xx = line[0].x + param * C;
	const yy = line[0].y + param * D;
	return Math.hypot(point.x - xx, point.y - yy);
}

export function pointOnLineSegment(
	point: Point,
	segment: LineSegment,
	threshold: number = PRECISION
): boolean {
	return distanceToLineSegment(point, segment) < threshold;
}

export function lineSegmentIntersectionPoints(
	l: LineSegment,
	s: LineSegment,
	threshold: number = PRECISION
): Point | null {
	const pt = linesIntersectAt(l, s);
	if (!pt) return null;
	if (
		pointOnLineSegment(pt, l, threshold) &&
		pointOnLineSegment(pt, s, threshold)
	) {
		return pt;
	}
	return null;
}

export function lineSegmentsDistance(s1: LineSegment, s2: LineSegment): number {
	if (segmentsIntersectAt(s1, s2)) return 0;
	return Math.min(
		distanceToLineSegment(s1[0], s2),
		distanceToLineSegment(s1[1], s2),
		distanceToLineSegment(s2[0], s1),
		distanceToLineSegment(s2[1], s1)
	);
}
