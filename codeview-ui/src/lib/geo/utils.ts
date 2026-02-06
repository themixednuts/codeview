export const PRECISION = 10e-5;

export function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

export function round(value: number, precision: number): number {
	const p = 10 ** precision;
	return Math.round(value * p) / p;
}

export function isCloseTo(a: number, b: number, precision: number = PRECISION): boolean {
	return Math.abs(a - b) < precision;
}

export function average(a: number, b: number): number {
	return (a + b) / 2;
}
