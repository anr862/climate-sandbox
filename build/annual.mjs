import { World } from "../src/world/world.js";
import { defaults } from "../src/state/params.js";
const p = { ...defaults() }; p.cloud = Math.min(96, 12 + p.humidity * 0.72);
const w = new World(p, { seed: 20240 });
let row = [];
for (let m = 1; m <= 40 * 12; m++) {
  w.step(1);
  if (m % 12 === 0) row.push(`${m / 12}y=${w.tGlobalAnnual.toFixed(2)}`);
  if (row.length === 8) { console.log(row.join("  ")); row = []; }
}
if (row.length) console.log(row.join("  "));