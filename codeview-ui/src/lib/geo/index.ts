/**
 * 2D geometry primitives and algorithms.
 * Ported from excalidraw/packages/math/src/ — adapted to use plain `{x, y}` objects
 * instead of branded tuples.
 */

// Types
export type {
	Point,
	Vec2,
	Rect,
	LineSegment,
	Polygon,
	Ellipse,
	Curve,
	Triangle,
	InclusiveRange,
} from './types';

// Utils
export { PRECISION, clamp, round, isCloseTo, average } from './utils';

// Point
export {
	pointFrom,
	pointDistance,
	pointDistanceSq,
	pointsEqual,
	pointCenter,
	pointRotateRads,
	pointRotateDegs,
	pointTranslate,
	pointScaleFromOrigin,
	isPointWithinBounds,
} from './point';

// Vector
export {
	vector,
	vectorFromPoint,
	vectorAdd,
	vectorSubtract,
	vectorScale,
	vectorDot,
	vectorCross,
	vectorMagnitude,
	vectorMagnitudeSq,
	vectorNormalize,
	vectorNormal,
} from './vector';

// Angle
export {
	degreesToRadians,
	radiansToDegrees,
	cartesian2Polar,
	normalizeRadians,
	isRightAngleRads,
	radiansBetweenAngles,
	radiansDifference,
} from './angle';

// Segment
export {
	linesIntersectAt,
	segmentsIntersectAt,
	distanceToLineSegment,
	pointOnLineSegment,
	lineSegmentIntersectionPoints,
	lineSegmentsDistance,
} from './segment';

// Polygon
export {
	polygonIncludesPoint,
	polygonIncludesPointNonZero,
	pointOnPolygon,
	triangleIncludesPoint,
} from './polygon';

// Rect
export { rectangleIntersectLineSegment, rectangleIntersectRectangle } from './rect';

// Ellipse
export {
	ellipseIncludesPoint,
	ellipseTouchesPoint,
	ellipseDistanceFromPoint,
	ellipseSegmentInterceptPoints,
	ellipseLineIntersectionPoints,
} from './ellipse';

// Curve
export {
	bezierEquation,
	curveTangent,
	curveLength,
	curveLengthAtParameter,
	curvePointAtLength,
	curveIntersectLineSegment,
	curveClosestPoint,
	curvePointDistance,
	curveCatmullRomCubicApproxPoints,
	curveOffsetPoints,
} from './curve';

// Range
export { rangeInclusive, rangesOverlap, rangeIncludesValue, rangeIntersection } from './range';
