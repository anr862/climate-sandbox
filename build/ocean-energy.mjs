/**
 * Which quantity do the ocean transport terms actually conserve?
 *   node build/ocean-energy.mjs
 *
 * scripts/ocean-check.mjs asserts on Σ T·(ocean?1:0.1) — no latitude weight. The
 * code's meridional exchanges are weighted by cosφ, so they conserve the
 * *area-weighted* sum instead. This prints every candidate measure so the test can
 * assert on the physically correct one.
 */
import { World } from "../src/world/world.js";
import { defaults } from "../src/state/params.js";
import { OCEAN_TUNING, cellHeatCapacity, currentHeatStep, overturningHeatStep } from "../src/physics/climate.js";

function appParams() {
  const bag = { ...defaults() };
  bag.cloud = Math.min(96, 12 + bag.humidity * 0.72);
  return bag;
}

const w = new World(appParams(), { seed: 20240 });
for (let n = 0; n < 24; n++) w.step(1);
const g = w.grid, p = w.params;

const measures = {
  "Σ T·cap_binary          (what the test uses)": (T) => {
    let e = 0;
    for (let k = 0; k < g.n; k++) e += T[k] * (g.ocean[k] > 0.5 ? 1 : 0.1);
    return e;
  },
  "Σ cosφ·T                                     ": (T) => {
    let e = 0;
    for (let j = 0; j < g.NB; j++) {
      const c = Math.cos((g.lats[j] * Math.PI) / 180);
      for (let i = 0; i < g.NL; i++) e += T[i + j * g.NL] * c;
    }
    return e;
  },
  "Σ cosφ·C(oceanfrac)·T   (physical energy)    ": (T) => {
    let e = 0;
    for (let j = 0; j < g.NB; j++) {
      const c = Math.cos((g.lats[j] * Math.PI) / 180);
      for (let i = 0; i < g.NL; i++) {
        const k = i + j * g.NL;
        e += T[k] * cellHeatCapacity(p, g.ocean[k]) * c;
      }
    }
    return e;
  },
  "Σ T  (plain)                                 ": (T) => {
    let e = 0;
    for (let k = 0; k < g.n; k++) e += T[k];
    return e;
  },
};

const base = Float32Array.from(g.T);
const b = {}, a = {};
for (const name of Object.keys(measures)) b[name] = measures[name](base);

const dtS = 7.6 * 86400;
OCEAN_TUNING.upwelling = 0;
currentHeatStep(g, p, dtS);
overturningHeatStep(g, p, dtS);
OCEAN_TUNING.upwelling = 1;
const after = Float32Array.from(g.T);
for (const name of Object.keys(measures)) a[name] = measures[name](after);

for (const name of Object.keys(measures)) {
  const rel = Math.abs(a[name] - b[name]) / Math.max(1e-9, Math.abs(b[name]));
  console.log(`${name}  before ${b[name].toExponential(8)}  relative drift ${rel.toExponential(2)}`);
}
