# TRAvel web

A browser post-processor that turns single-wall PrusaSlicer G-code into branch-by-branch
spiral ("vase mode") toolpaths. It is a web reimplementation of the idea behind
[TRAvel Slicer](https://github.com/Hand-and-Machine/TRAvel_Slicer): decompose a part into
spiralisable branches, print each one continuously with the Z ramping along the loop, and
order the branches so the hot end never collides with what is already printed.

## Workflow

1. Slice in PrusaSlicer (OrcaSlicer / Bambu Studio output uses the same markers) with:
   - 1 perimeter, 0 % infill, 0 top solid layers, bottom solid layers as you like
   - **Spiral vase off** (this tool does the spiralling)
   - Arc fitting off, wipe off; gap fill and thin walls off are recommended
2. Open the app (hosted at https://nikputnam.github.io/travel_slicer_web/ or `npm run dev` locally), drop the `.gcode` file in, adjust the hot-end clearance
   numbers for your printer, and download the result.

The first *N* layers (bottom layers) are copied through untouched, so brim, skirt and solid
bottom are exactly what PrusaSlicer produced. Everything above is rebuilt from the wall loops.
Header, start/end G-code, temperatures and the config block are preserved.

## How it works (`src/core`)

| file | role |
| --- | --- |
| `prusaParser.ts` | reads layers, wall loops, config block and machine state from the source file |
| `topology.ts` | links loops to the loops that support them and groups them into *runs* (spiralisable chains) |
| `scheduler.ts` | picks which run to extend next and by how many layers, under the hot-end clearance model |
| `toolpath.ts` | Z-ramped loops with aligned seams, obstacle-aware travels, flow and G-code emission |
| `pipeline.ts` | glues it together; `plan(gcodeText, settings)` is the whole thing |

The clearance model is a stepped radius: within *nozzle radius* printed material may be at most
one layer above the tip, within *shroud radius* at most *nozzle height* above it, beyond that at
most *gantry height*. Runs that are far apart print as full spirals; runs that are close alternate
in chunks of nozzle height; walls that touch alternate every layer or two.

## Development

```
npm install
npm run dev        # app on http://localhost:5173
npm test           # vitest, uses the fixtures in test/fixtures/gcode
npm run fixtures   # regenerate fixture STLs and re-slice them with the local PrusaSlicer CLI
```
