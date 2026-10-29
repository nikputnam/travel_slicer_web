import { parsePrusaGcode, validateConfig, numOrPercent, type ParsedGcode } from './prusaParser.ts';
import { buildRuns } from './topology.ts';
import { schedule } from './scheduler.ts';
import { generateToolpath, type PreviewPath } from './toolpath.ts';
import type { PlanSettings, PlanStats, Run, Segment } from './types.ts';

export interface PlanResult {
  gcode: string;
  preview: PreviewPath[];
  stats: PlanStats;
  runs: Run[];
  segments: Segment[];
  parsed: ParsedGcode;
  configProblems: string[];
  configAdvice: string[];
}

export const DEFAULT_SETTINGS: PlanSettings = {
  clearance: { nozzleRadius: 2.5, nozzleHeight: 4, shroudRadius: 30, gantryHeight: Infinity },
  bottomLayers: 3,
  travelLift: 1,
  retractMinTravel: 2,
};

export function planFromParsed(parsed: ParsedGcode, settings: PlanSettings, fanOverride?: number): PlanResult {
  const warnings = [...parsed.warnings];
  const { errors: configProblems, advice: configAdvice } = validateConfig(parsed.config);
  const bottom = Math.max(0, Math.min(settings.bottomLayers, parsed.layers.length));
  if (bottom >= parsed.layers.length) warnings.push('All layers are passthrough layers; nothing to spiralise.');

  const runs = buildRuns(parsed.layers, bottom);
  const start = bottom > 0 ? parsed.layerEndState[bottom - 1] : { x: 0, y: 0, z: 0, e: 0, retracted: 0, feed: 0, relativeE: parsed.config.use_relative_e_distances === '1', firmwareRetracted: false };
  const segments = runs.length ? schedule(runs, parsed.layers, settings.clearance, { x: start.x, y: start.y }) : [];

  let fanPwm: number | undefined;
  if (fanOverride !== undefined) fanPwm = fanOverride * 2.55;
  else {
    const cooling = parsed.config.cooling === undefined || parsed.config.cooling.split(',')[0] === '1';
    const maxFan = numOrPercent(parsed.config.max_fan_speed, NaN, 100);
    const minFan = numOrPercent(parsed.config.min_fan_speed, NaN, 35);
    const alwaysOn = parsed.config.fan_always_on?.split(',')[0] === '1';
    fanPwm = cooling ? maxFan * 2.55 : alwaysOn ? minFan * 2.55 : 0;
  }

  const tp = generateToolpath(segments, parsed.layers, { config: parsed.config, settings, start, fanPwm });

  const out: string[] = [...parsed.header];
  const preview: PreviewPath[] = [];
  for (let i = 0; i < bottom; i++) out.push(...parsed.layers[i].raw);
  out.push(...tp.lines);
  out.push(...parsed.footer);

  let dropped = 0;
  for (let i = bottom; i < parsed.layers.length; i++) dropped += parsed.layers[i].droppedPaths;
  if (dropped > 0) warnings.push(`${dropped} non-wall extrusion path(s) (infill, brim, gap fill...) above the bottom layers were dropped.`);

  const stats: PlanStats = {
    segments: segments.length,
    runs: runs.length,
    travels: tp.travels,
    travelDistance: tp.travelDistance,
    extrusionDistance: tp.extrusionDistance,
    droppedPaths: dropped,
    warnings,
  };
  return { gcode: out.join('\n'), preview: preview.concat(tp.preview), stats, runs, segments, parsed, configProblems, configAdvice };
}

export function plan(gcodeText: string, settings: PlanSettings = DEFAULT_SETTINGS, fanOverride?: number): PlanResult {
  return planFromParsed(parsePrusaGcode(gcodeText), settings, fanOverride);
}
