/** Scratch: (ocean, land) heat capacity combos -> seasonal envelope. */
import { World } from '../src/world/world.js';
import { defaults } from '../src/state/params.js';

function appParams(over = {}) {
  const p = { ...defaults(), ...over };
  p.cloud = Math.min(96, 12 + p.humidity * 0.72);
  return p;
}

for (const [oc, land] of [[16, 1.2], [60, 2.5], [100, 3.5], [60, 4]]) {
  const w = new World(appParams({ oceanHeatCapacity: oc, landHeatCapacity: land }), { seed: 20240 });
  let firstYearLo = Infinity, firstYearHi = -Infinity;
  for (let m = 0; m < 12; m++) { w.step(1); firstYearLo = Math.min(firstYearLo, w.tGlobal); firstYearHi = Math.max(firstYearHi, w.tGlobal); }
  for (let n = 0; n < 29 * 12; n++) w.step(1);
  let lo = Infinity, hi = -Infinity;
  for (let m = 0; m < 12; m++) { w.step(1); lo = Math.min(lo, w.tGlobal); hi = Math.max(hi, w.tGlobal); }
  const g = w.grid;
  let diurnal = 0, seasonal = 0;
  for (let k = 0; k < g.n; k++) { diurnal += g.diurnal[k]; seasonal += g.tSeasonMax[k] - g.tSeasonMin[k]; }
  console.log(`ocean=${String(oc).padStart(3)} land=${String(land).padStart(4)}  T30=${w.tGlobal.toFixed(2)}K  ` +
    `first-year ${firstYearLo.toFixed(2)}–${firstYearHi.toFixed(2)}K  steady ${lo.toFixed(2)}–${hi.toFixed(2)}K (p-p ${(hi - lo).toFixed(2)})  ` +
    `diurnal~${(diurnal / g.n).toFixed(1)}K seasonal~${(seasonal / g.n).toFixed(1)}K  ice=${(w.iceAreaFrac * 100).toFixed(1)}%`);
}
