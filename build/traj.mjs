import { World } from "../src/world/world.js";
import { defaults } from "../src/state/params.js";
const p = { ...defaults() }; p.cloud = Math.min(96, 12 + p.humidity * 0.72);
const w = new World(p, { seed: 20240 });
console.log("t=0 T=" + w.tGlobal.toFixed(2) + " alb=" + w.albedoGlobal.toFixed(3) + " ice=" + (w.iceAreaFrac*100).toFixed(1));
for (let m = 1; m <= 36; m++) {
  w.step(1);
  if (m <= 12 || m % 6 === 0) {
    console.log(`month ${String(m).padStart(2)} T=${w.tGlobal.toFixed(2)} (${(w.tGlobal-273.15).toFixed(1)}?C) alb=${w.albedoGlobal.toFixed(3)} ice=${(w.iceAreaFrac*100).toFixed(1)}% cloud=${w.cloudMean.toFixed(2)} rain=${w.metrics().precip.toFixed(1)}`);
  }
}