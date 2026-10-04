/** Is mean land habitability seasonal, or did it drop? */
import { World } from '../src/world/world.js';
import { defaults } from '../src/state/params.js';
import { appDefaultParams } from '../src/state/derive.js';

const w = new World(appDefaultParams(defaults), { seed: defaults().seed });
const mean = (g, f) => {
  let s = 0, n = 0;
  for (let k = 0; k < g.n; k++) if (g.ocean[k] < 0.5) { s += f[k]; n++; }
  return n ? s / n : 0;
};
console.log('month  landHabitability  landPrecip  landVeg  landT');
for (let m = 1; m <= 36; m++) {
  w.step(1);
  if (m % 3) continue;
  const g = w.grid;
  let lt = 0, ln = 0;
  for (let k = 0; k < g.n; k++) if (g.ocean[k] < 0.5) { lt += g.T[k]; ln++; }
  console.log(String(m).padStart(5),
    mean(g, g.habitability).toFixed(3).padStart(15),
    mean(g, g.precip).toFixed(1).padStart(11),
    mean(g, g.vegetation).toFixed(3).padStart(8),
    (lt / Math.max(1, ln)).toFixed(1).padStart(7));
}
