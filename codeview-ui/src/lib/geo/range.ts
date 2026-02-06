import type { InclusiveRange } from './types';

export function rangeInclusive(start: number, end: number): InclusiveRange {
	return [start, end];
}

export function rangesOverlap(r1: InclusiveRange, r2: InclusiveRange): boolean {
	if (r1[0] <= r2[0]) return r1[1] >= r2[0];
	return r2[1] >= r1[0];
}

export function rangeIncludesValue(value: number, range: InclusiveRange): boolean {
	return value >= range[0] && value <= range[1];
}

export function rangeIntersection(
	r1: InclusiveRange,
	r2: InclusiveRange
): InclusiveRange | null {
	const start = Math.max(r1[0], r2[0]);
	const end = Math.min(r1[1], r2[1]);
	if (start > end) return null;
	return [start, end];
}
