#!/bin/zsh
# Slice the fixture STLs with PrusaSlicer's CLI using a vase-style profile:
# one perimeter, no infill, no top layers, 3 bottom layers, spiral vase OFF.
set -e
PS="/Applications/Original Prusa Drivers/PrusaSlicer.app/Contents/MacOS/PrusaSlicer"
OUT="$(dirname "$0")/../test/fixtures/gcode"
mkdir -p "$OUT"
for stl in "$(dirname "$0")"/../test/fixtures/stl/*.stl; do
  name=$(basename "$stl" .stl)
  "$PS" --export-gcode --output "$OUT/$name.gcode" \
    --layer-height 0.2 --first-layer-height 0.2 --nozzle-diameter 0.4 \
    --perimeters 1 --fill-density 0 --top-solid-layers 0 --bottom-solid-layers 3 \
    --skirts 1 --brim-width 0 \
    --retract-length 1 --retract-lift 0.2 --use-relative-e-distances \
    --filament-diameter 1.75 --temperature 210 --first-layer-temperature 210 \
    --bed-temperature 60 --first-layer-bed-temperature 60 \
    --center 110,110 "$stl" > /dev/null
  echo "sliced $name -> $(wc -l < "$OUT/$name.gcode") lines"
done
