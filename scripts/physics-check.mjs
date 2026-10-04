/**
 * Headless physics check — node scripts/physics-check.mjs
 *
 * Builds several worlds and prints equilibrium diagnostics so the calibration
 * can be verified without opening a browser.
 *
 * NOTE: keep local variable names distinct from anything used inside the
 * imported modules (e.g. never declare a top-level `sum`, `i`, `j`, `s`).
 */
import { World, CLIMATE_NB, CLIMATE_NL } from '../src/world/world.js';
import { defaults } from '../src/state/params.js';
import { appDefaultParams } from '../src/state/derive.js';
import { PRESETS } from '../src/state/presets.js';
import { averageField } from '../src/physics/climate.js';
import { LAYERS } from '../src/core/colors.js';

function build(preset, overrides = {}) {
  // appDefaultParams runs the app's own applyAutoRules, so a world built with no
  // preset is byte-for-byte the one the app boots (humidity 78 / cloud 68.2).
  // Hand-rolling "cloud follows humidity" here is what previously calibrated the
  // whole model against cloud cover 60.96 while the app ran at 68.2.
  const bag = { ...appDefaultParams(defaults), ...(preset?.params || {}), ...overrides };
  return new World(bag, { seed: preset?.seed ?? defaults().seed, name: preset?.label || 'test' });
}

function advance(world, years) {
  const steps = Math.round(years * 12);
  for (let n = 0; n < steps; n++) world.step(1);
  return world;
}

function bandTemperature(world, targetLat) {
  const g = world.grid;
  let bestJ = 0, bestD = Infinity;
  for (let jj = 0; jj < CLIMATE_NB; jj++) {
    const d = Math.abs(g.lats[jj] - targetLat);
    if (d < bestD) { bestD = d; bestJ = jj; }
  }
  let acc = 0;
  for (let ii = 0; ii < CLIMATE_NL; ii++) acc += g.T[ii + bestJ * CLIMATE_NL];
  return acc / CLIMATE_NL;
}

function report(label, world) {
  const g = world.grid;
  const line = [
    label.padEnd(31),
    // tGlobalAnnual is the 12-month mean: the *equilibrium* indicator. tGlobal is
    // whatever month the spin-up happened to stop on and swings ±2 K with the
    // seasonal cycle, so quoting it alone hides slow drift.
    `Tann=${(world.tGlobalAnnual ?? NaN).toFixed(2)}K`,
    `Tinst=${world.tGlobal.toFixed(2)}K`,
    `eq=${bandTemperature(world, 0).toFixed(1)}`,
    `45N/S=${bandTemperature(world, 45).toFixed(1)}/${bandTemperature(world, -45).toFixed(1)}`,
    `pole=${((bandTemperature(world, 86) + bandTemperature(world, -86)) / 2).toFixed(1)}`,
    `alb=${world.albedoGlobal.toFixed(3)}`,
    `tau=${world.tau.toFixed(4)}`,
    `ice=${(world.iceAreaFrac * 100).toFixed(1)}%`,
    `rain=${averageField(g, g.precip).toFixed(1)}`,
    `sea=${world.seaLevelDelta.toFixed(2)}m`,
    `bio=${world.biomass.toFixed(3)}`,
  ];
  console.log(line.join('  '));
}

console.log('=== Earth calibration (60 yr spin-up) ===');
report('Earth 420ppm', advance(build(null, {}), 60));
report('Earth 280ppm', advance(build(null, { co2: 280 }), 60));
report('Earth 840ppm (2xCO2)', advance(build(null, { co2: 840 }), 60));
report('Earth, H2O feedback off', advance(build(null, { ghgH2O: 0 }), 60));
report('Earth, transport x2', advance(build(null, { transport: 2 }), 60));
report('Earth, transport x0.3', advance(build(null, { transport: 0.3 }), 60));
report('Earth, tilt 0', advance(build(null, { axialTilt: 0 }), 60));
report('Earth, tilt 60', advance(build(null, { axialTilt: 60 }), 60));

console.log('\n=== Presets (40 yr) ===');
for (const preset of PRESETS) report(preset.label, advance(build(preset), 40));

console.log('\n=== Seasonal cycle, Earth (year 10) ===');
const earth = build(null, {});
advance(earth, 10);
for (let mStep = 0; mStep < 12; mStep++) {
  earth.step(1);
  console.log(`  month ${String(mStep + 1).padStart(2)}: N60=${bandTemperature(earth, 60).toFixed(1)}K  S60=${bandTemperature(earth, -60).toFixed(1)}K  eq=${bandTemperature(earth, 0).toFixed(1)}K  global=${earth.tGlobal.toFixed(2)}K`);
}

console.log('\n=== Long-run stability & speed ===');
// 180 yr, not 400: the snowball is a stable fixed point, so this only has to outlast
// the transient. Kept short because the whole suite is meant to finish in a few
// minutes — a release check nobody wants to run is a release check nobody runs.
const snow = build(PRESETS.find((p) => p.id === 'snowball'));
const clockStart = Date.now();
advance(snow, 180);
report('Snowball @180yr', snow);
console.log(`  ${(2160 / ((Date.now() - clockStart) / 1000)).toFixed(0)} sim-months/s`);

report('Hothouse @120yr', advance(build(PRESETS.find((p) => p.id === 'hothouse')), 120));

console.log('\n=== Extreme worlds ===');
report('Mars', advance(build(PRESETS.find((p) => p.id === 'mars')), 40));
report('Venus', advance(build(PRESETS.find((p) => p.id === 'venus')), 40));
report('Ice moon', advance(build(PRESETS.find((p) => p.id === 'ice-moon')), 40));
report('Eyeball', advance(build(PRESETS.find((p) => p.id === 'eyeball')), 40));

console.log('\n=== Layer sanity (Earth) ===');
const e2 = advance(build(null, {}), 30);
const keys = ['temperature', 'precipitation', 'oxygen', 'humidity', 'vegetation', 'habitability',
  'toxicity', 'aerosol', 'cloud', 'diurnal', 'seasonal', 'precipSeason', 'rivers', 'seaIce',
  'windSpeed', 'currentSpeed', 'anomaly'];
for (const key of keys) {
  const data = e2.layerData(key);
  const rng = e2.layerRange(key);
  let finite = 0;
  for (let n = 0; n < data.length; n++) if (isFinite(data[n])) finite++;
  console.log(`  ${key.padEnd(14)} min=${rng.min.toFixed(3)} max=${rng.max.toFixed(3)} finite=${finite}/${data.length}`);
}

console.log('\n=== Long-run stability & drift (Earth, 150 yr) ===');
{
  // Two things must hold with fixed 2024-like greenhouse gases:
  //   a) the planet does not slide into the snowball branch on century timescales;
  //   b) the settled state has no *trend*.
  // The test is the trend, not the peak-to-peak spread: the coupled ice/ocean system
  // has a bounded multi-decade oscillation (the 12-month mean breathes about ±0.2 K
  // around 288.1 K), so a spread threshold flags a healthy steady state. The window
  // starts at year 60 because years 10-40 still contain the tail of the spin-up
  // (settling down from ~288.5 K), which is convergence, not instability.
  const lw = build(null, {});
  const yearly = [];
  for (let yr = 1; yr <= 150; yr++) {
    for (let n = 0; n < 12; n++) lw.step(1);
    yearly.push(lw.tGlobalAnnual);
  }
  const marks = [40, 60, 100, 150];
  console.log(`  ${marks.map((y) => `${y}y=${yearly[y - 1].toFixed(3)}K/${(lw.iceAreaFrac * 100).toFixed(1)}%`).join('  ')}`);

  const tail = yearly.slice(59);              // years 60..150
  const N = tail.length;
  const meanX = (N - 1) / 2;
  const meanY = tail.reduce((a, b) => a + b, 0) / N;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < N; i++) { sxy += (i - meanX) * (tail[i] - meanY); sxx += (i - meanX) ** 2; }
  const slope = sxy / sxx;                    // K per year
  console.log(`  year 1 ${yearly[0].toFixed(2)}K   year 10 ${yearly[9].toFixed(2)}K   year 40 ${yearly[39].toFixed(2)}K`);
  console.log(`  trend over years 60-150: ${slope >= 0 ? '+' : ''}${slope.toFixed(5)} K/yr ` +
    `(${(slope * 90).toFixed(3)} K over 90 yr)`);
  console.log(`  ${Math.abs(slope) < 0.005 ? 'OK  steady state (no trend)' : 'FAIL  still drifting'}`);
  // the old energy leak gave -0.053 K/yr sustained, so this window still catches it
}

console.log('\n=== Regression: transport conserves area-weighted heat ===');
{
  // The bug this guards: transportAirStep used to conserve the *unweighted* band
  // sum ΣT. Moving heat poleward then dumped it into bands that represent a tiny
  // fraction of the surface, so Σ(cosφ·T) fell every step and the planet cooled
  // ~2 K per 40 years with no greenhouse change at all. The conserved quantity
  // must be exactly the one the global averages use.
  const { transportAirStep } = await import('../src/physics/climate.js');
  const w = build(null, {});
  const g = w.grid;
  const weighted = () => {
    let acc = 0;
    for (let jj = 0; jj < CLIMATE_NB; jj++) acc += Math.cos((g.lats[jj] * Math.PI) / 180) * g.airT[jj];
    return acc;
  };
  // a deliberately extreme profile: any scheme that is not area-consistent shows
  // a drift here instead of hiding it behind a near-equilibrium state
  for (let jj = 0; jj < CLIMATE_NB; jj++) {
    const lat = g.lats[jj];
    g.airT[jj] = 320 - 60 * Math.pow(Math.abs(lat) / 90, 2);
  }
  const before = weighted();
  transportAirStep(g, w.params, 2.63e6);
  transportAirStep(g, w.params, 2.63e6);
  const after = weighted();
  const drift = Math.abs(after - before) / Math.max(1, Math.abs(before));
  console.log(`  Σ(cosφ·T) ${before.toFixed(5)} -> ${after.toFixed(5)}  relative drift ${drift.toExponential(2)}`);
  console.log(`  ${drift < 1e-9 ? 'OK  conserved' : 'FAIL  area-weighted heat is not conserved'}`);
}

console.log('\n=== Robustness across terrain seeds and mesh sizes ===');
{
  // The user-visible failure this guards against: a terrain slightly brighter
  // than the calibration seed used to push the planet into the snowball branch
  // (a steady slide towards -45 °C) even with 2024-like greenhouse gases.
  const gridSizes = await import('../src/world/gridSizes.js');
  const cases = [
    ['seed 20240 @360x180', 20240, 64800],
    ['seed 4242  @360x180', 4242, 64800],
    ['seed 777   @360x180', 777, 64800],
    ['seed 12345 @360x180', 12345, 64800],
    ['seed 20240 @180x90', 20240, 16200],
    ['seed 20240 @720x360', 20240, 259200],
  ];
  let lo = Infinity, hi = -Infinity, worst = null;
  for (const [label, seed, count] of cases) {
    const d = gridSizes.gridDimsFor(count);
    const w = new World(appDefaultParams(defaults), { seed, gridX: d.gx, gridY: d.gy });
    for (let n = 0; n < 30 * 12; n++) w.step(1);
    const t = w.tGlobalAnnual ?? w.tGlobal;
    lo = Math.min(lo, t);
    hi = Math.max(hi, t);
    if (!worst || t < worst.t) worst = { label, t };
    console.log(`  ${label.padEnd(22)} Tann=${t.toFixed(2)}K  alb=${w.albedoGlobal.toFixed(3)}  ice=${(w.iceAreaFrac * 100).toFixed(1)}%`);
  }
  console.log(`  spread ${(hi - lo).toFixed(2)} K, coldest ${lo.toFixed(2)} K (${worst ? worst.label : '-'})`);
}

console.log('\n=== Meteor impacts ===');
{
  // nothing happens before the chosen month; on it, dust is injected and the
  // planet cools for a few years
  const mw = build(null, { meteorEnabled: true, meteorMonth: 36, meteorMass: 1e15, meteorCount: 3, meteorMassSigma: 0.4 });
  for (let n = 0; n < 35; n++) mw.step(1);
  console.log(`  month 35     : impact=${!!mw.impact} (must be false), dust=${(mw.impactDust || 0).toFixed(3)}`);
  const tBefore = mw.tGlobal;
  mw.step(1);
  const im = mw.impact;
  console.log(`  month 36     : count=${im && im.count} total=${im && im.total.toExponential(2)} kg ` +
    `load=${im && im.load.toFixed(3)} fireball=${im && im.heat.toFixed(1)} K ` +
    `site=${im && im.site.lat.toFixed(1)},${im && im.site.lon.toFixed(1)}`);
  let minT = Infinity;
  for (let n = 0; n < 24; n++) { mw.step(1); minT = Math.min(minT, mw.tGlobal); }
  console.log(`  +2 years     : T=${mw.tGlobal.toFixed(2)} K (min ${minT.toFixed(2)}, was ${tBefore.toFixed(2)}) ` +
    `dust=${mw.impactDust.toFixed(3)} rain=${averageField(mw.grid, mw.grid.precip).toFixed(1)} mm/mo`);
  for (const mass of [1e9, 1e12, 1e15, 1e18, 1e21]) {
    const w2 = build(null, { meteorEnabled: true, meteorMonth: 0, meteorMass: mass, meteorCount: 1 });
    w2.triggerImpacts(1);
    console.log(`  mass ${mass.toExponential(0).padStart(7)} kg -> dust ${w2.impact.load.toFixed(3)}, fireball ${w2.impact.heat.toFixed(1)} K`);
  }
}

console.log('\n=== Colourbar ranges (legend) ===');
{
  const all = Object.keys(LAYERS).filter((k) => k !== 'none');
  for (const key of all) {
    const r = e2.layerRange(key);
    process.stdout.write(`${key}=${r.min}…${r.max}  `);
  }
  console.log('');
  e2.rangeOverride = (k) => (k === 'temperature' ? { min: -5, max: 5 } : null);
  const custom = e2.layerRange('temperature');
  console.log(`  manual override wins: temperature ${custom.min}…${custom.max} custom=${!!custom.custom}`);
  e2.rangeOverride = null;
  console.log(`  vectors: ${Object.values(LAYERS).filter((l) => l.vector).map((l) => `${l.label}(${l.unit})`).join(', ')}`);
}
