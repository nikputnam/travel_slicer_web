import { describe, expect, it } from 'vitest';
import { loopDistance, bboxOf } from '../src/core/geom.ts';
import { coarseOf } from '../src/core/gaps.ts';
import { chunkedLoopDistance } from '../src/core/gaps.ts';
import type { Loop } from '../src/core/types.ts';

const circle = (cx: number, cy: number, r: number, n: number, id: number): Loop => {
  const pts = Array.from({ length: n }, (_, i) => ({ x: cx + r * Math.cos((2 * Math.PI * i) / n), y: cy + r * Math.sin((2 * Math.PI * i) / n) }));
  return { id, layer: 0, pts, bbox: bboxOf(pts), area: Math.PI * r * r, depth: 0, width: 0.45 };
};

describe('loop distances', () => {
  it('chunked distance matches the brute-force distance', () => {
    const cases: [Loop, Loop][] = [
      [circle(0, 0, 30, 200, 1), circle(0, 0, 20, 150, 2)],   // nested
      [circle(0, 0, 10, 100, 3), circle(25, 0, 10, 100, 4)],  // side by side
      [circle(0, 0, 10, 100, 5), circle(15, 0, 10, 100, 6)],  // overlapping -> 0
      [circle(0, 0, 5, 40, 7), circle(0, 0, 5, 40, 8)],       // coincident -> 0
    ];
    for (const [a, b] of cases) {
      expect(chunkedLoopDistance(a, b)).toBeCloseTo(loopDistance(coarseOf(a), coarseOf(b)), 6);
    }
    expect(chunkedLoopDistance(cases[0][0], cases[0][1])).toBeCloseTo(10, 1);
    expect(chunkedLoopDistance(cases[1][0], cases[1][1])).toBeCloseTo(5, 1);
  });
});
