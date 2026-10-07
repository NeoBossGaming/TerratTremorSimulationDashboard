# TerraTremor · early-warning demo dashboard

`index.html` is the whole dashboard: one self-contained file (vanilla JS + Three.js r128)
for a live demo on a 16:9 projector. Open it in Chrome or Edge and press **F**.

## How it works on screen

The page opens on a map of Indonesia.

* **Click anywhere on the map**: an earthquake starts there (live toy model) and you watch the
  node network detect it in real time. Magnitude and depth for the next click are set in the
  bottom bar.
* **Click a pin**: it plays that prepared scenario (the six events in `EVENTS`). The camera
  flies in and the scenario starts on its own.
* One earthquake at a time: while one is running, map and pin clicks are ignored. Wait until it
  finishes, or press **R** to go back to the map.

While an earthquake runs, the five-step bar appears at the top and a small card on the right
shows the nodes triggered, the estimated size, the alert time and the warning time per city.

| Key | Action |
| --- | --- |
| Space | play / pause (with nothing running: plays the current scenario) |
| → or PageDown | next step (works with presentation clickers) |
| ← or PageUp | previous step |
| 1 to 5 | jump to a step |
| ↑ / ↓ | play the previous / next scenario |
| R | reset to the map |
| F | fullscreen |
| M | sound on / off (starts muted) |
| + / − | speed 0.25× to 4× (or the speed button) |
| O | Indonesia overview |
| T | light / dark theme |

Mouse: drag to orbit, right-drag (or Shift+drag) to pan, wheel to zoom towards the cursor.
The "Auto camera" chip returns to the choreographed camera.

## Theme

The default is a light "atlas" look. `THEME` at the top of the script sets the start theme
(`'light'` or `'dark'`); **T** switches at any time.

## Live playground (toy model)

The national node field (one dot per ~5 km cell of the hypothetical 200 m network, about
78,000 dots, drawn entirely on the GPU) lights up amber where nodes trigger, blue where the
ALERT arrives, and red where the S wave arrives first (no warning). The ALERT floods only over
connected land, because the radio mesh cannot cross open sea. A detailed 0.5 km patch around
the epicentre runs the same five checks as the scenarios.

The playground uses the same toy physics as `tools/make_placeholder_events.mjs`. It is a
teaching toy, not the real simulation, and it is labelled LIVE TOY MODEL on screen.

## Map

Zoom out (or press **O**) to see all of Indonesia. A latitude / longitude grid adapts to
the zoom level (5° on the overview, down to 0.01° on the sensor patch), its values are
labelled along the top and left edges, and the bottom-right corner shows the coordinates
under the cursor. Neighbouring countries are drawn too, at lower detail, so the coasts
continue past the edge of the detailed map.

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
its two `<script>` tags in `<head>`. The comment at the top of `index.html` has the exact steps. Without
the fonts, the page falls back to system fonts.

The map is drawn from embedded geometry: Natural Earth 1:10m coastlines and neighbouring
countries (public domain, via the `world-atlas` npm package) and Indonesia's 38 provinces
(`indonesia-geodata` npm package, MIT). `tools/make_geo_data.py` rebuilds that block.

Set `MAP_IMAGE` (top of the script) to an equirectangular image covering `MAP_BOUNDS`
(94°E to 142°E, 11.5°S to 6.5°N). Use a `data:` URI when opening the file from disk;
otherwise the stylised procedural map is drawn.
