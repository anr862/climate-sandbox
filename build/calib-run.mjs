/**
 * Calibrates BASE.tauRef for the Earth default and reports the distance to the
 * snowball bifurcation, for one value of the ice-edge transition width.
 *
 *   node build/calib-run.mjs <coverWidth> <targetK> <years>
 *
 * The script edits no source: it monkey-patches nothing either, so COVER_WIDTH has
 * to be passed in by the caller having already set it. It only finds tauRef.
 */
import { World } from "../src/world/world.js";
import { defaults } from "../src/state/params.js";
import { appDefaultParams } from "../src/state/derive.js";
import { BASE } from "../src/physics/climate.js";

const target = Number(process.argv[2] ?? 288.15);
const years = Number(process.argv[3] ?? 25);

function spin(tau) {
  BASE.tauRef = tau;
  // The world the APP actually boots (humidity 78 / cloud 68.2), not defaults()
  // with a hand-patched cloud — that mistake is what this whole script exists to
  // avoid now. See src/state/derive.js.
  const w = new World(appDefaultParams(defaults), { seed: defaults().seed });
  for (let m = 0; m < years * 12; m++) w.step(1);
  return w;
}

console.log(`target ${target} K over ${years} yr`);
// tauRef up => more OLR => colder, so bisect with the sense inverted
let lo = 0.52, hi = 0.72;
for (let it = 0; it < 7; it++) {
  const mid = (lo + hi) / 2;
  const w = spin(mid);
  const t = w.tGlobalAnnual;
  console.log(`  tau=${mid.toFixed(5)}  T=${t.toFixed(2)}  alb=${w.albedoGlobal.toFixed(4)}  ice=${(w.iceAreaFrac * 100).toFixed(2)}%`);
  if (t > target) lo = mid; else hi = mid;
  if (Math.abs(t - target) < 0.03) break;
}
const tauStar = (lo + hi) / 2;
const w = spin(tauStar);
console.log(`\nCAL tauRef=${tauStar.toFixed(5)}  T=${w.tGlobalAnnual.toFixed(3)}  alb=${w.albedoGlobal.toFixed(4)}  ` +
  `ice=${(w.iceAreaFrac * 100).toFixed(2)}%  rain=${w.metrics().precip.toFixed(1)}mm/mo  ` +
  `absorbed=${((1361 * (1 - w.albedoGlobal)) / 4).toFixed(1)} W/m2`);

// walk up in tau to find where the warm branch is lost
console.log("\ncliff search (warm branch is lost when T falls below 275 K):");
let cliff = null;
for (const tau of [tauStar + 0.01, tauStar + 0.02, tauStar + 0.03, tauStar + 0.04, tauStar + 0.05, tauStar + 0.06]) {
  const q = spin(tau);
  const ok = q.tGlobalAnnual > 275;
  console.log(`  tau=${tau.toFixed(4)} (+${(tau - tauStar).toFixed(3)})  T=${q.tGlobalAnnual.toFixed(2)}  ` +
    `alb=${q.albedoGlobal.toFixed(4)}  ice=${(q.iceAreaFrac * 100).toFixed(1)}%  ${ok ? "warm" : "COLLAPSED"}`);
  if (!ok && cliff === null) cliff = tau;
}
if (cliff) {
  const dw = spin(cliff);
  const lostW = (1361 * dw.albedoGlobal) / 4 - (1361 * w.albedoGlobal) / 4;
  console.log(`\nmargin before runaway: dtau=${(cliff - tauStar).toFixed(4)}  ` +
    `extra reflected sunlight=${lostW.toFixed(1)} W/m2  (${((lostW / ((1361 * (1 - w.albedoGlobal)) / 4)) * 100).toFixed(1)}% of absorbed)`);
} else {
  console.log("\nmargin: no collapse within +0.06 tau");
}
