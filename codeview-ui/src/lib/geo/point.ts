import type { Point, Vec2 } from './types';
import { degreesToRadians } from './angle';

export function pointFrom(x: number, y: number): Point {
	return { x, y };
}

export function pointDistance(a: Point, b: Point): number {
	return Math.hypot(b.x - a.x, b.y - a.y);
}

export function pointDistanceSq(a: Point, b: Point): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	return dx * dx + dy * dy;
}

export function pointsEqual(a: Point, b: Point, tolerance: number = 0): boolean {
	return Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance;
}

export function pointCenter(a: Point, b: Point): Point {
	return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function pointRotateRads(point: Point, center: Point, angle: number): Point {
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	const dx = point.x - center.x;
	const dy = point.y - center.y;
	return {
		x: dx * cos - dy * sin + center.x,
		y: dx * sin + dy * cos + center.y,
	};
}

export function pointRotateDegs(point: Point, center: Point, degrees: number): Point {
	return pointRotateRads(point, center, degreesToRadians(degrees));
}

export function pointTranslate(p: Point, v: Vec2): Point {
	return { x: p.x + v.u, y: p.y + v.v };
}

export function pointScaleFromOrigin(p: Point, mid: Point, multiplier: number): Point {
	return {
		x: mid.x + (p.x - mid.x) * multiplier,
		y: mid.y + (p.y - mid.y) * multiplier,
	};
}

export function isPointWithinBounds(p: Point, q: Point, r: Point): boolean {
	return (
		q.x >= Math.min(p.x, r.x) &&
		q.x <= Math.max(p.x, r.x) &&
		q.y >= Math.min(p.y, r.y) &&
		q.y <= Math.max(p.y, r.y)
	);
}
