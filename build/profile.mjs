import { World } from "../src/world/world.js";
import { defaults } from "../src/state/params.js";

const years = Number(process.argv[2] ?? 30);
const p = { ...defaults() };
if (process.argv[3]) p.tauRef = Number(process.argv[3]);
if (process.argv[4]) p.transport = Number(process.argv[4]);
p.cloud = Math.min(96, 12 + p.humidity * 0.72);
const w = new World(p, { seed: 20240 });
for (let m = 1; m <= years * 12; m++) w.step(1);

const g = w.grid;
const NB = g.NB;
// area-weighted zonal mean of the surface temperature over the last 12 months
const bands = 6;
const size = NB / bands;
const rows = [];
for (let b = 0; b < bands; b++) {
  let sum = 0, wt = 0;
  for (let j = b * size; j < (b + 1) * size; j++) {
    const wgt = Math.cos((g.lats[j] * Math.PI) / 180);
    let s = 0;
    for (let i = 0; i < g.NL; i++) s += g.T[j * g.NL + i];
    sum += (s / g.NL) * wgt;
    wt += wgt;
  }
  rows.push((sum / wt).toFixed(1));
}
console.log(`tau=${(p.tauRef ?? 0.5755)} transport=${p.transport ?? 1}`);
console.log(`Tglobal(12m mean) ${w.tGlobalAnnual.toFixed(2)} K   Tinst ${w.tGlobal.toFixed(2)} K`);
console.log(`albedo ${w.albedoGlobal.toFixed(4)}`);
console.log(`zonal 90S->90N  ${rows.join("  ")}`);
let mn = 1e9, mx = -1e9;
for (let j = 0; j < NB; j++) {
  let s = 0;
  for (let i = 0; i < g.NL; i++) s += g.T[j * g.NL + i];
  const v = s / g.NL;
  if (v < mn) mn = v;
  if (v > mx) mx = v;
}
console.log(`band min/max ${mn.toFixed(1)} / ${mx.toFixed(1)}  spread ${(mx - mn).toFixed(1)} K`);
console.log(`air band min/max ${Math.min(...g.airT).toFixed(1)} / ${Math.max(...g.airT).toFixed(1)}`);
