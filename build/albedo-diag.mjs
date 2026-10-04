import { World } from "../src/world/world.js";
import { defaults } from "../src/state/params.js";
import { BASE, cloudAlbedoAt } from "../src/physics/climate.js";

const years = Number(process.argv[2] ?? 30);
const keep = BASE.tauRef;

function stats(f, NB, NL) {
  let s = 0, n = 0, mn = 1e9, mx = -1e9;
  for (let j = 0; j < NB; j++) {
    const wt = Math.cos(((-90 + (j + 0.5) * (180 / NB)) * Math.PI) / 180);
    for (let i = 0; i < NL; i++) {
      const v = f[j * NL + i];
      s += v * wt; n += wt;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
  }
  return { mean: s / n, min: mn, max: mx };
}

for (const tau of [0.5755, 0.62]) {
  BASE.tauRef = tau;
  const p = { ...defaults() };
  p.cloud = Math.min(96, 12 + p.humidity * 0.72);
  const w = new World(p, { seed: 20240 });
  for (let m = 0; m < years * 12; m++) w.step(1);
  const g = w.grid, NB = g.NB, NL = g.NL;
  const cover = g.cloudCover;
  const ca = new Float32Array(cover.length);
  for (let k = 0; k < cover.length; k++) ca[k] = cloudAlbedoAt(cover[k]);
  const S = stats(g.albedoSurf, NB, NL), C = stats(cover, NB, NL), CA = stats(ca, NB, NL);
  const A = stats(g.albedo, NB, NL);
  console.log(`\n--- tauRef=${tau}  T=${w.tGlobalAnnual.toFixed(2)} K ---`);
  console.log(`  p.cloud (global param)   ${p.cloud.toFixed(2)}`);
  console.log(`  cloudCover  mean ${C.mean.toFixed(3)}  min ${C.min.toFixed(3)} max ${C.max.toFixed(3)}`);
  console.log(`  cloudAlbedo mean ${CA.mean.toFixed(4)}   (CLOUD_ALBEDO_MAX=${0.32})`);
  console.log(`  albedoSurf  mean ${S.mean.toFixed(4)}`);
  console.log(`  albedo total mean ${A.mean.toFixed(4)}   (world.albedoGlobal ${w.albedoGlobal.toFixed(4)})`);
  console.log(`  check a*(1-c)+c = ${(S.mean * (1 - CA.mean) + CA.mean).toFixed(4)}`);
  console.log(`  absorbed = ${(1361 * (1 - A.mean) / 4).toFixed(1)} W/m2   OLR = ${(w.tau * 5.670374419e-8 * Math.pow(w.tGlobalAnnual, 4)).toFixed(1)}`);
  // what would the albedo be with a different overcast-cell cloud albedo?
  for (const camax of [0.36, 0.40, 0.44]) {
    let sa = 0, sn = 0;
    for (let j = 0; j < NB; j++) {
      const wt = Math.cos(((-90 + (j + 0.5) * (180 / NB)) * Math.PI) / 180);
      for (let i = 0; i < NL; i++) {
        const k = j * NL + i;
        const c = Math.min(1.5, ca[k] / 0.32) * camax;
        sa += (g.albedoSurf[k] * (1 - c) + c) * wt; sn += wt;
      }
    }
    console.log(`  if CLOUD_ALBEDO_MAX=${camax.toFixed(2)} -> albedo ${(sa / sn).toFixed(4)}`);
  }
}
BASE.tauRef = keep;
