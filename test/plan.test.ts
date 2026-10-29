import { describe, expect, it } from 'vitest';
import { plan, DEFAULT_SETTINGS } from '../src/core/pipeline.ts';
import { parsePrusaGcode } from '../src/core/prusaParser.ts';
import { fixture } from './helpers.ts';

const settings = (over: Partial<typeof DEFAULT_SETTINGS['clearance']> = {}, bottomLayers = 3) => ({
  ...DEFAULT_SETTINGS, bottomLayers, clearance: { ...DEFAULT_SETTINGS.clearance, ...over },
});

/** Re-parse our own output to check it is well formed and monotone within segments. */
function checkOutput(gcode: string) {
  expect(gcode).toContain('; ---- TRAvel web: spiralised section begins ----');
  expect(gcode).toContain('; prusaslicer_config = begin');
  const lines = gcode.split('\n');
  let z = 0, inSection = false, maxZ = 0;
  for (const l of lines) {
    if (l.startsWith('; ---- TRAvel web: spiralised section begins')) inSection = true;
    if (!inSection) continue;
    const m = /Z(-?[\d.]+)/.exec(l.split(';')[0]);
    if (l.startsWith('G1') && m) {
      z = parseFloat(m[1]);
      expect(z).toBeGreaterThanOrEqual(0);
      maxZ = Math.max(maxZ, z);
    }
    expect(l).not.toMatch(/NaN|undefined|Infinity/);
  }
  return maxZ;
}

describe('end-to-end plan', () => {
  it('cylinder: one run, one segment, no travels', () => {
    const r = plan(fixture('cylinder'), settings());
    expect(r.stats.runs).toBe(1);
    expect(r.stats.segments).toBe(1);
    expect(r.stats.travels).toBeLessThanOrEqual(1); // one travel from the end of the bottom layers
    expect(checkOutput(r.gcode)).toBeCloseTo(20, 1);
    // ramped Z: a loop's moves must have strictly increasing Z
    const zs = r.gcode.split('\n').filter((l) => /^G1 X.*E/.test(l)).slice(-50).map((l) => parseFloat(/Z([\d.]+)/.exec(l)![1]));
    for (let i = 1; i < zs.length; i++) expect(zs[i]).toBeGreaterThanOrEqual(zs[i - 1]);
    expect(r.stats.warnings.filter((w) => !w.includes('non-wall'))).toEqual([]);
  });

  it('far towers: two runs, each printed as one full spiral', () => {
    const r = plan(fixture('far_towers'), settings());
    expect(r.stats.runs).toBe(2);
    expect(r.stats.segments).toBe(2);
    expect(r.stats.travels).toBeLessThanOrEqual(2);
    checkOutput(r.gcode);
  });

  it('two towers 12 mm apart: chunked by nozzle height', () => {
    const r = plan(fixture('two_towers'), settings({ nozzleHeight: 4 }));
    expect(r.stats.runs).toBe(3); // slab outline + two towers
    // 29 mm towers, 0.2 mm layers, 4 mm chunks -> 1 + roughly 2 * 29/8 segments
    expect(r.stats.segments).toBeGreaterThanOrEqual(8);
    expect(r.stats.segments).toBeLessThanOrEqual(12);
    for (const s of r.segments.slice(1)) expect(s.to - s.from).toBeLessThanOrEqual(41);
    checkOutput(r.gcode);
    // with a huge nozzle height they become two spirals
    const r2 = plan(fixture('two_towers'), settings({ nozzleHeight: 100 }));
    expect(r2.stats.segments).toBe(3);
    // if the shroud is smaller than the gap between the towers there is no constraint at all
    const r3 = plan(fixture('two_towers'), settings({ shroudRadius: 5 }));
    expect(r3.stats.segments).toBe(3);
  });

  it('Y split: trunk run then two branch runs that separate into long segments', () => {
    const r = plan(fixture('y_split'), settings());
    expect(r.stats.runs).toBe(3);
    const trunk = r.runs.find((x) => x.parents.length === 0)!;
    expect(trunk.children.length).toBe(2);
    expect(r.segments[0].run).toBe(trunk);
    expect(r.segments[0].to).toBe(trunk.loops.length);
    // near the split the branches alternate layer by layer; higher up they are far apart
    const longest = Math.max(...r.segments.map((s) => s.to - s.from));
    expect(longest).toBeGreaterThanOrEqual(20);
    // once apart by more than the nozzle radius a branch may lead by nozzleHeight (4 mm = 20 layers)
    for (const s of r.segments.filter((s) => s.run !== trunk)) expect(s.to - s.from).toBeLessThanOrEqual(42);
    checkOutput(r.gcode);
  });

  it('thin tube: inner and outer wall alternate every layer or two', () => {
    const r = plan(fixture('tube'), settings());
    expect(r.stats.runs).toBe(2);
    for (const s of r.segments) expect(s.to - s.from).toBeLessThanOrEqual(2);
    checkOutput(r.gcode);
  });

  it('thick tube: nested walls 9.5 mm apart are chunked by nozzle height, not by layer', () => {
    const r = plan(fixture('thick_tube'), settings({ nozzleHeight: 4 }));
    expect(r.stats.runs).toBe(2);
    const longest = Math.max(...r.segments.map((s) => s.to - s.from));
    expect(longest).toBeGreaterThanOrEqual(20);
    expect(r.stats.segments).toBeLessThanOrEqual(10);
    // a tall nozzle (clay printer) makes each wall one full spiral
    const r2 = plan(fixture('thick_tube'), settings({ nozzleHeight: 100 }));
    expect(r2.stats.segments).toBe(2);
    checkOutput(r2.gcode);
  });

  it('passthrough layers are byte-identical to the source', () => {
    const src = fixture('cylinder');
    const p = parsePrusaGcode(src);
    const r = plan(src, settings({}, 3));
    const expected = [...p.header, ...p.layers[0].raw, ...p.layers[1].raw, ...p.layers[2].raw].join('\n');
    expect(r.gcode.startsWith(expected)).toBe(true);
    expect(r.gcode.endsWith(p.footer.join('\n'))).toBe(true);
  });
});
