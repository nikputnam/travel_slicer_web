/**
 * Reader for PrusaSlicer (and derivatives: SuperSlicer, OrcaSlicer, Bambu Studio) G-code.
 * Extracts per-layer wall loops plus everything needed to re-emit a faithful file.
 */
import { bboxOf, dist, pointInPolygon, signedArea, bboxOverlap } from './geom.ts';
import type { Layer, Vec2 } from './types.ts';

export type PrusaConfig = Record<string, string>;

export interface MachineState {
  x: number;
  y: number;
  z: number;
  /** Logical E position (absolute mode value; in relative mode a running sum). */
  e: number;
  /** Filament currently retracted (mm), 0 when primed. */
  retracted: number;
  feed: number;
  relativeE: boolean;
  firmwareRetracted: boolean;
}

export interface ParsedGcode {
  header: string[];
  layers: Layer[];
  footer: string[];
  config: PrusaConfig;
  /** Machine state at the end of each layer's raw lines. */
  layerEndState: MachineState[];
  warnings: string[];
  /** Number of wall paths that did not close into a loop. */
  openWalls: number;
}

const WALL_TYPES = new Set(['External perimeter', 'Perimeter', 'Overhang perimeter', 'Inner wall', 'Outer wall', 'Overhang wall']);

interface Path {
  pts: Vec2[];
  type: string;
  width: number;
  feed: number;
  e: number;
  length: number;
}

function parseWords(line: string): Map<string, number> {
  const words = new Map<string, number>();
  const re = /([A-Za-z])(-?\d*\.?\d+(?:[eE][-+]?\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) words.set(m[1].toUpperCase(), parseFloat(m[2]));
  return words;
}

export function parseConfig(lines: string[]): PrusaConfig {
  const cfg: PrusaConfig = {};
  let inBlock = false;
  for (const line of lines) {
    if (/^;\s*(prusaslicer|superslicer|orcaslicer|bambu)?_?config\s*=\s*begin/i.test(line) || /^; CONFIG_BLOCK_START/.test(line)) { inBlock = true; continue; }
    if (/^;\s*\w*_?config\s*=\s*end/i.test(line) || /^; CONFIG_BLOCK_END/.test(line)) { inBlock = false; continue; }
    if (!inBlock) continue;
    const m = /^;\s*([\w.]+)\s*=\s*(.*)$/.exec(line);
    if (m) cfg[m[1]] = m[2].trim();
  }
  return cfg;
}

/** Parse a config value that may be a plain number or a percentage of `base`. */
export function numOrPercent(v: string | undefined, base: number, fallback: number): number {
  if (v === undefined || v === '') return fallback;
  const t = v.split(',')[0].trim();
  if (t.endsWith('%')) return (parseFloat(t) / 100) * base;
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : fallback;
}

export function parsePrusaGcode(text: string): ParsedGcode {
  const lines = text.split(/\r?\n/);
  const warnings: string[] = [];
  const config = parseConfig(lines);

  // --- find block boundaries -------------------------------------------------
  const firstLayer = lines.findIndex((l) => l.startsWith(';LAYER_CHANGE'));
  if (firstLayer < 0) throw new Error('No ;LAYER_CHANGE markers found. Is this PrusaSlicer-style G-code?');

  let footerStart = -1;
  for (let i = lines.length - 1; i > firstLayer; i--) {
    if (lines[i].startsWith(';TYPE:Custom')) { footerStart = i; break; }
  }
  if (footerStart < 0) {
    footerStart = lines.findIndex((l, i) => i > firstLayer && /^; filament used \[mm\]/.test(l));
    if (footerStart < 0) footerStart = lines.length;
    warnings.push('End G-code block not found; the printer end G-code may be missing from the output.');
  } else {
    // PrusaSlicer turns the fan off right before the end G-code; keep that with the footer.
    let j = footerStart - 1;
    while (j > firstLayer && lines[j].trim() === '') j--;
    if (/^M107\b/.test(lines[j])) footerStart = j;
  }

  const header = lines.slice(0, firstLayer);
  const footer = lines.slice(footerStart);

  // header-declared widths, used when ;WIDTH: is absent
  let defaultWidth = 0.45;
  for (const l of header) {
    const m = /^; external perimeters extrusion width = ([\d.]+)mm/.exec(l);
    if (m) defaultWidth = parseFloat(m[1]);
  }

  // --- walk the body ---------------------------------------------------------
  const st: MachineState = {
    x: 0, y: 0, z: 0, e: 0, retracted: 0, feed: 0,
    relativeE: config.use_relative_e_distances === '1',
    firmwareRetracted: false,
  };
  // Replay the header for modal state (M82/M83, G90/G91, G92).
  for (const l of header) applyModal(l, st, warnings);

  const layers: Layer[] = [];
  const layerEndState: MachineState[] = [];
  let cur: Layer | null = null;
  let curType = '';
  let curWidth = defaultWidth;
  let path: Path | null = null;
  let loopId = 0;
  let openWalls = 0;
  const closeTolFor = (w: number) => Math.max(1.0, 2.5 * w);

  const finishPath = () => {
    if (!path || !cur) { path = null; return; }
    const p = path;
    path = null;
    if (!WALL_TYPES.has(p.type)) { cur.droppedPaths++; return; }
    const pts = p.pts;
    if (pts.length < 3) { openWalls++; return; }
    const gap = dist(pts[0], pts[pts.length - 1]);
    if (gap > closeTolFor(p.width)) { openWalls++; return; }
    if (gap < 0.02) pts.pop();
    // dedupe consecutive points
    const clean: Vec2[] = [pts[0]];
    for (let i = 1; i < pts.length; i++) if (dist(clean[clean.length - 1], pts[i]) > 1e-4) clean.push(pts[i]);
    if (clean.length >= 3 && dist(clean[0], clean[clean.length - 1]) <= 1e-4) clean.pop();
    if (clean.length < 3) { openWalls++; return; }
    const area = signedArea(clean);
    if (area < 0) clean.reverse();
    cur.loops.push({
      id: loopId++, layer: cur.index, pts: clean, bbox: bboxOf(clean), area: Math.abs(area),
      depth: 0, width: p.width, feed: p.feed, ePerMm: p.length > 0 ? p.e / p.length : undefined,
    });
  };

  for (let i = firstLayer; i < footerStart; i++) {
    const line = lines[i];
    if (line.startsWith(';LAYER_CHANGE')) {
      finishPath();
      if (cur) { layerEndState.push({ ...st }); }
      cur = { index: layers.length, z: NaN, height: NaN, loops: [], raw: [], droppedPaths: 0 };
      layers.push(cur);
      cur.raw.push(line);
      continue;
    }
    if (!cur) continue;
    cur.raw.push(line);
    if (line.startsWith(';')) {
      if (line.startsWith(';Z:')) cur.z = parseFloat(line.slice(3));
      else if (line.startsWith(';HEIGHT:')) cur.height = parseFloat(line.slice(8));
      else if (line.startsWith(';TYPE:')) {
        const t = line.slice(6).trim();
        if (WALL_TYPES.has(t) !== WALL_TYPES.has(curType)) finishPath();
        curType = t;
      } else if (line.startsWith(';WIDTH:')) curWidth = parseFloat(line.slice(7)) || curWidth;
      continue;
    }
    const code = line.split(';')[0].trim();
    if (code === '') continue;
    const cmd = /^([GM]\d+)/.exec(code)?.[1];
    if (!cmd) continue;
    if (cmd === 'G1' || cmd === 'G0') {
      const w = parseWords(code);
      const hasXY = w.has('X') || w.has('Y');
      const nx = w.get('X') ?? st.x, ny = w.get('Y') ?? st.y, nz = w.get('Z') ?? st.z;
      if (w.has('F')) st.feed = w.get('F')!;
      let de = 0;
      if (w.has('E')) {
        const ev = w.get('E')!;
        de = st.relativeE ? ev : ev - st.e;
        st.e = st.relativeE ? st.e + ev : ev;
      }
      if (de < 0) st.retracted += -de;
      else if (de > 0 && !hasXY) st.retracted = Math.max(0, st.retracted - de);
      else if (de > 0 && st.retracted > 0) st.retracted = 0;

      if (hasXY && de > 0 && nz === st.z) {
        if (!path) path = { pts: [{ x: st.x, y: st.y }], type: curType, width: curWidth, feed: st.feed, e: 0, length: 0 };
        const prev = path.pts[path.pts.length - 1];
        const p = { x: nx, y: ny };
        path.pts.push(p);
        path.e += de;
        path.length += dist(prev, p);
      } else {
        finishPath();
      }
      st.x = nx; st.y = ny; st.z = nz;
    } else if (cmd === 'G2' || cmd === 'G3') {
      throw new Error('Arc moves (G2/G3) found. Re-slice with Arc fitting disabled.');
    } else if (cmd === 'G10') { finishPath(); st.firmwareRetracted = true; }
    else if (cmd === 'G11') { st.firmwareRetracted = false; }
    else applyModal(code, st, warnings);
  }
  finishPath();
  if (cur) layerEndState.push({ ...st });

  // nesting depth per layer
  for (const layer of layers) {
    if (!Number.isFinite(layer.z)) warnings.push(`Layer ${layer.index} has no ;Z: marker.`);
    for (const a of layer.loops) {
      let depth = 0;
      for (const b of layer.loops) {
        if (a === b || !bboxOverlap(a.bbox, b.bbox) || b.area <= a.area) continue;
        if (pointInPolygon(a.pts[0], b.pts)) depth++;
      }
      a.depth = depth;
    }
  }
  // fill in missing heights from z deltas
  for (let i = 0; i < layers.length; i++) {
    if (!Number.isFinite(layers[i].height)) layers[i].height = i === 0 ? layers[i].z : layers[i].z - layers[i - 1].z;
  }
  if (openWalls > 0) warnings.push(`${openWalls} wall path(s) did not close into loops and were dropped.`);

  return { header, layers, footer, config, layerEndState, warnings, openWalls };
}

function applyModal(code: string, st: MachineState, warnings: string[]) {
  const c = code.split(';')[0].trim();
  if (c.startsWith('M83')) st.relativeE = true;
  else if (c.startsWith('M82')) st.relativeE = false;
  else if (c.startsWith('G91')) warnings.push('Relative XYZ positioning (G91) is not supported; results may be wrong.');
  else if (c.startsWith('G92')) {
    const w = parseWords(c);
    if (w.has('E')) st.e = w.get('E')!;
  }
}

/** Sanity-check the slicer settings for single-wall spiral printing. Errors break the result, advice only degrades it. */
export function validateConfig(cfg: PrusaConfig): { errors: string[]; advice: string[] } {
  const problems: string[] = [];
  const advice: string[] = [];
  const is = (k: string, v: string) => cfg[k] !== undefined && cfg[k].split(',')[0] === v;
  if (cfg.spiral_vase === '1') problems.push('Spiral vase is ON in the slicer; turn it off, this tool does the spiralling.');
  if (cfg.perimeters !== undefined && !is('perimeters', '1')) problems.push(`perimeters = ${cfg.perimeters}; use 1 perimeter.`);
  if (cfg.fill_density !== undefined && parseFloat(cfg.fill_density) !== 0) problems.push(`fill_density = ${cfg.fill_density}; use 0% infill.`);
  if (cfg.top_solid_layers !== undefined && !is('top_solid_layers', '0')) problems.push(`top_solid_layers = ${cfg.top_solid_layers}; use 0.`);
  if (cfg.arc_fitting !== undefined && cfg.arc_fitting !== 'disabled' && cfg.arc_fitting !== '0') problems.push('Arc fitting is enabled; disable it.');
  if (cfg.wipe !== undefined && !is('wipe', '0')) advice.push('Wipe on retract is enabled; disabling it gives cleaner loops.');
  if (cfg.gap_fill_enabled === '1') advice.push('Gap fill is enabled; gap fill paths are dropped, disable it to be sure nothing is lost.');
  if (cfg.thin_walls === '1') advice.push('Detect thin walls is enabled; open thin-wall paths cannot be spiralled and are dropped.');
  return { errors: problems, advice };
}
