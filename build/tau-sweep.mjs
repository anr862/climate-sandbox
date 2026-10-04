import { World } from "../src/world/world.js";
import { defaults } from "../src/state/params.js";
import { BASE } from "../src/physics/climate.js";

const years = Number(process.argv[2] ?? 30);
const taus = (process.argv[3] ?? "0.55,0.575,0.60,0.62,0.64,0.66,0.68,0.70").split(",").map(Number);
const keep = BASE.tauRef;

// area-weighted global mean of a per-cell field on the climate grid
function avg(f, NB = 48, NL = 96) {
  let s = 0, n = 0;
  for (let j = 0; j < NB; j++) {
    const wt = Math.cos(((-90 + (j + 0.5) * (180 / NB)) * Math.PI) / 180);
    for (let i = 0; i < NL; i++) s += f[j * NL + i] * wt;
    n += NL * wt;
  }
  return s / n;
}

console.log(`years=${years}  (T is the 12-month mean)`);
for (const tau of taus) {
  BASE.tauRef = tau;
  const p = { ...defaults() };
  p.cloud = Math.min(96, 12 + p.humidity * 0.72);
  const w = new World(p, { seed: 20240 });
  for (let m = 0; m < years * 12; m++) w.step(1);
  const g = w.grid;
  let mn = 1e9, mx = -1e9;
  for (let j = 0; j < g.NB; j++) {
    let s = 0;
    for (let i = 0; i < g.NL; i++) s += g.T[j * g.NL + i];
    const v = s / g.NL;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  console.log(
    `tau=${tau.toFixed(3)}  T=${w.tGlobalAnnual.toFixed(2)}  inst=${w.tGlobal.toFixed(2)}  ` +
    `alb=${w.albedoGlobal.toFixed(4)}  ice=${(w.iceAreaFrac * 100).toFixed(2)}%  ` +
    `snow=${(avg(g.snowCover, g.NB, g.NL) * 100).toFixed(2)}%  spread=${(mx - mn).toFixed(1)}  ` +
    `rain=${w.metrics().precip.toFixed(1)}`,
  );
}
BASE.tauRef = keep;
