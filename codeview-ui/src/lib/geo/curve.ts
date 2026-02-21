import type { Point, Curve } from './types';
import { PRECISION } from './utils';
import { clamp } from './utils';
import { pointDistance, pointDistanceSq } from './point';

/** Legendre-Gauss quadrature abscissae (24-point). */
const LG_T: readonly number[] = [
	-0.0640568928626056260850430826247450385909, 0.0640568928626056260850430826247450385909,
	-0.1911188674736163091586398207570696318404, 0.1911188674736163091586398207570696318404,
	-0.3150426796961633743867932913198102407864, 0.3150426796961633743867932913198102407864,
	-0.4337935076260451384870842319133497124524, 0.4337935076260451384870842319133497124524,
	-0.5454214713888395356583756172183723700107, 0.5454214713888395356583756172183723700107,
	-0.6480936519369755692524957869107476266696, 0.6480936519369755692524957869107476266696,
	-0.7401241915785543642438281030999784255232, 0.7401241915785543642438281030999784255232,
	-0.8200019859739029219539498726697452080761, 0.8200019859739029219539498726697452080761,
	-0.8864155270044010342131543419821967550873, 0.8864155270044010342131543419821967550873,
	-0.9382745520027327585236490017087214496548, 0.9382745520027327585236490017087214496548,
	-0.9747285559713094981983919930081690617411, 0.9747285559713094981983919930081690617411,
	-0.9951872199970213601799974097007368118745, 0.9951872199970213601799974097007368118745,
];

/** Legendre-Gauss quadrature weights (24-point). */
const LG_C: readonly number[] = [
	0.1279381953467521569740561652246953718517, 0.1279381953467521569740561652246953718517,
	0.1258374563468282961213753825111836887264, 0.1258374563468282961213753825111836887264,
	0.121670472927803391204463153476262425607, 0.121670472927803391204463153476262425607,
	0.1155056680537256013533444839067835598622, 0.1155056680537256013533444839067835598622,
	0.1074442701159656347825773424466062227946, 0.1074442701159656347825773424466062227946,
	0.0976186521041138882698806644642471544279, 0.0976186521041138882698806644642471544279,
	0.086190161531953275917185202983742667185, 0.086190161531953275917185202983742667185,
	0.0733464814110803057340336152531165181193, 0.0733464814110803057340336152531165181193,
	0.0592985849154367807463677585001085845412, 0.0592985849154367807463677585001085845412,
	0.0442774388174198061686027482113382288593, 0.0442774388174198061686027482113382288593,
	0.0285313886289336631813078159518782864491, 0.0285313886289336631813078159518782864491,
	0.0123412297999871995468056670700372915759, 0.0123412297999871995468056670700372915759,
];

/** Evaluate cubic Bezier at parameter t. */
export function bezierEquation(c: Curve, t: number): Point {
	const mt = 1 - t;
	const mt2 = mt * mt;
	const t2 = t * t;
	return {
		x: mt2 * mt * c[0].x + 3 * mt2 * t * c[1].x + 3 * mt * t2 * c[2].x + t2 * t * c[3].x,
		y: mt2 * mt * c[0].y + 3 * mt2 * t * c[1].y + 3 * mt * t2 * c[2].y + t2 * t * c[3].y,
	};
}

/** First derivative of cubic Bezier (tangent vector). */
export function curveTangent(c: Curve, t: number): Point {
	const mt = 1 - t;
	const mt2 = mt * mt;
	const t2 = t * t;
	return {
		x:
			-3 * mt2 * c[0].x +
			3 * mt2 * c[1].x -
			6 * t * mt * c[1].x -
			3 * t2 * c[2].x +
			6 * t * mt * c[2].x +
			3 * t2 * c[3].x,
		y:
			-3 * mt2 * c[0].y +
			3 * mt2 * c[1].y -
			6 * t * mt * c[1].y -
			3 * t2 * c[2].y +
			6 * t * mt * c[2].y +
			3 * t2 * c[3].y,
	};
}

/** Arc length via Legendre-Gauss quadrature (24-point). */
export function curveLength(c: Curve): number {
	let sum = 0;
	for (let i = 0; i < 24; i++) {
		const t = 0.5 * LG_T[i] + 0.5;
		const d = curveTangent(c, t);
		sum += LG_C[i] * Math.hypot(d.x, d.y);
	}
	return 0.5 * sum;
}

/** Arc length from 0 to parameter t. */
export function curveLengthAtParameter(c: Curve, t: number): number {
	if (t <= 0) return 0;
	if (t >= 1) return curveLength(c);
	const z1 = t / 2;
	let sum = 0;
	for (let i = 0; i < 24; i++) {
		const ct = z1 * LG_T[i] + z1;
		const d = curveTangent(c, ct);
		sum += LG_C[i] * Math.hypot(d.x, d.y);
	}
	return z1 * sum;
}

/** Find point at a given percentage of arc length (binary search). */
export function curvePointAtLength(c: Curve, percent: number): Point {
	if (percent <= 0) return bezierEquation(c, 0);
	if (percent >= 1) return bezierEquation(c, 1);

	const totalLength = curveLength(c);
	const targetLength = totalLength * percent;
	const tolerance = 0.001;

	let tMin = 0;
	let tMax = 1;
	let t = percent; // initial guess

	for (let i = 0; i < 20; i++) {
		const currentLength = curveLengthAtParameter(c, t);
		const error = Math.abs(currentLength - targetLength);
		if (error < tolerance) break;

		if (currentLength < targetLength) {
			tMin = t;
		} else {
			tMax = t;
		}
		t = (tMin + tMax) / 2;
	}
	return bezierEquation(c, t);
}

/**
 * Find intersections of a cubic Bezier with a line segment using
 * Newton-Raphson with analytical Jacobian.
 */
export function curveIntersectLineSegment(c: Curve, l: [Point, Point]): Point[] {
	const results: Point[] = [];

	function solve(t0: number, s0: number): Point | null {
		const tolerance = 1e-6;
		const maxIter = 20;
		let t = t0;
		let s = s0;

		for (let iter = 0; iter < maxIter; iter++) {
			const bp = bezierEquation(c, t);
			const lx = l[0].x + s * (l[1].x - l[0].x);
			const ly = l[0].y + s * (l[1].y - l[0].y);

			const fx = bp.x - lx;
			const fy = bp.y - ly;

			if (Math.abs(fx) < tolerance && Math.abs(fy) < tolerance) {
				if (t >= -PRECISION && t <= 1 + PRECISION && s >= -PRECISION && s <= 1 + PRECISION) {
					return bezierEquation(c, clamp(t, 0, 1));
				}
				return null;
			}

			const bt = curveTangent(c, t);
			const dlx = -(l[1].x - l[0].x);
			const dly = -(l[1].y - l[0].y);

			// Jacobian: [bt.x, dlx; bt.y, dly]
			const det = bt.x * dly - bt.y * dlx;
			if (Math.abs(det) < 1e-12) return null;

			const dt = (dly * fx - dlx * fy) / det;
			const ds = (-bt.y * fx + bt.x * fy) / det;

			t -= dt;
			s -= ds;
		}
		return null;
	}

	const guesses: [number, number][] = [
		[0.5, 0.5],
		[0.2, 0.3],
		[0.8, 0.7],
		[0.1, 0.1],
		[0.9, 0.9],
	];

	for (const [t0, s0] of guesses) {
		const pt = solve(t0, s0);
		if (pt) {
			const isDup = results.some((r) => pointDistance(r, pt) < 0.5);
			if (!isDup) results.push(pt);
		}
	}

	return results;
}

/** Find closest point on curve to a given point (coarse + refine). */
export function curveClosestPoint(c: Curve, p: Point, tolerance: number = 0.5): Point {
	const steps = 30;
	let minDist = Infinity;
	let minT = 0;

	for (let i = 0; i <= steps; i++) {
		const t = i / steps;
		const bp = bezierEquation(c, t);
		const d = pointDistanceSq(bp, p);
		if (d < minDist) {
			minDist = d;
			minT = t;
		}
	}

	// Refine with binary search
	let lo = Math.max(0, minT - 1 / steps);
	let hi = Math.min(1, minT + 1 / steps);

	while (hi - lo > tolerance / 1000) {
		const mid = (lo + hi) / 2;
		const e = tolerance / 10000;
		if (
			pointDistanceSq(bezierEquation(c, mid - e), p) <
			pointDistanceSq(bezierEquation(c, mid + e), p)
		) {
			hi = mid;
		} else {
			lo = mid;
		}
	}

	return bezierEquation(c, (lo + hi) / 2);
}

/** Distance from a point to the closest point on a curve. */
export function curvePointDistance(c: Curve, p: Point): number {
	return pointDistance(curveClosestPoint(c, p), p);
}

/** Convert Catmull-Rom spline to cubic Bezier curves. */
export function curveCatmullRomCubicApproxPoints(points: Point[], tension: number = 0.5): Curve[] {
	if (points.length < 2) return [];
	const curves: Curve[] = [];

	for (let i = 0; i < points.length - 1; i++) {
		const p0 = points[Math.max(0, i - 1)];
		const p1 = points[i];
		const p2 = points[i + 1];
		const p3 = points[Math.min(points.length - 1, i + 2)];

		const cp1: Point = {
			x: p1.x + ((p2.x - p0.x) * tension) / 3,
			y: p1.y + ((p2.y - p0.y) * tension) / 3,
		};
		const cp2: Point = {
			x: p2.x - ((p3.x - p1.x) * tension) / 3,
			y: p2.y - ((p3.y - p1.y) * tension) / 3,
		};

		curves.push([p1, cp1, cp2, p2]);
	}
	return curves;
}

/** Generate offset (parallel) curve points. */
export function curveOffsetPoints(curve: Curve, offset: number, steps: number = 50): Point[] {
	const result: Point[] = [];
	for (let i = 0; i <= steps; i++) {
		const t = i / steps;
		const p = bezierEquation(curve, t);
		const tan = curveTangent(curve, t);
		const m = Math.hypot(tan.x, tan.y);
		if (m === 0) {
			result.push(p);
			continue;
		}
		const nx = -tan.y / m;
		const ny = tan.x / m;
		result.push({
			x: p.x + nx * offset,
			y: p.y + ny * offset,
		});
	}
	return result;
}
