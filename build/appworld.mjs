/**
 * The app's *real* default world, and where its albedo comes from.
 *   node build/appworld.mjs [years]
 *
 * Every check script used to mirror only the cloud formula
 * (cloud = 12 + humidity·0.72) while feeding it defaults().humidity — which is 68.
 * The app runs applyAutoRules, whose water-vapour rule is
 *   humidity = exp((tGlobal - 288)/14) · 78 · supply
 * i.e. exactly 78 at 288 K with an Earth-like ocean fraction, giving cloud 68.16
 * rather than 60.96. That 7-point difference in cloud cover is the whole reason the
 * calibration looked fine in Node and froze in the browser.
 */
import { World } from "../src/world/world.js";
import { defaults } from "../src/state/params.js";

const years = Number(process.argv[2] ?? 50);

/** Mirrors state.js applyAutoRules for the four derived parameters. */
export function appParams(tGlobal = 288) {
  const p = { ...defaults() };
  const supply = 0.25 + 0.75 * Math.min(1, (p.oceanFraction ?? 71) / 70.8);
  p.humidity = Math.min(100, Math.exp((tGlobal - 288) / 14) * 78 * supply);
  p.cloud = Math.min(96, 12 + p.humidity * 0.72);
  p.n2 = Math.max(0, 100 - (p.o2 + p.co2 / 1e4 + p.otherGas));
  return p;
}

const p = appParams();
console.log(`app-equivalent params: humidity=${p.humidity.toFixed(2)}  cloud=${p.cloud.toFixed(2)}  ` +
  `(defaults() would give humidity=${defaults().humidity} cloud=${(12 + defaults().humidity * 0.72).toFixed(2)})`);
console.log(`oceanFraction=${p.oceanFraction}`);

const w = new World(p, { seed: p.seed });
const g = w.grid;
const mean = (f) => {
  let s = 0, n = 0;
  for (let j = 0; j < g.NB; j++) {
    const c = Math.cos((g.lats[j] * Math.PI) / 180);
    for (let i = 0; i < g.NL; i++) { s += f[i + j * g.NL] * c; n += c; }
  }
  return s / n;
};

console.log("\nyr   Tinst   Tann    albedo  surfAlb cloudAlb cover  ice%   snow%   absorbed");
let m = 0;
for (let yr = 0; yr <= years; yr++) {
  const marks = yr === 0 ? 0 : 12;
  for (let n = 0; n < marks; n++) { w.step(1); m++; }
  if (yr % 5 !== 0 && yr !== 1 && yr !== 2 && yr !== 3 && yr !== 0) continue;
  const absorbed = (1361 * (1 - w.albedoGlobal)) / 4;
  console.log(
    String(yr).padStart(3),
    w.tGlobal.toFixed(1).padStart(7),
    (Number.isFinite(w.tGlobalAnnual) ? w.tGlobalAnnual : w.tGlobal).toFixed(1).padStart(7),
    w.albedoGlobal.toFixed(4).padStart(7),
    mean(g.albedoSurf).toFixed(4).padStart(7),
    mean(g.cloudCover ?? new Float32Array(g.n)).toFixed(4).padStart(8),
    mean(g.cloudCover ?? new Float32Array(g.n)).toFixed(3).padStart(6),
    (w.iceAreaFrac * 100).toFixed(1).padStart(6),
    (mean(g.snowCover) * 100).toFixed(1).padStart(7),
    absorbed.toFixed(1).padStart(9),
  );
}
