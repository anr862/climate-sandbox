import { World } from "../src/world/world.js";
import { defaults } from "../src/state/params.js";
const p = { ...defaults() }; p.cloud = Math.min(96, 12 + p.humidity * 0.72);
const w = new World(p, { seed: 20240 });
console.log("t=0   T=" + w.tGlobal.toFixed(2) + " annual=" + w.tGlobalAnnual.toFixed(2));
for (let m = 1; m <= 24; m++) {
  w.step(1);
  console.log(`month ${String(m).padStart(2)}  T=${w.tGlobal.toFixed(2)} K (${(w.tGlobal-273.15).toFixed(1)}?C)  annual=${w.tGlobalAnnual.toFixed(2)} K (${(w.tGlobalAnnual-273.15).toFixed(1)}?C)  ice=${(w.iceAreaFrac*100).toFixed(1)}%`);
}