#!/usr/bin/env node
/*
 * make_placeholder_events.mjs
 *
 * Builds the PLACEHOLDER dataset that is embedded in index.html.
 *
 * It runs a deliberately simple, seeded toy version of the TerraTremor pipeline so that
 * every placeholder number is internally consistent (trigger times, fits, magnitude curve,
 * O/E, alert flood, city warnings). It is NOT the real simulation: the amplitude model,
 * noise levels and radii below are rough stand-ins. Replace the data with the real export.
 *
 * Coordinate convention written into the data (the dashboard relies on it):
 *   x = east, y = north, measured from the TRUE epicentre / disturbance source
 *   (patch, best_x_m/best_y_m and alert.estimate in metres; flood and cities in km).
 *   reach_km = farthest distance from the epicentre that the ALERT has reached.
 *
 * Usage:  node tools/make_placeholder_events.mjs [path/to/index.html]
 *         Rewrites the block between the EVENTS-DATA markers in that file.
 *         SCAN=A node tools/make_placeholder_events.mjs   lists the outcome of preset A
 *         for seeds 1-40 (used to pick seeds that tell each preset's story).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------- toy model parameters ----------
const VP = 6.0, VS = 3.5;            // km/s
const ALERT_KMS = 48;                // effective speed of the radio flood, km/s
const SPACING_M = 200, GRID_N = 32;  // 32 x 32 grid, a few nodes randomly missing
const TRIGGER_RATIO = 4;             // trigger when signal > 4x background
const NOISE_FLOOR_G = 0.004;         // typical background of an ADXL345 in a building
const HOLD_RADIUS_KM = 2.5;          // a node hears triggers from nodes this close
const COLLECT_S = 0.6;               // once 5 triggers are held, gather a little longer
const MIN_TRIGGERS = 5, FIT_TOL_S = 0.3, FIT_RATIO = 0.7;
const M_GATE = 4.5, OE_GATE = 0.5;
const NB_RADIUS_KM = 0.45;           // neighbourhood used by the O/E check
const RELAY_ALL_KM = 3, RELAYERS_PER_NB = 8, GOSSIP_NB_KM = 1.0;
const WEDGE_DEG = 60, R_MAX_KM = 110;
const CITY_DISTS = [10, 20, 40, 60, 80, 100];
const CITY_BEARING_OFFSETS = [-7, 5, -3, 8, -5, 2];
const RELAYER_SAMPLE = 600;

// toy amplitude model: peak ground acceleration in g at hypocentral distance R (km)
const logAS = (M, R) => -1.9 + 0.5 * M - 1.3 * Math.log10(R + 5);
const logAP = (M, R) => logAS(M, R) - Math.log10(4);

// ---------- the six presets ----------
const SPECS = [
  {
    id: 'PLACEHOLDER-A', label: 'Large shallow earthquake', kind: 'earthquake', expect: 'detected',
    description: 'Strong, shallow quake: the network triggers within a second and the alert outruns the shaking.',
    lat: -7.05, lon: 107.55, depth: 10, M: 6.6, bearing: 85, patchDist: 6, seed: 18, spurious: 2,
  },
  {
    id: 'PLACEHOLDER-B', label: 'Moderate earthquake', kind: 'earthquake', expect: 'detected',
    description: 'The network is 18 km away, so the P wave reaches it later: later alert, shorter warnings.',
    lat: -1.25, lon: 120.15, depth: 8, M: 5.4, bearing: 170, patchDist: 18, seed: 21, spurious: 1,
  },
  {
    id: 'PLACEHOLDER-C', label: 'Small earthquake', kind: 'earthquake', expect: 'missed',
    description: 'Size is underestimated, just below the M 4.5 gate, so no alert is sent. An honest miss.',
    lat: -0.65, lon: 100.55, depth: 12, M: 4.7, bearing: 135, patchDist: 4, seed: 27, spurious: 1,
  },
  {
    id: 'PLACEHOLDER-D', label: 'Footsteps', kind: 'noise', expect: 'rejected-2',
    description: 'Someone walks past one node: a single trigger, never enough for the timing check.',
    lat: -7.80, lon: 110.30, footprint: 30, A0: 0.09, tOn: 0.4, sourceNear: 12, bearing: 90, seed: 5,
  },
  {
    id: 'PLACEHOLDER-E', label: 'Machine / grinder', kind: 'noise', expect: 'rejected-4',
    description: 'A grinder shakes a few nodes hard. It looks big, but most neighbours stay quiet.',
    lat: -7.32, lon: 112.62, footprint: 400, A0: 0.30, tOn: 0.3, sourceNear: 0, bearing: 90, seed: 2,
  },
  {
    id: 'PLACEHOLDER-F', label: '500 m-wide shaking', kind: 'noise', expect: 'false-alarm',
    description: 'Heavy shaking over a 500 m area (e.g. construction): locally it looks just like an earthquake.',
    lat: -8.62, lon: 116.25, footprint: 500, A0: 0.35, tOn: 0.3, sourceNear: 0, bearing: 95, seed: 21,
  },
];

// ---------- helpers ----------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussian(r) {
  return () => {
    let u = 0, v = 0;
    while (u === 0) u = r();
    while (v === 0) v = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}
function erf(x) { // Abramowitz-Stegun 7.1.26
  const s = Math.sign(x); x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
const Phi = (x) => 0.5 * (1 + erf(x / Math.SQRT2));
const median = (a) => { const s = [...a].sort((p, q) => p - q); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r3 = (v) => Math.round(v * 1000) / 1000;
const r2 = (v) => Math.round(v * 100) / 100;
const r1 = (v) => Math.round(v * 10) / 10;
const rad = (d) => d * Math.PI / 180;

// ---------- one event ----------
function simulate(spec) {
  const rnd = mulberry32(spec.seed * 7919 + 13);
  const gau = gaussian(rnd);
  const quake = spec.kind === 'earthquake';

  // network patch, centred away from the epicentre for quakes, around the source for noise
  let pcx, pcy;
  if (quake) { pcx = spec.patchDist * Math.sin(rad(spec.bearing)); pcy = spec.patchDist * Math.cos(rad(spec.bearing)); }
  else { pcx = 0.35; pcy = -0.25; }
  const nodes = [];
  let id = 1;
  for (let j = 0; j < GRID_N; j++) {
    for (let i = 0; i < GRID_N; i++) {
      const skip = rnd() < 0.03;
      const jx = (rnd() - 0.5) * 50, jy = (rnd() - 0.5) * 50;
      const noise = NOISE_FLOOR_G * Math.exp(0.25 * gau());
      const site = Math.pow(10, 0.12 * gau());
      if (skip) continue;
      const x = Math.round(pcx * 1000 + (i - (GRID_N - 1) / 2) * SPACING_M + jx);
      const y = Math.round(pcy * 1000 + (j - (GRID_N - 1) / 2) * SPACING_M + jy);
      nodes.push({ id: id++, i: nodes.length, x: x / 1000, y: y / 1000, noise, site });
    }
  }
  // noise sources sit right next to a node (footsteps) or between nodes
  let sx = 0, sy = 0;
  if (!quake && spec.sourceNear > 0) {
    const n0 = nodes.reduce((b, n) => (Math.hypot(n.x, n.y) < Math.hypot(b.x, b.y) ? n : b));
    sx = n0.x - spec.sourceNear / 1000; sy = n0.y;
  }
  // re-centre the frame on the source so that (0,0) is the disturbance origin
  if (!quake) for (const n of nodes) { n.x = Math.round((n.x - sx) * 1000) / 1000; n.y = Math.round((n.y - sy) * 1000) / 1000; }

  // ---- triggers (first trigger per node) ----
  let trig = [];
  for (const n of nodes) {
    const thr = TRIGGER_RATIO * n.noise;
    const scatter = Math.pow(10, 0.06 * gau());
    const pick = 0.04 + 0.06 * rnd() + 0.012 * gau();
    if (quake) {
      const R = Math.hypot(n.x, n.y, spec.depth);
      const aP = Math.pow(10, logAP(spec.M, R)) * n.site * scatter;
      const aS = Math.pow(10, logAS(spec.M, R)) * n.site * scatter;
      if (aP >= thr) trig.push({ n, t: R / VP + pick, wave: 'P', amp: aP });
      else if (aS >= thr) trig.push({ n, t: R / VS + pick, wave: 'S', amp: aS });
    } else {
      const d = Math.hypot(n.x, n.y) * 1000;
      // strong inside the footprint (0.04 g at its edge), decaying quickly outside it
      const a = spec.A0 * Math.pow(0.04 / spec.A0, d / (spec.footprint / 2)) * n.site * scatter;
      if (a >= thr) trig.push({ n, t: spec.tOn + d / 1500 + 0.03 * rnd(), wave: 'noise', amp: a });
    }
  }
  // a few nodes pick the P wave late (emergent onset / poor clock sync): these become mismatches
  if (quake && spec.spurious) {
    const early = [...trig].sort((a, b) => a.t - b.t).slice(5, 60);
    for (let k = 0; k < spec.spurious; k++) {
      const victim = early[Math.floor(rnd() * early.length)];
      victim.t += 0.38 + 0.12 * rnd();
    }
  }
  trig.sort((a, b) => a.t - b.t);

  const phases = [];
  let alert = null;
  let decider = null, best = null, mHat = null, t0 = 0, failed = false;

  // ---- phase 1: single-node trigger ----
  if (!trig.length) {
    phases.push({ phase: 1, t_s: 1.0, passed: false, metrics: { n_triggers: 0 } });
    failed = true;
  } else {
    const t1 = trig[0].t;
    phases.push({ phase: 1, t_s: r3(t1), passed: true, metrics: { n_triggers: trig.filter((t) => t.t <= t1 + 1e-9).length } });
  }

  // ---- phase 2: timing check ----
  let heldSet = [];
  if (!failed) {
    // every trigger is radioed to nodes within HOLD_RADIUS_KM (10 ms + distance / radio speed)
    const near = nodes.map((a) => nodes.filter((b) => Math.hypot(a.x - b.x, a.y - b.y) <= HOLD_RADIUS_KM));
    const shareDelay = (a, b) => 0.01 + Math.hypot(a.x - b.x, a.y - b.y) / ALERT_KMS;
    const arrivals = [];
    for (const tr of trig) for (const b of near[tr.n.i]) arrivals.push([tr.t + shareDelay(tr.n, b), b.i]);
    arrivals.sort((a, b) => a[0] - b[0]);
    const held = new Array(nodes.length).fill(0);
    let T5 = null;
    for (const [t, j] of arrivals) {
      if (++held[j] >= MIN_TRIGGERS) { T5 = t; decider = nodes[j]; break; }
    }
    if (T5 === null) {
      const maxHeld = Math.max(...held);
      phases.push({
        phase: 2, t_s: r3(trig[trig.length - 1].t + 1.5), passed: false,
        reason: `only ${maxHeld} trigger${maxHeld === 1 ? '' : 's'} held (needs ${MIN_TRIGGERS})`,
        metrics: { candidates_tested: 0, best_x_m: null, best_y_m: null, best_depth_km: null, fit_nodes: [], mismatch_nodes: [], n_fit: 0, n_triggers: maxHeld, fit_ratio: 0 },
      });
      failed = true;
    } else {
      const tCheck = T5 + COLLECT_S;
      heldSet = trig.filter((tr) => Math.hypot(tr.n.x - decider.x, tr.n.y - decider.y) <= HOLD_RADIUS_KM && tr.t + shareDelay(tr.n, decider) <= tCheck);
      const cx = Math.round(decider.x), cy = Math.round(decider.y);
      let tested = 0;
      for (let ix = -20; ix <= 20; ix++) {
        for (let iy = -20; iy <= 20; iy++) {
          for (let dz = 1; dz <= 39; dz += 2) {
            tested++;
            const ex = cx + ix, ey = cy + iy;
            const res = heldSet.map((o) => o.t - Math.hypot(o.n.x - ex, o.n.y - ey, dz) / VP);
            const tz = median(res);
            let nfit = 0, ss = 0;
            for (const v of res) { const e = v - tz; if (Math.abs(e) <= FIT_TOL_S) { nfit++; ss += e * e; } }
            const rms = Math.sqrt(ss / Math.max(1, nfit));
            if (!best || nfit > best.nfit || (nfit === best.nfit && rms < best.rms)) best = { ex, ey, dz, t0: tz, nfit, rms };
          }
        }
      }
      t0 = best.t0;
      const fit = [], mis = [];
      for (const o of heldSet) {
        const e = o.t - Math.hypot(o.n.x - best.ex, o.n.y - best.ey, best.dz) / VP - t0;
        (Math.abs(e) <= FIT_TOL_S ? fit : mis).push(o);
      }
      const ratio = fit.length / heldSet.length;
      const passed = fit.length >= MIN_TRIGGERS && ratio >= FIT_RATIO;
      phases.push({
        phase: 2, t_s: r3(tCheck + 0.04), passed,
        reason: `${fit.length} of ${heldSet.length} triggers fit (${Math.round(ratio * 100)}%)`,
        metrics: {
          candidates_tested: tested, best_x_m: Math.round(best.ex * 1000), best_y_m: Math.round(best.ey * 1000), best_depth_km: best.dz,
          fit_nodes: fit.map((o) => o.n.id), mismatch_nodes: mis.map((o) => o.n.id),
          n_fit: fit.length, n_triggers: heldSet.length, fit_ratio: r3(ratio),
        },
      });
      best.fit = fit;
      if (!passed) failed = true;
    }
  }

  // ---- phase 3: magnitude check ----
  if (!failed) {
    const obs = best.fit.map((o) => ({ la: Math.log10(o.amp), R: Math.hypot(o.n.x - best.ex, o.n.y - best.ey, best.dz) }));
    const curve = [];
    let bestErr = Infinity;
    for (let k = 0; k <= 60; k++) {
      const M = r1(3 + k * 0.1);
      const err = Math.sqrt(obs.reduce((s, o) => s + (o.la - logAP(M, o.R)) ** 2, 0) / obs.length);
      curve.push([M, r3(err)]);
      if (err < bestErr) { bestErr = err; mHat = M; }
    }
    const passed = mHat >= M_GATE;
    phases.push({
      phase: 3, t_s: r3(phases[1].t_s + 0.03), passed,
      reason: `M ${mHat.toFixed(1)} ${passed ? '≥' : '<'} ${M_GATE}`,
      metrics: { m_hat: mHat, gate: M_GATE, curve },
    });
    if (!passed) failed = true;
  }

  // ---- phase 4: neighbour check (O vs E) ----
  if (!failed) {
    const T4 = r3(phases[2].t_s + 0.03);
    const nb = nodes.filter((n) => Math.hypot(n.x - decider.x, n.y - decider.y) <= NB_RADIUS_KM);
    const trigBy = new Map();
    for (const tr of trig) if (tr.t + 0.01 + Math.hypot(tr.n.x - decider.x, tr.n.y - decider.y) / ALERT_KMS <= T4 && !trigBy.has(tr.n.id)) trigBy.set(tr.n.id, tr);
    let E = 0, O = 0;
    const silent = [];
    for (const n of nb) {
      const R = Math.hypot(n.x - best.ex, n.y - best.ey, best.dz);
      const arrives = t0 + R / VP + 0.07 <= T4;
      const p = arrives ? Phi((logAP(mHat, R) - Math.log10(TRIGGER_RATIO * n.noise)) / 0.25) : 0;
      E += p;
      if (trigBy.has(n.id)) O++;
      else if (p >= 0.1) silent.push({ node: n.id, p: r2(p) });
    }
    silent.sort((a, b) => b.p - a.p);
    const ratio = E > 0 ? O / E : 0;
    const passed = ratio >= OE_GATE;
    phases.push({
      phase: 4, t_s: T4, passed,
      reason: `O/E = ${O} / ${E.toFixed(1)} = ${ratio.toFixed(2)} (${passed ? '≥' : '<'} ${OE_GATE})`,
      metrics: { expected_E: r2(E), observed_O: O, ratio: r2(ratio), silent_expected: silent },
    });
    if (!passed) failed = true;
  }

  // ---- phase 5: alert propagation (flood over a wedge of the hypothetical network) ----
  const flood = { wedge_deg: WEDGE_DEG, r_max_km: R_MAX_KM, reach_curve: [], relayer_sample: [] };
  const B = rad(spec.bearing), half = rad(WEDGE_DEG / 2);
  if (!failed) {
    const tA = r3(phases[3].t_s + 0.02);
    const L = decider;
    const step = SPACING_M / 1000;
    const pRelay = RELAYERS_PER_NB / (Math.PI * GOSSIP_NB_KM ** 2 / step ** 2);
    const recv = [];
    let relayCount = 0, seen = 0;
    const sample = [];
    for (let x = -R_MAX_KM; x <= R_MAX_KM; x += step) {
      for (let y = -R_MAX_KM; y <= R_MAX_KM; y += step) {
        const r0 = Math.hypot(x, y);
        if (r0 > R_MAX_KM) continue;
        let dAng = Math.abs(Math.atan2(x, y) - B);
        if (dAng > Math.PI) dAng = 2 * Math.PI - dAng;
        if (dAng > half) continue;
        const dL = Math.hypot(x - L.x, y - L.y);
        const t = tA + dL / ALERT_KMS + 0.03 * rnd();
        recv.push([t, r0]);
        if (dL <= RELAY_ALL_KM || rnd() < pRelay) {
          relayCount++; seen++;
          const item = { x_km: r2(x), y_km: r2(y), t_s: r3(t) };
          if (sample.length < RELAYER_SAMPLE) sample.push(item);
          else { const k = Math.floor(rnd() * seen); if (k < RELAYER_SAMPLE) sample[k] = item; }
        }
      }
    }
    recv.sort((a, b) => a[0] - b[0]);
    const tLast = recv[recv.length - 1][0];
    let reach = Math.hypot(L.x, L.y), k = 0;
    for (let t = tA; t <= tLast + 0.05; t += 0.05) {
      while (k < recv.length && recv[k][0] <= t) { reach = Math.max(reach, recv[k][1]); k++; }
      flood.reach_curve.push([r3(t), r2(reach)]);
    }
    sample.sort((a, b) => a.t_s - b.t_s);
    flood.relayer_sample = sample;
    phases.push({ phase: 5, t_s: tA, passed: true, metrics: { leader_node: L.id, relayers_count: relayCount } });
    alert = {
      t_s: tA, leader_node: L.id,
      estimate: { x_m: Math.round(best.ex * 1000), y_m: Math.round(best.ey * 1000), depth_km: best.dz, magnitude: mHat },
    };
  }

  // ---- virtual cities along the wedge ----
  const cities = CITY_DISTS.map((d, k) => {
    const b = spec.bearing + CITY_BEARING_OFFSETS[k];
    const cxk = d * Math.sin(rad(b)), cyk = d * Math.cos(rad(b));
    const tS = quake ? r3(Math.hypot(d, spec.depth) / VS) : null;
    let tAl = null, warn = null;
    if (alert) {
      tAl = r3(alert.t_s + Math.hypot(cxk - decider.x, cyk - decider.y) / ALERT_KMS + 0.03 * rnd());
      if (tS !== null) warn = r2(tS - tAl);
    }
    return { dist_km: d, bearing_deg: b, t_s_wave: tS, t_alert: tAl, warning_s: warn };
  });

  const source = quake
    ? { lat: spec.lat, lon: spec.lon, depth_km: spec.depth, magnitude_true: spec.M }
    : { lat: spec.lat, lon: spec.lon, depth_km: 0, footprint_m: spec.footprint };

  const ev = {
    id: spec.id, placeholder: true, label: spec.label, kind: spec.kind, description: spec.description,
    source, wave_speeds: { p_kms: VP, s_kms: VS },
    patch: nodes.map((n) => ({ id: n.id, x_m: Math.round(n.x * 1000), y_m: Math.round(n.y * 1000) })),
    triggers: trig.map((t) => ({ node: t.n.id, t_s: r3(t.t), wave: t.wave })),
    phases, alert, flood, cities,
  };

  // ---- make sure the toy pipeline produced the story this preset is meant to tell ----
  const lastPhase = phases[phases.length - 1];
  const outcome = alert ? (quake ? 'detected' : 'false-alarm') : (quake ? 'missed' : `rejected-${lastPhase.phase}`);
  return { ev, outcome };
}

// ---------- serialisation: one key per line, big arrays on a single line ----------
function serialise(ev) {
  const J = (v) => JSON.stringify(v);
  const lines = [];
  const keys = Object.keys(ev);
  for (const k of keys) {
    if (k === 'phases' || k === 'cities') lines.push(`  ${J(k)}: [\n${ev[k].map((p) => '    ' + J(p)).join(',\n')}\n  ]`);
    else lines.push(`  ${J(k)}: ${J(ev[k])}`);
  }
  return '{\n' + lines.join(',\n') + '\n}';
}

// ---------- main ----------
const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(process.argv[2] || path.join(here, '..', 'index.html'));
if (process.env.SCAN) {
  const spec = SPECS.find((s) => s.id.endsWith(process.env.SCAN));
  for (let seed = 1; seed <= 40; seed++) {
    const { ev, outcome } = simulate({ ...spec, seed });
    const p = ev.phases.map((x) => `${x.phase}${x.passed ? '+' : 'x'}${x.reason ? ` ${x.reason}` : ''}`).join(' | ');
    console.log(seed, outcome, ev.triggers.length, p);
  }
  process.exit(0);
}
const results = SPECS.map(simulate);
let ok = true;
for (const [k, { ev, outcome }] of results.entries()) {
  const spec = SPECS[k];
  const p = ev.phases;
  const summary = p.map((x) => `${x.phase}${x.passed ? '✓' : '✗'}@${x.t_s}${x.reason ? ` (${x.reason})` : ''}`).join('  ');
  const warn = ev.cities.map((c) => (c.warning_s === null ? '–' : c.warning_s)).join(', ');
  console.log(`${ev.id}  ${outcome.padEnd(11)} nodes=${ev.patch.length} triggers=${ev.triggers.length}\n   ${summary}\n   alert=${ev.alert ? ev.alert.t_s : '–'}  relayers=${p[4] ? p[4].metrics.relayers_count : '–'}  warnings=[${warn}]`);
  if (outcome !== spec.expect) { ok = false; console.error(`   !! expected ${spec.expect}`); }
}
if (!ok) { console.error('Some presets did not produce their intended outcome; adjust seeds/parameters.'); process.exit(1); }

const block = `/*<EVENTS-DATA>*/\nconst EVENTS = [\n${results.map((r) => serialise(r.ev)).join(',\n')}\n];\n/*</EVENTS-DATA>*/`;
if (fs.existsSync(target)) {
  const html = fs.readFileSync(target, 'utf8');
  const re = /\/\*<EVENTS-DATA>\*\/[\s\S]*?\/\*<\/EVENTS-DATA>\*\//;
  if (!re.test(html)) { console.error(`No EVENTS-DATA markers found in ${target}`); process.exit(1); }
  fs.writeFileSync(target, html.replace(re, () => block));
  console.log(`\nWrote placeholder EVENTS into ${target} (${(block.length / 1024).toFixed(0)} KB)`);
} else {
  const out = path.join(here, 'placeholder_events.js');
  fs.writeFileSync(out, block + '\n');
  console.log(`\n${target} not found; wrote ${out}`);
}
