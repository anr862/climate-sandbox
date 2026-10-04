/**
 * Fast calibration + regression check.  node build/fast-check.mjs
 *
 * Deliberately small: a few hundred simulated years, about a minute. The full
 * scripts/physics-check.mjs suite is for release runs.
 */
import { World } from "../src/world/world.js";
import { defaults } from "../src/state/params.js";
import { appDefaultParams } from "../src/state/derive.js";
import { PRESETS } from "../src/state/presets.js";
import { BASE } from "../src/physics/climate.js";
import { gridDimsFor } from "../src/world/gridSizes.js";

function build(over = {}, terrain) {
  // appDefaultParams mirrors state.js applyAutoRules — i.e. the world the app really
  // boots (humidity 78 / cloud 68.2), not defaults()'s humidity 68 / cloud 62.
  const bag = { ...appDefaultParams(defaults), ...over };
  return new World(bag, terrain || { seed: defaults().seed });
}

console.log(`tauRef=${BASE.tauRef}`);

// ---- 1. Earth default: settle and show it is a fixed point -----------------
console.log("\n[1] Earth default, 70 yr (Tann at 40/50/60/70)");
const earth = build();
const marks = [];
for (let yr = 1; yr <= 70; yr++) {
  for (let n = 0; n < 12; n++) earth.step(1);
  if (yr >= 40) marks.push(`${yr}y=${earth.tGlobalAnnual.toFixed(3)}`);
}
console.log(`  ${marks.join("  ")}`);
console.log(`  year1 Tann=${"see below"}  albedo=${earth.albedoGlobal.toFixed(4)}  ice=${(earth.iceAreaFrac * 100).toFixed(2)}%`);
console.log(`  rain=${earth.metrics().precip.toFixed(1)}mm/mo  sea=${earth.seaLevelDelta.toFixed(3)}m  bio=${earth.biomass.toFixed(4)}`);
const g = earth.grid;
let mn = 1e9, mx = -1e9;
for (let j = 0; j < g.NB; j++) {
  let s = 0;
  for (let i = 0; i < g.NL; i++) s += g.T[j * g.NL + i];
  const v = s / g.NL;
  if (v < mn) mn = v;
  if (v > mx) mx = v;
}
console.log(`  zonal min/max ${mn.toFixed(1)}/${mx.toFixed(1)} K  spread ${(mx - mn).toFixed(1)} K`);
const last = marks[marks.length - 1].split("=")[1];
const prev = marks[marks.length - 2].split("=")[1];
console.log(`  70yr - 60yr = ${(Number(last) - Number(prev)).toFixed(4)} K  ${Math.abs(Number(last) - Number(prev)) < 0.02 ? "OK fixed point" : "STILL DRIFTING"}`);

// ---- 2. year-1 sanity (the user's "drops below 10 C in year 1" report) -----
console.log("\n[2] first 3 years, 12-month means (must not plunge)");
const w2 = build();
const first = [];
for (let yr = 1; yr <= 3; yr++) {
  for (let n = 0; n < 12; n++) w2.step(1);
  first.push(`${yr}y=${w2.tGlobalAnnual.toFixed(2)}K(${(w2.tGlobalAnnual - 273.15).toFixed(2)}C)`);
}
console.log(`  ${first.join("  ")}`);
console.log(`  year1 Tann was ${w2.tGlobalAnnual.toFixed(2)} K`);

// ---- 3. terrain robustness -------------------------------------------------
console.log("\n[3] terrain robustness (25 yr each)");
let lo = Infinity, hi = -Infinity;
for (const [label, seed, count] of [
  ["seed 20240 @360x180", 20240, 64800],
  ["seed 4242  @360x180", 4242, 64800],
  ["seed 777   @360x180", 777, 64800],
  ["seed 20240 @720x360", 20240, 259200],
]) {
  const d = gridDimsFor(count);
  const w = new World(appDefaultParams(defaults), { seed, gridX: d.gx, gridY: d.gy });
  for (let n = 0; n < 25 * 12; n++) w.step(1);
  const t = w.tGlobalAnnual;
  lo = Math.min(lo, t); hi = Math.max(hi, t);
  console.log(`  ${label.padEnd(21)} Tann=${t.toFixed(2)}K alb=${w.albedoGlobal.toFixed(3)} ice=${(w.iceAreaFrac * 100).toFixed(1)}%`);
}
console.log(`  spread ${(hi - lo).toFixed(2)} K (${lo.toFixed(2)}..${hi.toFixed(2)})  ${lo > 280 ? "OK no snowball" : "FAIL snowball"}`);

// ---- 4. snowball preset must actually freeze -------------------------------
console.log("\n[4] presets, 25 yr");
for (const preset of PRESETS) {
  const bag = { ...appDefaultParams(defaults), ...(preset.params || {}) };
  const w = new World(bag, { seed: preset.seed });
  for (let n = 0; n < 25 * 12; n++) w.step(1);
  console.log(`  ${preset.label.padEnd(30)} Tann=${w.tGlobalAnnual.toFixed(1)}K alb=${w.albedoGlobal.toFixed(3)} ice=${(w.iceAreaFrac * 100).toFixed(1)}%`);
}

// ---- 5. CO2 sensitivity ----------------------------------------------------
console.log("\n[5] CO2 sensitivity (25 yr)");
const sens = [];
for (const co2 of [280, 420, 840]) {
  const w = build({ co2 });
  for (let n = 0; n < 25 * 12; n++) w.step(1);
  sens.push([co2, w.tGlobalAnnual]);
  console.log(`  CO2=${String(co2).padStart(3)}  Tann=${w.tGlobalAnnual.toFixed(3)}K`);
}
const t280 = sens[0][1], t420 = sens[1][1], t840 = sens[2][1];
console.log(`  280->420 = ${(t420 - t280).toFixed(2)} K   420->840 = ${(t840 - t420).toFixed(2)} K (2xCO2)`);
