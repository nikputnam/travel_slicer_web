/**
 * Cached XY distances between walls. Bounding boxes give a cheap lower bound; when that is
 * not enough to decide, the exact polyline distance is computed on a coarsened copy of the loops.
 */
import { bboxDistance, bboxOf, pointSegmentDist, segmentBBoxDistance, segmentLoopDistance, segmentSegmentDistance, simplify } from './geom.ts';
import type { BBox, Loop, Vec2 } from './types.ts';

/** Coarsening step (mm). Error is bounded by the sagitta of dropped vertices, covered by MARGIN. */
const STEP = 1.5;
/** Safety margin subtracted from exact distances (mm). */
export const MARGIN = 0.5;

const coarseCache = new WeakMap<Loop, Vec2[]>();
export function coarseOf(l: Loop): Vec2[] {
  let c = coarseCache.get(l);
  if (!c) { c = simplify(l.pts, STEP); coarseCache.set(l, c); }
  return c;
}

/** A loop cut into runs of consecutive edges, each with its bounding box, for fast distance queries. */
interface Chunk { box: BBox; from: number; to: number }
interface ChunkedLoop { pts: Vec2[]; chunks: Chunk[] }
const CHUNK = 12;
const chunkedCache = new WeakMap<Loop, ChunkedLoop>();
function chunkedOf(l: Loop): ChunkedLoop {
  let c = chunkedCache.get(l);
  if (c) return c;
  const pts = coarseOf(l);
  const chunks: Chunk[] = [];
  for (let i = 0; i < pts.length; i += CHUNK) {
    const to = Math.min(i + CHUNK, pts.length);
    const slice = pts.slice(i, to + 1 <= pts.length ? to + 1 : to);
    if (to === pts.length) slice.push(pts[0]);
    chunks.push({ box: bboxOf(slice), from: i, to });
  }
  c = { pts, chunks };
  chunkedCache.set(l, c);
  return c;
}

/** Lower bound on the distance between two loops from their chunk bounding boxes. */
export function chunkLowerBound(a: Loop, b: Loop): number {
  const A = chunkedOf(a), B = chunkedOf(b);
  let best = Infinity;
  for (const ca of A.chunks) for (const cb of B.chunks) {
    const d = bboxDistance(ca.box, cb.box);
    if (d < best) { best = d; if (best === 0) return 0; }
  }
  return best;
}

/** Exact minimum distance between two closed polylines, pruned with per-chunk bounding boxes. */
export function chunkedLoopDistance(a: Loop, b: Loop): number {
  const A = chunkedOf(a), B = chunkedOf(b);
  // cheap upper bound: a few vertices of A against all edges of B
  let best = Infinity;
  const samples = Math.min(6, A.pts.length);
  for (let k = 0; k < samples; k++) {
    const p0 = A.pts[Math.floor((k * A.pts.length) / samples)];
    for (let y = 0; y < B.pts.length; y++) {
      const d = pointSegmentDist(p0, B.pts[y], B.pts[(y + 1) % B.pts.length]);
      if (d < best) best = d;
    }
  }
  for (let i = 0; i < A.chunks.length; i++) {
    const ca = A.chunks[i];
    for (let j = 0; j < B.chunks.length; j++) {
      const cb = B.chunks[j];
      if (bboxDistance(ca.box, cb.box) >= best) continue;
      for (let x = ca.from; x < ca.to; x++) {
        const p1 = A.pts[x], p2 = A.pts[(x + 1) % A.pts.length];
        for (let y = cb.from; y < cb.to; y++) {
          const dd = segmentSegmentDistance(p1, p2, B.pts[y], B.pts[(y + 1) % B.pts.length]);
          if (dd < best) { best = dd; if (best === 0) return 0; }
        }
      }
    }
  }
  return best;
}

export class GapCache {
  private cache = new Map<number, number>();
  /** Distances at or above this value need no exact computation (the model treats them alike). */
  private farEnough: number;
  constructor(farEnough: number) { this.farEnough = farEnough; }

  /** Conservative XY distance between two walls. */
  gap(a: Loop, b: Loop): number {
    const lower = bboxDistance(a.bbox, b.bbox);
    if (lower >= this.farEnough) return lower;
    const key = a.id < b.id ? a.id * 1e6 + b.id : b.id * 1e6 + a.id;
    let d = this.cache.get(key);
    if (d === undefined) {
      d = Math.max(0, chunkedLoopDistance(a, b) - MARGIN);
      this.cache.set(key, d);
    }
    return d;
  }

  /** Is the XY distance between two walls at least t? Decided with cheap bounds when possible. */
  atLeast(a: Loop, b: Loop, t: number): boolean {
    if (t <= 0) return true;
    if (bboxDistance(a.bbox, b.bbox) >= t) return true;
    const key = a.id < b.id ? a.id * 1e6 + b.id : b.id * 1e6 + a.id;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached >= t;
    if (chunkLowerBound(a, b) - MARGIN >= t) return true;
    return this.gap(a, b) >= t;
  }
}

/** Conservative XY distance between a travel segment and a wall. */
export function travelGap(a: Vec2, b: Vec2, loop: Loop, farEnough: number): number {
  const lower = segmentBBoxDistance(a, b, loop.bbox);
  if (lower >= farEnough) return lower;
  return Math.max(0, segmentLoopDistance(a, b, coarseOf(loop)) - MARGIN);
}
