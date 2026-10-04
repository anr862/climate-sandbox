/** Scratch: pick the ocean mixed-layer heat capacity. */
import { World } from '../src/world/world.js';
import { defaults } from '../src/state/params.js';

function appParams(over = {}) {
  const p = { ...defaults(), ...over };
  p.cloud = Math.min(96, 12 + p.humidity * 0.72);
  return p;
}

for (const ohc of [16, 40, 80, 140]) {
  const w = new World(appParams({ oceanHeatCapacity: ohc }), { seed: 20240 });
  for (let n = 0; n < 30 * 12; n++) w.step(1);
  // seasonal envelope of the global mean over the next 12 months
  let lo = Infinity, hi = -Infinity;
  const monthT = [];
  for (let m = 0; m < 12; m++) { w.step(1); monthT.push(w.tGlobal); lo = Math.min(lo, w.tGlobal); hi = Math.max(hi, w.tGlobal); }
  // transient response to a CO2 doubling, measured from the same state
  const w2 = new World(appParams({ oceanHeatCapacity: ohc, co2: 840 }), { seed: 20240 });
  for (let n = 0; n < 30 * 12; n++) w2.step(1);
  const t30 = w2.tGlobal;
  const w3 = new World(appParams({ oceanHeatCapacity: ohc, co2: 840 }), { seed: 20240 });
  for (let n = 0; n < 5 * 12; n++) w3.step(1);
  const t5 = w3.tGlobal;
  console.log(`oceanHeatCapacity=${String(ohc).padStart(3)}  T30=${w.tGlobal.toFixed(2)} K  seasonal ${lo.toFixed(2)}–${hi.toFixed(2)} (p-p ${(hi - lo).toFixed(2)} K)  ` +
    `2xCO2: 5yr=${t5.toFixed(2)} 30yr=${t30.toFixed(2)} K`);
}
