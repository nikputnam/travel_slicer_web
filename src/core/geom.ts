import type { BBox, Vec2 } from './types.ts';

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function signedArea(pts: Vec2[]): number {
  let s = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    s += p.x * q.y - q.x * p.y;
  }
  return s / 2;
}

export function perimeter(pts: Vec2[], closed = true): number {
  let l = 0;
  for (let i = 1; i < pts.length; i++) l += dist(pts[i - 1], pts[i]);
  if (closed && pts.length > 1) l += dist(pts[pts.length - 1], pts[0]);
  return l;
}

export function bboxOf(pts: Vec2[]): BBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function bboxUnion(a: BBox, b: BBox): BBox {
  return {
    minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY),
  };
}

export function bboxOverlap(a: BBox, b: BBox, margin = 0): boolean {
  return a.minX <= b.maxX + margin && b.minX <= a.maxX + margin &&
    a.minY <= b.maxY + margin && b.minY <= a.maxY + margin;
}

/** Euclidean gap between two boxes; 0 when they overlap. */
export function bboxDistance(a: BBox, b: BBox): number {
  const dx = Math.max(0, a.minX - b.maxX, b.minX - a.maxX);
  const dy = Math.max(0, a.minY - b.maxY, b.minY - a.maxY);
  return Math.hypot(dx, dy);
}

export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function orient(a: Vec2, b: Vec2, c: Vec2): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

export function segmentsIntersect(p1: Vec2, p2: Vec2, q1: Vec2, q2: Vec2): boolean {
  const d1 = orient(q1, q2, p1), d2 = orient(q1, q2, p2);
  const d3 = orient(p1, p2, q1), d4 = orient(p1, p2, q2);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

/** Squared distance from p to segment ab, plus the parameter t of the closest point. */
export function pointSegmentDist2(p: Vec2, a: Vec2, b: Vec2): { d2: number; t: number } {
  const vx = b.x - a.x, vy = b.y - a.y;
  const l2 = vx * vx + vy * vy;
  let t = l2 === 0 ? 0 : ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * vx - p.x, cy = a.y + t * vy - p.y;
  return { d2: cx * cx + cy * cy, t };
}

/** Distance from point p to the straight segment ab. */
export function pointSegmentDist(p: Vec2, a: Vec2, b: Vec2): number {
  return Math.sqrt(pointSegmentDist2(p, a, b).d2);
}

/** Minimum distance between segment ab and an axis-aligned box. */
export function segmentBBoxDistance(a: Vec2, b: Vec2, box: BBox): number {
  const corners = [
    { x: box.minX, y: box.minY }, { x: box.maxX, y: box.minY },
    { x: box.maxX, y: box.maxY }, { x: box.minX, y: box.maxY },
  ];
  const inside = (p: Vec2) => p.x >= box.minX && p.x <= box.maxX && p.y >= box.minY && p.y <= box.maxY;
  if (inside(a) || inside(b)) return 0;
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const c = corners[i], d = corners[(i + 1) % 4];
    if (segmentsIntersect(a, b, c, d)) return 0;
    best = Math.min(best, pointSegmentDist(c, a, b), pointSegmentDist(a, c, d), pointSegmentDist(b, c, d));
  }
  return best;
}

/** Do two closed polygons overlap as regions (share interior, or one contains the other)? */
export function polygonsOverlap(a: Vec2[], aBox: BBox, b: Vec2[], bBox: BBox): boolean {
  if (!bboxOverlap(aBox, bBox)) return false;
  if (pointInPolygon(a[0], b) || pointInPolygon(b[0], a)) return true;
  for (let i = 0; i < a.length; i++) {
    const p1 = a[i], p2 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      if (segmentsIntersect(p1, p2, b[j], b[(j + 1) % b.length])) return true;
    }
  }
  return false;
}

/** Resample a closed polygon so that no edge is longer than `step`, keeping all original vertices. */
export function densify(pts: Vec2[], step: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    out.push(a);
    const d = dist(a, b);
    const n = Math.floor(d / step);
    for (let k = 1; k <= n; k++) {
      const t = k / (n + 1);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

/** Drop vertices closer than `step` to their predecessor (coarse copy for topology tests). */
export function simplify(pts: Vec2[], step: number): Vec2[] {
  if (pts.length <= 8) return pts;
  const out: Vec2[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (dist(out[out.length - 1], pts[i]) >= step) out.push(pts[i]);
  }
  return out.length >= 3 ? out : pts;
}

/**
 * Closest point on a closed polygon to p. Returns the edge index i (edge from pts[i] to pts[i+1])
 * and the point itself.
 */
export function closestPointOnLoop(p: Vec2, pts: Vec2[]): { edge: number; t: number; point: Vec2; d2: number } {
  let best = { edge: 0, t: 0, point: pts[0], d2: Infinity };
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const r = pointSegmentDist2(p, a, b);
    if (r.d2 < best.d2) {
      best = { edge: i, t: r.t, point: { x: a.x + (b.x - a.x) * r.t, y: a.y + (b.y - a.y) * r.t }, d2: r.d2 };
    }
  }
  return best;
}

/** Return a copy of the loop rotated to start at the closest point to p (inserting it if needed). */
export function rotateLoopToStartNear(pts: Vec2[], p: Vec2, mergeTol = 1e-3): Vec2[] {
  const c = closestPointOnLoop(p, pts);
  const n = pts.length;
  const a = pts[c.edge], b = pts[(c.edge + 1) % n];
  let startIdx: number;
  let arr = pts;
  if (dist(c.point, a) <= mergeTol) startIdx = c.edge;
  else if (dist(c.point, b) <= mergeTol) startIdx = (c.edge + 1) % n;
  else {
    arr = pts.slice(0, c.edge + 1).concat([c.point], pts.slice(c.edge + 1));
    startIdx = c.edge + 1;
  }
  return arr.slice(startIdx).concat(arr.slice(0, startIdx));
}

/** Minimum distance between two closed polylines (exact, O(n*m)). */
export function loopDistance(a: Vec2[], b: Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i < a.length; i++) {
    const p1 = a[i], p2 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      const q1 = b[j], q2 = b[(j + 1) % b.length];
      if (segmentsIntersect(p1, p2, q1, q2)) return 0;
      const d = Math.min(pointSegmentDist2(q1, p1, p2).d2, pointSegmentDist2(p1, q1, q2).d2);
      if (d < best) best = d;
    }
  }
  return Math.sqrt(best);
}

/** Minimum distance between two straight segments. */
export function segmentSegmentDistance(p1: Vec2, p2: Vec2, q1: Vec2, q2: Vec2): number {
  if (segmentsIntersect(p1, p2, q1, q2)) return 0;
  return Math.sqrt(Math.min(
    pointSegmentDist2(p1, q1, q2).d2, pointSegmentDist2(p2, q1, q2).d2,
    pointSegmentDist2(q1, p1, p2).d2, pointSegmentDist2(q2, p1, p2).d2,
  ));
}

/** Minimum distance between a straight segment and a closed polyline. */
export function segmentLoopDistance(a: Vec2, b: Vec2, loop: Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i < loop.length; i++) {
    const d = segmentSegmentDistance(a, b, loop[i], loop[(i + 1) % loop.length]);
    if (d < best) { best = d; if (best === 0) break; }
  }
  return best;
}
