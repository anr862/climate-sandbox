import { World } from "../src/world/world.js";
import { defaults } from "../src/state/params.js";
const p = { ...defaults() }; p.cloud = Math.min(96, 12 + p.humidity * 0.72);
const w = new World(p, { seed: 20240 });
const g = w.grid;
const mean = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s / a.length; };
console.log("year  Tann   albedo  seaIce%  snowCov%  landIceThk  seaIceThk  cloud  rain  oceanIceCov%");
for (let y = 1; y <= 20; y++) {
  for (let m = 0; m < 12; m++) w.step(1);
  let landThk = 0, n = 0, seaThk = 0, m2 = 0, iceArea = 0;
  for (let k = 0; k < g.n; k++) {
    if (g.ocean[k] > 0.5) { seaThk += g.ice[k]; m2++; } else { landThk += g.ice[k]; n++; }
    iceArea += g.iceFrac[k];
  }
  console.log(`${String(y).padStart(4)}  ${w.tGlobalAnnual.toFixed(2)}  ${w.albedoGlobal.toFixed(4)}  ${(w.iceAreaFrac * 100).toFixed(1).padStart(6)}  ${(mean(g.snowCover) * 100).toFixed(1).padStart(7)}  ${(landThk / n).toFixed(3).padStart(9)}  ${(seaThk / m2).toFixed(3).padStart(8)}  ${w.cloudMean.toFixed(3)}  ${w.metrics().precip.toFixed(1)}  ${((iceArea / g.n) * 100).toFixed(1)}`);
}