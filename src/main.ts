import { DEFAULT_SETTINGS, planFromParsed, type PlanResult } from './core/pipeline.ts';
import { parsePrusaGcode, type ParsedGcode } from './core/prusaParser.ts';
import type { PlanSettings } from './core/types.ts';
import { RUN_COLORS, Viewer } from './ui/viewer.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const num = (id: string): number | undefined => {
  const v = $<HTMLInputElement>(id).value.trim();
  return v === '' ? undefined : parseFloat(v);
};

const viewer = new Viewer($('view'));
let parsed: ParsedGcode | null = null;
let fileName = 'out.gcode';
let result: PlanResult | null = null;

function readSettings(): PlanSettings {
  return {
    clearance: {
      nozzleRadius: num('nozzleRadius') ?? DEFAULT_SETTINGS.clearance.nozzleRadius,
      nozzleHeight: num('nozzleHeight') ?? DEFAULT_SETTINGS.clearance.nozzleHeight,
      shroudRadius: num('shroudRadius') ?? DEFAULT_SETTINGS.clearance.shroudRadius,
      gantryHeight: num('gantryHeight') ?? Infinity,
    },
    bottomLayers: num('bottomLayers') ?? DEFAULT_SETTINGS.bottomLayers,
    travelLift: num('travelLift') ?? DEFAULT_SETTINGS.travelLift,
    printSpeed: num('printSpeed'),
    retractMinTravel: DEFAULT_SETTINGS.retractMinTravel,
  };
}

function message(cls: string, text: string) {
  const d = document.createElement('div');
  d.className = cls;
  d.textContent = text;
  $('messages').appendChild(d);
}

async function loadFile(file: File) {
  $('messages').innerHTML = '';
  $('stats').innerHTML = '';
  result = null;
  $<HTMLButtonElement>('download').disabled = true;
  fileName = file.name.replace(/\.(gcode|gco|g)$/i, '') + '_travel.gcode';
  try {
    const text = await file.text();
    parsed = parsePrusaGcode(text);
    $('dropText').textContent = `${file.name}: ${parsed.layers.length} layers, ${parsed.layers.reduce((a, l) => a + l.loops.length, 0)} wall loops`;
    for (const w of parsed.warnings) message('warn', w);
    $<HTMLButtonElement>('process').disabled = false;
    process();
  } catch (e) {
    parsed = null;
    $<HTMLButtonElement>('process').disabled = true;
    message('err', (e as Error).message);
  }
}

function process() {
  if (!parsed) return;
  $('messages').innerHTML = '';
  const settings = readSettings();
  const t0 = performance.now();
  try {
    result = planFromParsed(parsed, settings, num('fan'));
  } catch (e) {
    message('err', (e as Error).message);
    return;
  }
  const ms = performance.now() - t0;
  for (const p of result.configProblems) message('err', 'Slicer setting: ' + p);
  for (const a of result.configAdvice) message('advice', a);
  for (const w of result.stats.warnings) message('warn', w);
  const s = result.stats;
  const rows: [string, string][] = [
    ['Layers (spiralised / total)', `${parsed.layers.length - settings.bottomLayers} / ${parsed.layers.length}`],
    ['Runs (spiralisable branches)', String(s.runs)],
    ['Segments (continuous spirals)', String(s.segments)],
    ['Travels', String(s.travels)],
    ['Travel distance', `${s.travelDistance.toFixed(0)} mm`],
    ['Extrusion distance', `${(s.extrusionDistance / 1000).toFixed(2)} m`],
    ['Planning time', `${ms.toFixed(0)} ms`],
  ];
  $('stats').innerHTML = '<table>' + rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('') + '</table>' +
    '<div class="legend">' + result.runs.slice(0, 24).map((r) => `<span style="--c:${RUN_COLORS[r.id % RUN_COLORS.length]}">run ${r.id} (${r.loops.length} layers)</span>`).join('') + (result.runs.length > 24 ? '<span>…</span>' : '') + '</div>';

  viewer.setPaths(result.preview, parsed.layers.slice(0, settings.bottomLayers));
  const range = $<HTMLInputElement>('segRange');
  range.max = String(viewer.segmentCount);
  range.value = range.max;
  $('segLabel').textContent = 'all';
  viewer.showUpTo(viewer.segmentCount);
  $('viewCtl').hidden = false;
  $<HTMLButtonElement>('download').disabled = result.configProblems.length > 0 && !confirm('The slicer settings look wrong for spiral printing (see messages). Enable download anyway?');
}

$('file').addEventListener('change', (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) loadFile(f);
});
const drop = $('drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault(); drop.classList.remove('over');
  const f = e.dataTransfer?.files?.[0];
  if (f) loadFile(f);
});
$('process').addEventListener('click', process);
$('download').addEventListener('click', () => {
  if (!result) return;
  const blob = new Blob([result.gcode], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('segRange').addEventListener('input', (e) => {
  const n = parseInt((e.target as HTMLInputElement).value, 10);
  $('segLabel').textContent = n >= viewer.segmentCount ? 'all' : String(n);
  viewer.showUpTo(n);
});
$('showTravel').addEventListener('change', (e) => viewer.setTravelVisible((e.target as HTMLInputElement).checked));
$('showBottom').addEventListener('change', (e) => viewer.setBottomVisible((e.target as HTMLInputElement).checked));
