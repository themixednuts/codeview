/**
 * 2D geometry primitives and algorithms.
 * Ported from excalidraw/packages/math/src/ — adapted to use plain `{x, y}` objects
 * instead of branded tuples.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Point = { x: number; y: number };
export type Vec2 = { u: number; v: number };
export type Rect = { x: number; y: number; w: number; h: number };
export type LineSegment = [Point, Point];
export type Polygon = Point[];
export type Ellipse = { center: Point; halfWidth: number; halfHeight: number };
export type Curve = [Point, Point, Point, Point]; // cubic Bezier
export type Triangle = [Point, Point, Point];
export type InclusiveRange = [number, number];

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PRECISION = 10e-5;

/** Legendre-Gauss quadrature abscissae (24-point). */
const LG_T: readonly number[] = [
	-0.0640568928626056260850430826247450385909,
	0.0640568928626056260850430826247450385909,
	-0.1911188674736163091586398207570696318404,
	0.1911188674736163091586398207570696318404,
	-0.3150426796961633743867932913198102407864,
	0.3150426796961633743867932913198102407864,
	-0.4337935076260451384870842319133497124524,
	0.4337935076260451384870842319133497124524,
	-0.5454214713888395356583756172183723700107,
	0.5454214713888395356583756172183723700107,
	-0.6480936519369755692524957869107476266696,
	0.6480936519369755692524957869107476266696,
	-0.7401241915785543642438281030999784255232,
	0.7401241915785543642438281030999784255232,
	-0.8200019859739029219539498726697452080761,
	0.8200019859739029219539498726697452080761,
	-0.8864155270044010342131543419821967550873,
	0.8864155270044010342131543419821967550873,
	-0.9382745520027327585236490017087214496548,
	0.9382745520027327585236490017087214496548,
	-0.9747285559713094981983919930081690617411,
	0.9747285559713094981983919930081690617411,
	-0.9951872199970213601799974097007368118745,
	0.9951872199970213601799974097007368118745
];

/** Legendre-Gauss quadrature weights (24-point). */
const LG_C: readonly number[] = [
	0.1279381953467521569740561652246953718517,
	0.1279381953467521569740561652246953718517,
	0.1258374563468282961213753825111836887264,
	0.1258374563468282961213753825111836887264,
	0.121670472927803391204463153476262425607,
	0.121670472927803391204463153476262425607,
	0.1155056680537256013533444839067835598622,
	0.1155056680537256013533444839067835598622,
	0.1074442701159656347825773424466062227946,
	0.1074442701159656347825773424466062227946,
	0.0976186521041138882698806644642471544279,
	0.0976186521041138882698806644642471544279,
	0.086190161531953275917185202983742667185,
	0.086190161531953275917185202983742667185,
	0.0733464814110803057340336152531165181193,
	0.0733464814110803057340336152531165181193,
	0.0592985849154367807463677585001085845412,
	0.0592985849154367807463677585001085845412,
	0.0442774388174198061686027482113382288593,
	0.0442774388174198061686027482113382288593,
	0.0285313886289336631813078159518782864491,
	0.0285313886289336631813078159518782864491,
	0.0123412297999871995468056670700372915759,
	0.0123412297999871995468056670700372915759
];

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Point operations
// ---------------------------------------------------------------------------

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
		y: dx * sin + dy * cos + center.y
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
		y: mid.y + (p.y - mid.y) * multiplier
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

// ---------------------------------------------------------------------------
// Vector operations
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Angle operations
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Line operations (infinite lines defined by two points)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Segment operations
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Polygon operations
// ---------------------------------------------------------------------------

/** Ray casting point-in-polygon test. */
export function polygonIncludesPoint(point: Point, polygon: Polygon): boolean {
	const n = polygon.length;
	let inside = false;
	for (let i = 0, j = n - 1; i < n; j = i++) {
		const xi = polygon[i].x, yi = polygon[i].y;
		const xj = polygon[j].x, yj = polygon[j].y;
		if (
			yi > point.y !== yj > point.y &&
			point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi
		) {
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
		const xi = polygon[i].x, yi = polygon[i].y;
		const xj = polygon[j].x, yj = polygon[j].y;
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

export function pointOnPolygon(
	p: Point,
	poly: Polygon,
	threshold: number = PRECISION
): boolean {
	const n = poly.length;
	for (let i = 0, j = n - 1; i < n; j = i++) {
		if (pointOnLineSegment(p, [poly[j], poly[i]], threshold)) return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// Triangle operations
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Rectangle operations
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Ellipse operations
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Curve operations (cubic Bezier)
// ---------------------------------------------------------------------------

/** Evaluate cubic Bezier at parameter t. */
export function bezierEquation(c: Curve, t: number): Point {
	const mt = 1 - t;
	const mt2 = mt * mt;
	const t2 = t * t;
	return {
		x: mt2 * mt * c[0].x + 3 * mt2 * t * c[1].x + 3 * mt * t2 * c[2].x + t2 * t * c[3].x,
		y: mt2 * mt * c[0].y + 3 * mt2 * t * c[1].y + 3 * mt * t2 * c[2].y + t2 * t * c[3].y
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
			3 * t2 * c[3].y
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
export function curveIntersectLineSegment(c: Curve, l: LineSegment): Point[] {
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
		[0.9, 0.9]
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
export function curveClosestPoint(
	c: Curve,
	p: Point,
	tolerance: number = 0.5
): Point {
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
export function curveCatmullRomCubicApproxPoints(
	points: Point[],
	tension: number = 0.5
): Curve[] {
	if (points.length < 2) return [];
	const curves: Curve[] = [];

	for (let i = 0; i < points.length - 1; i++) {
		const p0 = points[Math.max(0, i - 1)];
		const p1 = points[i];
		const p2 = points[i + 1];
		const p3 = points[Math.min(points.length - 1, i + 2)];

		const cp1: Point = {
			x: p1.x + ((p2.x - p0.x) * tension) / 3,
			y: p1.y + ((p2.y - p0.y) * tension) / 3
		};
		const cp2: Point = {
			x: p2.x - ((p3.x - p1.x) * tension) / 3,
			y: p2.y - ((p3.y - p1.y) * tension) / 3
		};

		curves.push([p1, cp1, cp2, p2]);
	}
	return curves;
}

/** Generate offset (parallel) curve points. */
export function curveOffsetPoints(
	curve: Curve,
	offset: number,
	steps: number = 50
): Point[] {
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
			y: p.y + ny * offset
		});
	}
	return result;
}

// ---------------------------------------------------------------------------
// Range operations
// ---------------------------------------------------------------------------

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
