/**
 * Build the support graph between loops of consecutive layers and group it into runs:
 * maximal chains of one loop per layer with no branching, printable as a single spiral.
 */
import { bboxUnion, polygonsOverlap, simplify } from './geom.ts';
import type { Layer, Loop, Run } from './types.ts';

interface Node {
  loop: Loop;
  parents: Node[];
  children: Node[];
  run?: Run;
}

/**
 * @param layers all layers of the job
 * @param firstLayer index of the first layer to spiral (layers below are passed through)
 */
export function buildRuns(layers: Layer[], firstLayer: number): Run[] {
  const nodes = new Map<Loop, Node>();
  const coarse = new Map<Loop, ReturnType<typeof simplify>>();
  const nodeOf = (l: Loop) => {
    let n = nodes.get(l);
    if (!n) { n = { loop: l, parents: [], children: [] }; nodes.set(l, n); }
    return n;
  };
  const coarseOf = (l: Loop) => {
    let c = coarse.get(l);
    if (!c) { c = simplify(l.pts, 0.8); coarse.set(l, c); }
    return c;
  };

  for (let k = firstLayer; k < layers.length; k++) {
    for (const loop of layers[k].loops) {
      const n = nodeOf(loop);
      if (k === firstLayer) continue;
      for (const below of layers[k - 1].loops) {
        if ((below.depth & 1) !== (loop.depth & 1)) continue;
        if (polygonsOverlap(coarseOf(loop), loop.bbox, coarseOf(below), below.bbox)) {
          const p = nodeOf(below);
          n.parents.push(p);
          p.children.push(n);
        }
      }
    }
  }

  const runs: Run[] = [];
  const startsRun = (n: Node) => n.parents.length !== 1 || n.parents[0].children.length !== 1;
  for (let k = firstLayer; k < layers.length; k++) {
    for (const loop of layers[k].loops) {
      const n = nodeOf(loop);
      if (!startsRun(n)) continue;
      const run: Run = { id: runs.length, loops: [], startLayer: k, parents: [], children: [], bbox: loop.bbox };
      let cur: Node | undefined = n;
      while (cur) {
        cur.run = run;
        run.loops.push(cur.loop);
        run.bbox = bboxUnion(run.bbox, cur.loop.bbox);
        const next: Node | undefined = cur.children.length === 1 && cur.children[0].parents.length === 1 ? cur.children[0] : undefined;
        cur = next;
      }
      runs.push(run);
    }
  }
  for (const run of runs) {
    const first = nodeOf(run.loops[0]);
    for (const p of first.parents) {
      const pr = p.run!;
      if (!run.parents.includes(pr)) run.parents.push(pr);
      if (!pr.children.includes(run)) pr.children.push(run);
    }
  }
  return runs;
}
