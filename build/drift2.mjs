import { World } from "../src/world/world.js";
import { defaults } from "../src/state/params.js";
import { averageField } from "../src/physics/climate.js";
const p = { ...defaults() }; p.cloud = Math.min(96, 12 + p.humidity * 0.72);
const w = new World(p, { seed: 20240 });
const g = w.grid;
console.log("year  Tann   abs    olr    net   albSurf  snow   seaIce  landIce  veg    dry    cloud");
for (let y = 1; y <= 20; y++) {
  let abs = 0, olr = 0, net = 0, albS = 0, snow = 0, sea = 0, land = 0, veg = 0, dry = 0, cl = 0;
  for (let m = 0; m < 12; m++) {
    w.step(1);
    abs += averageField(g, g.absorbed); olr += averageField(g, g.olr); net += averageField(g, g.net);
    albS += averageField(g, g.albedoSurf); snow += averageField(g, g.snowCover);
    veg += averageField(g, g.vegetation); dry += averageField(g, g.dryness); cl += averageField(g, g.cloudCover);
    for (let k = 0; k < g.n; k++) { if (g.ocean[k] > 0.5) sea += g.iceFrac[k] / 12 / g.n; else land += g.iceFrac[k] / 12 / g.n; }
  }
  console.log(`${String(y).padStart(4)}  ${w.tGlobalAnnual.toFixed(2)}  ${(abs/12).toFixed(1)}  ${(olr/12).toFixed(1)}  ${(net/12).toFixed(2)}  ${(albS/12).toFixed(4)}  ${(snow/12).toFixed(4)}  ${sea.toFixed(4)}  ${land.toFixed(4)}  ${(veg/12).toFixed(3)}  ${(dry/12).toFixed(3)}  ${(cl/12).toFixed(3)}`);
}