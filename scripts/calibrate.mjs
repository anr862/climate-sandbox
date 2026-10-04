/**
 * Calibrates BASE.tauRef so an Earth-parameter world settles at the observed
 * 288 K with a ~0.30 planetary albedo, and reports the water cycle.
 * Run:  node scripts/calibrate.mjs
 */
import { World } from '../src/world/world.js';
import { defaults } from '../src/state/params.js';
import { BASE } from '../src/physics/climate.js';
import { PRESETS } from '../src/state/presets.js';

const TARGET = 288.15;

function spin(tauRef, overrides = {}, years = 40) {
  BASE.tauRef = tauRef;
  const world = new World({ ...defaults(), ...overrides }, { seed: 20240 });
  for (let n = 0; n < years * 12; n++) world.step(1);
  return world;
}

console.log('=== calibrate tauRef ===');
let lo = 0.50, hi = 0.75;
for (let it = 0; it < 13; it++) {
  const mid = (lo + hi) / 2;
  const world = spin(mid);
  const t = world.tGlobal;
  console.log(`tauRef=${mid.toFixed(5)} -> T=${t.toFixed(2)} K  alb=${world.albedoGlobal.toFixed(3)}  ` +
    `ice=${(world.iceAreaFrac * 100).toFixed(1)}%  rain=${world.metrics().precip.toFixed(1)} mm/mo`);
  // higher tauRef => more OLR => colder, so invert the bracket
  if (t > TARGET) lo = mid; else hi = mid;
}
const best = (lo + hi) / 2;
console.log(`\nchosen tauRef = ${best.toFixed(5)}`);

console.log('\n=== verification with tauRef tuned ===');
const earth = spin(best, {}, 60);
console.log(`Earth 420ppm   T=${earth.tGlobal.toFixed(2)} alb=${earth.albedoGlobal.toFixed(3)} ` +
  `ice=${(earth.iceAreaFrac * 100).toFixed(1)}% sea=${earth.seaLevelDelta.toFixed(2)}m ` +
  `rain=${earth.metrics().precip.toFixed(1)}mm/mo wind=${earth.windSpeedMean.toFixed(1)}m/s ` +
  `current=${earth.currentSpeedMean.toFixed(3)}m/s bio=${earth.biomass.toFixed(3)}`);

for (const co2 of [180, 280, 420, 560, 840, 1680]) {
  const world = spin(best, { co2 }, 40);
  console.log(`CO2=${String(co2).padStart(5)} ppm  T=${world.tGlobal.toFixed(2)}  ` +
    `dT=${(world.tGlobal - earth.tGlobal).toFixed(2)}  ice=${(world.iceAreaFrac * 100).toFixed(1)}%`);
}

console.log('\n=== circulation sensitivity (60 yr) ===');
for (const cfg of [
  ['reference', {}],
  ['ocean currents off', { oceanCirculation: 0 }],
  ['ocean currents x2', { oceanCirculation: 2 }],
  ['atmos circulation off', { atmosphericCirculation: 0 }],
  ['atmos circulation x2', { atmosphericCirculation: 2 }],
  ['all transport off', { transport: 0 }],
  ['no moisture advection', { windMoisture: 0 }],
]) {
  const world = spin(best, cfg[1], 60);
  let tEq = 0, tPole = 0;
  const g = world.grid;
  for (let i = 0; i < g.NL; i++) { tEq += g.T[i + Math.round(g.NB / 2) * g.NL]; tPole += g.T[i]; }
  console.log(`${cfg[0].padEnd(22)} T=${world.tGlobal.toFixed(2)} eq=${(tEq / g.NL).toFixed(1)} ` +
    `pole=${(tPole / g.NL).toFixed(1)} rain=${world.metrics().precip.toFixed(1)} wind=${world.windSpeedMean.toFixed(1)}`);
}

console.log('\n=== presets (30 yr) ===');
for (const preset of PRESETS) {
  BASE.tauRef = best;
  const world = new World({ ...defaults(), ...(preset.params || {}) }, { seed: preset.seed });
  for (let n = 0; n < 30 * 12; n++) world.step(1);
  console.log(`${preset.label.padEnd(32)} T=${world.tGlobal.toFixed(1)} K (${(world.tGlobal - 273.15).toFixed(1)}°C) ` +
    `alb=${world.albedoGlobal.toFixed(3)} ice=${(world.iceAreaFrac * 100).toFixed(1)}% ` +
    `ocean=${(world.oceanFraction * 100).toFixed(1)}% rain=${world.metrics().precip.toFixed(1)} bio=${world.biomass.toFixed(3)}`);
}
