import { World } from "../src/world/world.js";
import { defaults } from "../src/state/params.js";

function avg(f, NB, NL) {
  let s = 0, n = 0;
  for (let j = 0; j < NB; j++) {
    const wt = Math.cos(((-90 + (j + 0.5) * (180 / NB)) * Math.PI) / 180);
    for (let i = 0; i < NL; i++) s += f[j * NL + i] * wt;
    n += NL * wt;
  }
  return s / n;
}

const p = { ...defaults() };
p.cloud = Math.min(96, 12 + p.humidity * 0.72);
const w = new World(p, { seed: 20240 });
const g = w.grid;

console.log("yr    Tann    Tinst   albedo  iceArea snow    landIce  biomass seaLvl  rain    cloudCover veg");
let m = 0;
for (let yr = 25; yr <= 300; yr += 25) {
  while (m < yr * 12) { w.step(1); m++; }
  console.log(
    String(yr).padStart(3),
    w.tGlobalAnnual.toFixed(3).padStart(7),
    w.tGlobal.toFixed(3).padStart(7),
    w.albedoGlobal.toFixed(4).padStart(7),
    (w.iceAreaFrac * 100).toFixed(3).padStart(7),
    (avg(g.snowCover, g.NB, g.NL) * 100).toFixed(3).padStart(7),
    (avg(g.landIce ?? g.ice, g.NB, g.NL)).toFixed(4).padStart(8),
    w.biomass.toFixed(4).padStart(8),
    w.seaLevelDelta.toFixed(3).padStart(7),
    w.metrics().precip.toFixed(2).padStart(7),
    (avg(g.cloudCover, g.NB, g.NL)).toFixed(4).padStart(8),
    (avg(g.vegetation, g.NB, g.NL)).toFixed(4).padStart(7),
  );
}
