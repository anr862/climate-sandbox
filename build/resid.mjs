import { makeGrid, transportAirStep } from "../src/physics/climate.js";
const g = makeGrid(48, 96);
for (let j = 0; j < g.NB; j++) g.airT[j] = 300 - 60 * Math.sin((g.lats[j] * Math.PI) / 180) ** 2;
const before = Array.from(g.airT);
transportAirStep(g, { transport: 1, atmosphericCirculation: 1 }, 7.6 * 86400);
const after = Array.from(g.airT);
const NB = g.NB, D0 = 4.2e7, dtS = 7.6 * 86400, dy = g.dyM, dy2 = dy * dy;
const mu = []; for (let j = 0; j < NB; j++) mu[j] = D0 * Math.max(0.08, g.cosLat[j]) * dtS / dy2;
let resid = 0, flux = 0;
for (let j = 0; j < NB; j++) {
  const A = Math.max(0.08, g.cosLat[j]);
  const n = j > 0 ? mu[j - 1] : 0, s = j < NB - 1 ? mu[j] : 0;
  const lhs = A * (after[j] - before[j]);
  const rhs = n * ((j > 0 ? after[j - 1] : after[j]) - after[j]) + s * ((j < NB - 1 ? after[j + 1] : after[j]) - after[j]);
  resid += Math.abs(lhs - rhs); flux += Math.abs(lhs);
}
console.log("total |A dT|", flux.toFixed(3), " total residual", resid.toFixed(6), " relative", (resid / flux).toExponential(2));
console.log("net A dT (should be 0):", (() => { let s2 = 0; for (let j = 0; j < NB; j++) s2 += Math.max(0.08, g.cosLat[j]) * (after[j] - before[j]); return s2.toFixed(6); })());