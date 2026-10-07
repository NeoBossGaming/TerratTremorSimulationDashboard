# TerraTremor · early-warning demo dashboard

`index.html` is the whole dashboard: one self-contained file (vanilla JS + Three.js r128)
for a 75-second live demo on a 16:9 projector. Open it in Chrome or Edge and press **F**.

| Key | Action |
| --- | --- |
| Space | run / pause (the big RUN button does the same) |
| → or PageDown | next phase (works with presentation clickers) |
| ← or PageUp | previous phase |
| 1 to 5 | jump to a phase |
| ↑ / ↓ | previous / next event |
| R | reset the run and the camera |
| F | fullscreen |
| M | sound on / off (starts muted) |
| + / − | speed 0.25× to 4× |
| O | Indonesia overview (map with a latitude / longitude grid) |

Mouse: drag to orbit, right-drag (or Shift+drag) to pan, wheel to zoom towards the cursor.
**R** or the "Auto camera" chip returns to the choreographed camera.

## Playground (live toy model)

Choose the last card, **Playground**, pick a magnitude and depth, then click anywhere on the
map. An earthquake starts there and runs in real time: the national node field (one dot per
~5 km cell of the hypothetical 200 m network, about 78,000 dots, drawn entirely on the GPU)
lights up amber where nodes trigger, cyan where the ALERT arrives, and red where the S wave
arrives first (no warning). The ALERT floods only over connected land, because the radio mesh
cannot cross open sea. A detailed 0.5 km patch around the epicentre runs the same five checks as
the scenarios. Only one earthquake at a time: the map is locked until it finishes (or press **R**).

The playground uses the same toy physics as `tools/make_placeholder_events.mjs`. It is a
teaching toy, not the real simulation, and it is labelled LIVE TOY MODEL on screen.

## Map

Map mode: zoom out (or press **O**) to see all of Indonesia. A latitude / longitude grid
adapts to the zoom level (5° on the overview, down to 0.01° on the sensor patch), its
values are labelled along the top and left edges of the map, the bottom-right corner shows
the coordinates under the cursor, and every scenario appears as a pin you can click.

## Data

Every number on screen is read from the `EVENTS` array at the bottom of `index.html`.
To use the real export, replace everything between `/*<EVENTS-DATA>*/` and
`/*</EVENTS-DATA>*/` with `const EVENTS = [ ... ];` in the same shape. No code changes are
needed. The **PLACEHOLDER DATA** badge appears only while some event has `"placeholder": true`.

Coordinate convention the dashboard assumes: x = east, y = north, measured from the true
epicentre (or disturbance source). `patch`, `best_x_m/best_y_m` and `alert.estimate` are in
metres; `flood.relayer_sample` and `cities` are in km; `reach_km` is the farthest distance
from the epicentre that the ALERT has reached at `t_s`.

The current placeholder data comes from `tools/make_placeholder_events.mjs`, a small,
seeded toy version of the five-phase pipeline (so the numbers are consistent with each
other). It is not the real simulation. Running `node tools/make_placeholder_events.mjs`
regenerates the block in `index.html`.

## Offline use

The page loads Three.js from cdnjs (with jsDelivr as a fallback) and two Google Fonts.
For a venue without internet, paste the content of
`https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js` into the page in place of
its `<script src>` tag. The comment at the top of `index.html` has the exact steps. Without
the fonts, the page falls back to system fonts.

The map is drawn from embedded geometry: Natural Earth 1:10m coastlines and neighbouring
countries (public domain, via the `world-atlas` npm package) and Indonesia's 38 provinces
(`indonesia-geodata` npm package, MIT). `tools/make_geo_data.py` rebuilds that block.

Set `MAP_IMAGE` (top of the script) to an equirectangular image covering `MAP_BOUNDS`
(94°E to 142°E, 11.5°S to 6.5°N). Use a `data:` URI when opening the file from disk;
otherwise the stylised procedural map is drawn.
