import type { Point } from './types';
import { PRECISION } from './utils';

export function degreesToRadians(d: number): number {
	return (d * Math.PI) / 180;
}

export function radiansToDegrees(r: number): number {
	return (r * 180) / Math.PI;
}

export function cartesian2Polar(point: Point): [number, number] {
	return [Math.hypot(point.x, point.y), Math.atan2(point.y, point.x)];
}

export function normalizeRadians(angle: number): number {
	const TAU = 2 * Math.PI;
	if (angle < 0) {
		return ((angle % TAU) + TAU) % TAU;
	}
	return angle % TAU;
}

export function isRightAngleRads(r: number): boolean {
	return Math.abs(Math.sin(2 * r)) < PRECISION;
}

export function radiansBetweenAngles(a: number, min: number, max: number): boolean {
	const na = normalizeRadians(a);
	const nmin = normalizeRadians(min);
	const nmax = normalizeRadians(max);
	if (nmin <= nmax) return na >= nmin && na <= nmax;
	return na >= nmin || na <= nmax;
}

export function radiansDifference(a: number, b: number): number {
	return normalizeRadians(a - b);
}
