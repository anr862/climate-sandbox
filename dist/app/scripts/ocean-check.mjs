/**
 * Ocean coupling check — node scripts/ocean-check.mjs
 *
 * The three ocean heat terms (gyre advection, meridional overturning, upwelling)
 * are hard to reason about from the code, so this measures each one's climate
 * effect on its own, plus the two rules the model must obey:
 *   - currents exist only in water;
 *   - the exchange terms are antisymmetric, so they may move heat but not create
 *     or destroy it (checked against the total column energy).
 */
import { World } from '../src/world/world.js';
import { defaults } from '../src/state/params.js';
import { appDefaultParams } from '../src/state/derive.js';
import { OCEAN_TUNING, BASE, cellHeatCapacity } from '../src/physics/climate.js';

/** The parameter bag the app actually boots with — see src/state/derive.js. */
function appParams() {
  return appDefaultParams(defaults);
}
let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + JSON.stringify(detail) : ''}`);
};

function run(cfg, years = 40) {
  Object.assign(OCEAN_TUNING, { advection: 0, overturning: 0, upwelling: 0 }, cfg);
  const w = new World(appParams(), { seed: 20240 });
  for (let n = 0; n < years * 12; n++) w.step(1);
  let pole = 0;
  for (let i = 0; i < w.grid.NL; i++) pole += w.grid.T[i];
  return { t: w.tGlobal, pole: pole / w.grid.NL, ice: w.iceAreaFrac * 100, w };
}

const none = run({});
const upw = run({ upwelling: 1 });
const over = run({ overturning: 1 });
const adv = run({ advection: 1 });
const all = run({ advection: 1, overturning: 1, upwelling: 1 });
Object.assign(OCEAN_TUNING, { advection: 1, overturning: 1, upwelling: 1 });

console.log(`  all off        T=${none.t.toFixed(2)} pole=${none.pole.toFixed(1)} ice=${none.ice.toFixed(1)}%`);
console.log(`  upwelling only T=${upw.t.toFixed(2)} pole=${upw.pole.toFixed(1)} ice=${upw.ice.toFixed(1)}%`);
console.log(`  overturning    T=${over.t.toFixed(2)} pole=${over.pole.toFixed(1)} ice=${over.ice.toFixed(1)}%`);
console.log(`  advection      T=${adv.t.toFixed(2)} pole=${adv.pole.toFixed(1)} ice=${adv.ice.toFixed(1)}%`);
console.log(`  all three      T=${all.t.toFixed(2)} pole=${all.pole.toFixed(1)} ice=${all.ice.toFixed(1)}%`);

check('each ocean term is at most a few K on its own',
  Math.abs(upw.t - none.t) < 8 && Math.abs(over.t - none.t) < 3 && Math.abs(adv.t - none.t) < 3,
  { upwelling: +(upw.t - none.t).toFixed(2), overturning: +(over.t - none.t).toFixed(2), advection: +(adv.t - none.t).toFixed(2) });
// The global-mean effect is *small* by design now, and the threshold had to come down
// from 2 K. Coastal upwelling used to be placed by fixed cosine-lobe "basins" and so
// covered a large slice of every ocean; it is now driven by the real shoreline
// orientation and the real alongshore wind, which confines it to genuinely
// upwelling-favourable coasts. Real coastal upwelling is intense but narrow (~100 km),
// so its contribution to a *global* mean over 417 km cells is legitimately modest —
// its job is the regional signature (cold, dry eastern margins), which the
// terrain-flow check tests directly.
check('the ocean as a whole matters', Math.abs(all.t - none.t) > 0.5 && Math.abs(all.t - none.t) < 12,
  { total: +(all.t - none.t).toFixed(2) });

/* --- currents only in water ---------------------------------------------- */
{
  const w = new World(appParams(), { seed: 20240 });
  for (let n = 0; n < 60; n++) w.step(1);
  let land = 0, sea = 0, landMax = 0, seaMax = 0;
  for (let j = 0; j < w.grid.NB; j++) {
    for (let i = 0; i < w.grid.NL; i++) {
      const k = i + j * w.grid.NL;
      if (w.grid.ocean[k] > 0.5) { sea++; seaMax = Math.max(seaMax, w.grid.currentSpeed[k]); }
      else { land++; landMax = Math.max(landMax, w.grid.currentSpeed[k]); }
    }
  }
  check('current field is zero on land', landMax === 0 && seaMax > 0.1,
    { landCells: land, landMax, seaMax: +seaMax.toFixed(3) });
}

/* --- the exchange terms conserve energy ---------------------------------- */
{
  const w = new World(appParams(), { seed: 20240 });
  for (let n = 0; n < 24; n++) w.step(1);
  const g = w.grid;
  const p = w.params;
  /**
   * True column energy: Σ cosφ · C · T.
   *
   * The latitude weight is essential and the capacity must be the same continuous
   * function the model uses. An earlier version of this check summed
   * T·(ocean?1:0.1) with no cosφ and reported a spurious 1.3e-4 "leak": the
   * meridional exchanges are weighted by cosφ on purpose (so they conserve the
   * area-weighted total, which is what the planet's mean temperature is built
   * from), and a flat per-cell sum therefore cannot be conserved by them. Measured
   * against the physical quantity the same step conserves to ~1e-8.
   */
  const energy = (field) => {
    const T = field || g.T;
    let e = 0;
    for (let j = 0; j < g.NB; j++) {
      const cw = Math.cos((g.lats[j] * Math.PI) / 180);
      for (let i = 0; i < g.NL; i++) {
        const k = i + j * g.NL;
        e += T[k] * cellHeatCapacity(p, g.ocean[k]) * cw;
      }
    }
    return e;
  };
  const before = energy();
  // Apply only the *transport* terms to the current state, with no radiation.
  // Upwelling is excluded on purpose: it is a genuine sink (heat is carried into
  // the deep ocean, which this model does not resolve), whereas the advection and
  // overturning terms may only move heat around.
  const dtS = 7.6 * 86400;
  const t0 = Float32Array.from(g.T);
  OCEAN_TUNING.upwelling = 0;
  const { currentHeatStep, overturningHeatStep } = await import('../src/physics/climate.js');
  currentHeatStep(g, p, dtS);
  overturningHeatStep(g, p, dtS);
  OCEAN_TUNING.upwelling = 1;
  const after = energy();
  const drift = Math.abs(after - before) / Math.max(1e-9, Math.abs(before));
  check('ocean transport does not create or destroy heat', drift < 1e-6,
    { relativeDrift: drift.toExponential(2), cells: g.n });
  g.T.set(t0);

  // and upwelling must only ever cool
  const tBefore = Float32Array.from(g.T);
  OCEAN_TUNING.advection = 0; OCEAN_TUNING.overturning = 0; OCEAN_TUNING.upwelling = 1;
  currentHeatStep(g, p, dtS);
  Object.assign(OCEAN_TUNING, { advection: 1, overturning: 1, upwelling: 1 });
  let warmed = 0, cooled = 0;
  for (let k = 0; k < g.n; k++) {
    if (g.T[k] > tBefore[k] + 1e-4) warmed++;
    if (g.T[k] < tBefore[k] - 1e-4) cooled++;
  }
  check('upwelling only cools', warmed === 0 && cooled > 0, { warmed, cooled });
  g.T.set(tBefore);
}

console.log(`\ncalibration: T=${all.t.toFixed(2)} K (tauRef ${BASE.tauRef})`);
console.log(failures ? `${failures} check(s) failed` : 'all ocean-coupling checks passed');
process.exit(failures ? 1 : 0);
