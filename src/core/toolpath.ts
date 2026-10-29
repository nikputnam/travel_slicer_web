/**
 * Turn scheduled segments into Z-ramped spiral toolpaths with safe travels between them,
 * and emit G-code that slots between the source file's passthrough layers and its footer.
 */
import { dist, perimeter, rotateLoopToStartNear } from './geom.ts';
import { travelGap } from './gaps.ts';
import { numOrPercent, type MachineState, type PrusaConfig } from './prusaParser.ts';
import { allowedRise } from './scheduler.ts';
import type { Layer, Loop, PlanSettings, Run, Segment, Vec2 } from './types.ts';

export interface PreviewPath {
  kind: 'extrude' | 'travel' | 'passthrough';
  /** Flat xyz triples. */
  xyz: number[];
  runId: number;
  segment: number;
}

export interface ToolpathResult {
  lines: string[];
  preview: PreviewPath[];
  travels: number;
  travelDistance: number;
  extrusionDistance: number;
}

interface PrintedLoop {
  loop: Loop;
  top: number;
}

const f3 = (v: number) => {
  const s = v.toFixed(3);
  return s.replace(/\.?0+$/, '') || '0';
};
const f5 = (v: number) => v.toFixed(5).replace(/\.?0+$/, '') || '0';

export interface FlowParams {
  filamentDiameter: number;
  extrusionMultiplier: number;
}

/** Filament mm per path mm for a rounded-rectangle bead (PrusaSlicer's flow model). */
export function ePerMm(width: number, height: number, flow: FlowParams): number {
  const area = height * (width - height * (1 - Math.PI / 4));
  const filament = Math.PI * (flow.filamentDiameter / 2) ** 2;
  return (area / filament) * flow.extrusionMultiplier;
}

export interface WriterOptions {
  config: PrusaConfig;
  settings: PlanSettings;
  /** Machine state when our section starts (end of the last passthrough layer). */
  start: MachineState;
  /** Fan PWM 0..255 to set at the start of the section, or undefined to leave as is. */
  fanPwm?: number;
}

export function generateToolpath(segments: Segment[], layers: Layer[], opts: WriterOptions): ToolpathResult {
  const { config, settings } = opts;
  const clearance = settings.clearance;
  const lines: string[] = [];
  const preview: PreviewPath[] = [];
  const num = (k: string, fb: number) => numOrPercent(config[k], NaN, fb);

  const flow: FlowParams = {
    filamentDiameter: num('filament_diameter', 1.75),
    extrusionMultiplier: num('extrusion_multiplier', 1),
  };
  const travelSpeed = num('travel_speed', 130) * 60;
  const travelSpeedZ = (num('travel_speed_z', 0) || num('travel_speed', 130)) * 60;
  const retractLength = num('retract_length', 0.8);
  const retractSpeed = num('retract_speed', 35) * 60;
  const deretractSpeed = (num('deretract_speed', 0) || num('retract_speed', 35)) * 60;
  const firmwareRetract = config.use_firmware_retraction === '1';
  const perimeterSpeed = num('perimeter_speed', 45);
  const externalSpeed = numOrPercent(config.external_perimeter_speed, perimeterSpeed, perimeterSpeed * 0.5);
  const defaultFeed = (settings.printSpeed ?? externalSpeed) * 60;

  const st = { ...opts.start };
  const relE = st.relativeE;
  let eAbs = 0;
  let curFeed = -1;
  let retracted = st.retracted;
  let travels = 0, travelDistance = 0, extrusionDistance = 0;
  const printed: PrintedLoop[] = [];
  const seamOf = new Map<Run, Vec2>();
  let maxLayerReached = -1;

  const emit = (l: string) => lines.push(l);
  const setFeed = (f: number) => { if (f !== curFeed) { curFeed = f; return ` F${f3(f)}`; } return ''; };
  const eWord = (de: number) => {
    if (relE) return ` E${f5(de)}`;
    eAbs += de;
    return ` E${f5(eAbs)}`;
  };

  emit('; ---- TRAvel web: spiralised section begins ----');
  emit(`; clearance nozzleRadius=${clearance.nozzleRadius} nozzleHeight=${clearance.nozzleHeight} shroudRadius=${clearance.shroudRadius} gantryHeight=${Number.isFinite(clearance.gantryHeight) ? clearance.gantryHeight : 'none'}`);
  if (!relE) { emit('G92 E0'); eAbs = 0; }
  if (opts.fanPwm !== undefined) emit(`M106 S${Math.round(opts.fanPwm)}`);

  const doRetract = () => {
    if (retracted > 0 || st.firmwareRetracted) return;
    if (firmwareRetract) { emit('G10'); st.firmwareRetracted = true; return; }
    if (retractLength <= 0) return;
    emit(`G1${eWord(-retractLength)}${setFeed(retractSpeed)}`);
    retracted = retractLength;
  };
  const doUnretract = () => {
    if (firmwareRetract && st.firmwareRetracted) { emit('G11'); st.firmwareRetracted = false; return; }
    if (retracted <= 0) return;
    emit(`G1${eWord(retracted)}${setFeed(deretractSpeed)}`);
    retracted = 0;
  };

  const travelTo = (to: Vec2, zTo: number, segIdx: number, runId: number) => {
    const from = { x: st.x, y: st.y };
    const dxy = dist(from, to);
    if (dxy < 1e-3 && Math.abs(zTo - st.z) < 1e-6) return;
    // obstacle-aware travel height; short hops with nothing in the way stay at the current height
    let zTravel = Math.max(st.z, zTo) + (dxy >= settings.retractMinTravel ? settings.travelLift : 0);
    for (const m of printed) {
      const d = travelGap(from, to, m.loop, clearance.shroudRadius);
      const rise = allowedRise(d, clearance, 0);
      const need = m.top - rise + settings.travelLift;
      if (need > zTravel) zTravel = need;
    }
    const retract = dxy >= settings.retractMinTravel;
    if (retract) doRetract();
    const path: number[] = [st.x, st.y, st.z];
    if (zTravel > st.z + 1e-6) { emit(`G1 Z${f3(zTravel)}${setFeed(travelSpeedZ)}`); st.z = zTravel; path.push(st.x, st.y, st.z); }
    emit(`G1 X${f3(to.x)} Y${f3(to.y)}${setFeed(travelSpeed)}`);
    st.x = to.x; st.y = to.y; path.push(st.x, st.y, st.z);
    if (Math.abs(zTo - st.z) > 1e-6) { emit(`G1 Z${f3(zTo)}${setFeed(travelSpeedZ)}`); st.z = zTo; path.push(st.x, st.y, st.z); }
    if (retract) doUnretract();
    travels++;
    travelDistance += dxy;
    preview.push({ kind: 'travel', xyz: path, runId, segment: segIdx });
  };

  segments.forEach((seg, segIdx) => {
    const run = seg.run;
    emit(`; segment ${segIdx}: run ${run.id}, loops ${seg.from}..${seg.to - 1} (layers ${run.loops[seg.from].layer}..${run.loops[seg.to - 1].layer})`);
    if (!relE) { emit('G92 E0'); eAbs = 0; }
    for (let li = seg.from; li < seg.to; li++) {
      const loop = run.loops[li];
      const layer = layers[loop.layer];
      const z1 = layer.z;
      const z0 = z1 - layer.height;
      // seam target: continue the run's seam, inherit a parent's, or start nearest to the nozzle
      let target: Vec2 | undefined = seamOf.get(run);
      if (!target && li === 0) target = run.parents.map((p) => seamOf.get(p)).find((s) => s !== undefined);
      if (!target) target = { x: st.x, y: st.y };
      const pts = rotateLoopToStartNear(loop.pts, target);
      const start = pts[0];
      seamOf.set(run, start);

      if (li === seg.from) {
        travelTo(start, z0, segIdx, run.id);
        doUnretract();
      }
      // within a segment the next loop's seam is adjacent to the current position: no travel

      if (loop.layer > maxLayerReached) {
        maxLayerReached = loop.layer;
        emit(';LAYER_CHANGE');
        emit(`;Z:${f3(z1)}`);
        emit(`;HEIGHT:${f3(layer.height)}`);
      }
      if (li === seg.from) { emit(';TYPE:External perimeter'); emit(`;WIDTH:${f3(loop.width)}`); }

      const total = perimeter(pts, true);
      const e = ePerMm(loop.width, layer.height, flow);
      const feed = settings.printSpeed !== undefined ? settings.printSpeed * 60 : (loop.feed || defaultFeed);
      const xyz: number[] = [start.x, start.y, z0];
      let s = 0;
      let prev = start;
      for (let i = 1; i <= pts.length; i++) {
        const p = pts[i % pts.length];
        const d = dist(prev, p);
        if (d < 1e-6) continue;
        s += d;
        const z = z0 + (z1 - z0) * (s / total);
        emit(`G1 X${f3(p.x)} Y${f3(p.y)} Z${f3(z)}${eWord(d * e)}${setFeed(feed)}`);
        xyz.push(p.x, p.y, z);
        prev = p;
      }
      st.x = start.x; st.y = start.y; st.z = z1;
      extrusionDistance += total;
      printed.push({ loop, top: z1 });
      preview.push({ kind: 'extrude', xyz, runId: run.id, segment: segIdx });
    }
  });
  emit('; ---- TRAvel web: spiralised section ends ----');
  return { lines, preview, travels, travelDistance, extrusionDistance };
}
