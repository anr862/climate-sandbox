/** Scratch: what drives the global-mean seasonal swing? */
import { World } from '../src/world/world.js';
import { defaults } from '../src/state/params.js';
import { dailyInsolation } from '../src/physics/climate.js';

const p = { ...defaults() };
p.cloud = Math.min(96, 12 + p.humidity * 0.72);
const w = new World(p, { seed: 20240 });
for (let m = 0; m < 24; m++) w.step(1);      // settle two years

const g = w.grid;
const mean = (arr, w2) => { let s = 0, t = 0; for (let j = 0; j < g.NB; j++) { for (let i = 0; i < g.NL; i++) { s += arr[i + j * g.NL] * g.areaFrac[j] * (w2 ? w2[j] : 1); t += g.areaFrac[j] * (w2 ? w2[j] : 1); } } return s / t; };
const hemi = (arr) => { let n = 0, s = 0, nn = 0, ss = 0; for (let j = 0; j < g.NB; j++) { for (let i = 0; i < g.NL; i++) { const k = i + j * g.NL; if (g.lats[j] > 0) { n += arr[k] * g.areaFrac[j]; s += g.areaFrac[j]; } else { nn += arr[k] * g.areaFrac[j]; ss += g.areaFrac[j]; } } } return [n / s, nn / ss]; };

console.log('month   T(°C)   insol  absorbed   OLR    albedo   cloud   ice%   snow%   NH_T   SH_T');
for (let m = 0; m < 12; m++) {
  const monthNow = w.time.month;
  const day = 15 + ((monthNow % 12) + 12) % 12 * 30.4375;
  const insol = dailyInsolation(g.lats, day, { irradiance: 1361, axialTilt: p.axialTilt, eccentricity: p.eccentricity, perihelion: p.perihelion });
  let insolMean = 0;
  for (let j = 0; j < g.NB; j++) insolMean += insol[j] * g.areaFrac[j];
  const [nh, sh] = hemi(g.T);
  console.log(`${String(m + 1).padStart(5)}  ${(w.tGlobal - 273.15).toFixed(1).padStart(6)}  ${insolMean.toFixed(1).padStart(6)}  ${mean(g.absorbed).toFixed(1).padStart(7)}  ${mean(g.olr).toFixed(1).padStart(5)}  ${w.albedoGlobal.toFixed(4)}  ${w.cloudMean.toFixed(2)}  ${(w.iceAreaFrac * 100).toFixed(1).padStart(4)}  ${(mean(g.snowCover) * 100).toFixed(1).padStart(5)}  ${nh.toFixed(1)}  ${sh.toFixed(1)}`);
  w.step(1);
}
