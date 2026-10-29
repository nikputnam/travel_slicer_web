/**
 * Decide the print order: which run to extend next and by how many layers, so that
 * (a) every loop is printed after its supports, and
 * (b) no already-printed material ever sits where the extruder will be.
 *
 * The collision model is a stepped radius function of the height difference between printed
 * material and the nozzle tip: within nozzleRadius material may be at most one layer higher,
 * within shroudRadius at most nozzleHeight higher, beyond that at most gantryHeight higher.
 */
import { bboxDistance, closestPointOnLoop } from './geom.ts';
import { GapCache } from './gaps.ts';
import type { ClearanceModel, Layer, Run, Segment, Vec2 } from './types.ts';

/** Max height (mm) that printed material at XY distance d from the nozzle may rise above the tip. */
export function allowedRise(d: number, c: ClearanceModel, layerHeight: number): number {
  if (d <= c.nozzleRadius) return layerHeight * 1.001;
  if (d <= c.shroudRadius) return c.nozzleHeight;
  return c.gantryHeight;
}

/** Minimum XY distance that printed material rising `rise` above the nozzle tip must keep from it. */
export function requiredGap(rise: number, c: ClearanceModel, layerHeight: number): number {
  if (rise <= layerHeight * 1.001) return 0;
  if (rise <= c.nozzleHeight) return c.nozzleRadius + 1e-9;
  if (rise <= c.gantryHeight) return c.shroudRadius + 1e-9;
  return Infinity;
}

interface RunState {
  run: Run;
  next: number; // index into run.loops of the next unprinted loop
}

/**
 * Largest n such that run c can print loops [c.next, c.next+n) without blocking any other
 * unfinished run q from later printing its own remaining loops.
 */
function maxExtension(c: RunState, states: RunState[], layers: Layer[], clearance: ClearanceModel, gaps: GapCache): number {
  const run = c.run;
  let n = 0;
  outer: for (let idx = c.next; idx < run.loops.length; idx++) {
    const top = run.loops[idx];
    const zTop = layers[top.layer].z;
    for (const q of states) {
      if (q.run === run || q.next >= q.run.loops.length) continue;
      if (bboxDistance(run.bbox, q.run.bbox) > clearance.shroudRadius && clearance.gantryHeight === Infinity) continue;
      // q will later print loops at global layers i < top.layer while `top` is already there.
      const qFirst = q.run.startLayer + q.next;
      const qLast = Math.min(top.layer - 1, q.run.startLayer + q.run.loops.length - 1);
      for (let i = qLast; i >= qFirst; i--) {
        const ql = q.run.loops[i - q.run.startLayer];
        // the nozzle sits at the bottom of layer i when it starts ramping that loop
        const rise = zTop - (layers[i].z - layers[i].height);
        const need = requiredGap(rise, clearance, layers[i].height);
        if (need === Infinity || !gaps.atLeast(top, ql, need)) break outer;
      }
    }
    n++;
  }
  return n;
}

export function schedule(runs: Run[], layers: Layer[], clearance: ClearanceModel, startPos: Vec2): Segment[] {
  const states: RunState[] = runs.map((run) => ({ run, next: 0 }));
  const byRun = new Map<Run, RunState>(states.map((s) => [s.run, s]));
  const segments: Segment[] = [];
  const gaps = new GapCache(clearance.shroudRadius);
  let pos = startPos;
  let current: RunState | null = null;
  let remaining = runs.reduce((a, r) => a + r.loops.length, 0);

  while (remaining > 0) {
    let best: { s: RunState; n: number; cost: number } | null = null;
    const consider = (s: RunState, cost: number) => {
      const n = maxExtension(s, states, layers, clearance, gaps);
      if (n <= 0) return;
      if (!best || cost < best.cost || (cost === best.cost && n > best.n)) best = { s, n, cost };
    };
    if (current && current.next < current.run.loops.length) consider(current, -1);
    if (!best) {
      for (const s of states) {
        if (s.next >= s.run.loops.length) continue;
        if (s.next === 0 && !s.run.parents.every((p) => byRun.get(p)!.next >= p.loops.length)) continue;
        const target = s.run.loops[s.next];
        const near = closestPointOnLoop(pos, target.pts);
        consider(s, Math.sqrt(near.d2));
      }
    }
    if (!best) throw new Error('Scheduler deadlock: no run can be extended. This should not happen.');
    const { s, n } = best as { s: RunState; n: number; cost: number };
    segments.push({ run: s.run, from: s.next, to: s.next + n, starts: [] });
    s.next += n;
    remaining -= n;
    current = s;
    const last = s.run.loops[s.next - 1];
    pos = last.pts[0];
  }
  return segments;
}
