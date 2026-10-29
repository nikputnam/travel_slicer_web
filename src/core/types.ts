/** Shared data model. Everything downstream of the input adapters works on these. */

export interface Vec2 {
  x: number;
  y: number;
}

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** A closed extrusion loop (single wall) on one layer. Points are CCW, last point != first. */
export interface Loop {
  /** Unique id within the job. */
  id: number;
  layer: number;
  pts: Vec2[];
  bbox: BBox;
  /** Absolute area (mm^2) of the enclosed polygon. */
  area: number;
  /** Nesting depth within its layer: 0 = outermost, 1 = hole, 2 = island inside a hole... */
  depth: number;
  /** Extrusion width used by the source slicer for this loop (mm). */
  width: number;
  /** Feed rate the source slicer used for this loop (mm/min), if known. */
  feed?: number;
  /** Measured filament per mm of path from the source, if known (for sanity checks). */
  ePerMm?: number;
}

export interface Layer {
  index: number;
  /** Z of the top of this layer (mm). */
  z: number;
  /** Layer thickness (mm). */
  height: number;
  loops: Loop[];
  /** Raw G-code lines for this layer in the source file (for passthrough). */
  raw: string[];
  /** Number of non-wall extrusion paths that were present in the source (infill, brim...). */
  droppedPaths: number;
}

/** A maximal chain of loops, one per consecutive layer, that can be printed as one spiral. */
export interface Run {
  id: number;
  loops: Loop[];
  /** Global layer index of loops[0]. */
  startLayer: number;
  /** Runs whose last loop supports loops[0]. */
  parents: Run[];
  children: Run[];
  bbox: BBox;
}

/** Hot-end collision model. Distances in mm. */
export interface ClearanceModel {
  /** Radius around the nozzle tip within which printed material may be at most one layer higher. */
  nozzleRadius: number;
  /** Height from the nozzle tip to the heater block / silicone sock / fan shroud. */
  nozzleHeight: number;
  /** Radius of the heater block, sock and part-cooling shroud around the nozzle axis. */
  shroudRadius: number;
  /** Height from the nozzle tip to the X gantry (Infinity for bed slingers with nothing above). */
  gantryHeight: number;
}

export interface PlanSettings {
  clearance: ClearanceModel;
  /** Number of source layers to pass through unchanged at the bottom. */
  bottomLayers: number;
  /** Z-hop above the obstacle height during travel (mm). */
  travelLift: number;
  /** Override the extrusion feed rate (mm/s). undefined = use the source slicer's value. */
  printSpeed?: number;
  /** Minimum travel distance (mm) that triggers a retraction. */
  retractMinTravel: number;
}

/** One continuous spiral extrusion: a consecutive slice of a run's loops, Z-ramped. */
export interface Segment {
  run: Run;
  /** Index range into run.loops, inclusive start, exclusive end. */
  from: number;
  to: number;
  /** Per-loop start index chosen for the seam (index into the loop's points after insertion). */
  starts: number[];
}

export interface PlanStats {
  segments: number;
  runs: number;
  travels: number;
  travelDistance: number;
  extrusionDistance: number;
  droppedPaths: number;
  warnings: string[];
}
