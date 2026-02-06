import type { Point, Vec2 } from './types';

export function vector(x: number, y: number, originX = 0, originY = 0): Vec2 {
	return { u: x - originX, v: y - originY };
}

export function vectorFromPoint(p: Point, origin: Point = { x: 0, y: 0 }): Vec2 {
	return { u: p.x - origin.x, v: p.y - origin.y };
}

export function vectorAdd(a: Vec2, b: Vec2): Vec2 {
	return { u: a.u + b.u, v: a.v + b.v };
}

export function vectorSubtract(a: Vec2, b: Vec2): Vec2 {
	return { u: a.u - b.u, v: a.v - b.v };
}

export function vectorScale(v: Vec2, scalar: number): Vec2 {
	return { u: v.u * scalar, v: v.v * scalar };
}

export function vectorDot(a: Vec2, b: Vec2): number {
	return a.u * b.u + a.v * b.v;
}

export function vectorCross(a: Vec2, b: Vec2): number {
	return a.u * b.v - b.u * a.v;
}

export function vectorMagnitude(v: Vec2): number {
	return Math.hypot(v.u, v.v);
}

export function vectorMagnitudeSq(v: Vec2): number {
	return v.u * v.u + v.v * v.v;
}

export function vectorNormalize(v: Vec2): Vec2 {
	const m = vectorMagnitude(v);
	if (m === 0) return { u: 0, v: 0 };
	return { u: v.u / m, v: v.v / m };
}

export function vectorNormal(v: Vec2): Vec2 {
	return { u: v.v, v: -v.u };
}
