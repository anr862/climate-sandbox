/**
 * Ocean-current mask check — node scripts/current-check.mjs
 *
 * Currents exist only in water. They are defined on the coarse climate grid
 * (3.75° cells) while arrows are drawn on the fine terrain grid, so a bilinear
 * sample used to drag ocean speeds a whole climate cell inland and the arrows
 * appeared over continents. This verifies the terrain-level mask.
 */
import { World } from '../src/world/world.js';
import { defaults } from '../src/state/params.js';
import { oceanFractionAt } from '../src/physics/derived.js';

const w = new World({ ...defaults() }, { seed: 20240 });
for (let n = 0; n < 120; n++) w.step(1);

let landSamples = 0, landWithCurrent = 0, worstLand = 0, worstLandAt = null;
let oceanSamples = 0, oceanWithCurrent = 0, maxOcean = 0;
let gridLandLeak = 0;

for (let j = 0; j < w.terrain.GY; j++) {
  const lat = 90 - (j + 0.5) / w.terrain.GY * 180;
  for (let i = 0; i < w.terrain.GX; i += 2) {
    const lon = (i + 0.5) / w.terrain.GX * 360 - 180;
    const oc = oceanFractionAt(w, lat, lon);
    const v = w.layerVector('currentSpeed', lat, lon);
    const speed = v ? v.speed : 0;
    if (oc < 0.25) {
      landSamples++;
      if (speed > 0.002) { landWithCurrent++; if (speed > worstLand) { worstLand = speed; worstLandAt = { lat: +lat.toFixed(1), lon: +lon.toFixed(1), oc: +oc.toFixed(2) }; } }
    } else if (oc > 0.75) {
      oceanSamples++;
      if (speed > 0.01) oceanWithCurrent++;
      if (speed > maxOcean) maxOcean = speed;
    }
  }
}

// the raw climate-grid field is the thing that used to leak
for (let j = 0; j < w.grid.NB; j++) {
  for (let i = 0; i < w.grid.NL; i++) {
    const k = i + j * w.grid.NL;
    if (w.grid.ocean[k] < 0.5 && w.grid.currentSpeed[k] > 1e-6) gridLandLeak++;
  }
}

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + JSON.stringify(detail) : ''}`);
};

check('climate-grid current field is zero on land', gridLandLeak === 0, { leakingCells: gridLandLeak });
check('no current arrows over land', landWithCurrent === 0,
  { landSamples, landWithCurrent, worst: +worstLand.toFixed(4), at: worstLandAt });
check('currents are present in the ocean',
  oceanWithCurrent > oceanSamples * 0.5 && maxOcean > 0.1,
  { oceanSamples, oceanWithCurrent, maxSpeed: +maxOcean.toFixed(3) });

// wind must still cover land and sea
let windLand = 0, windOcean = 0;
for (let j = 0; j < 12; j++) {
  const lat = 90 - (j + 0.5) / 12 * 180;
  for (let i = 0; i < 12; i++) {
    const lon = (i + 0.5) / 12 * 360 - 180;
    const v = w.layerVector('windSpeed', lat, lon);
    if (oceanFractionAt(w, lat, lon) < 0.25) windLand += v.speed; else windOcean += v.speed;
  }
}
check('wind layer is unaffected by the ocean mask', windLand > 0 && windOcean > 0,
  { meanOverLand: +(windLand / 72).toFixed(2), meanOverOcean: +(windOcean / 72).toFixed(2) });

// scalar 洋流 layer is masked too
let scalarLand = 0;
for (let j = 0; j < w.terrain.GY; j += 3) {
  const lat = 90 - (j + 0.5) / w.terrain.GY * 180;
  for (let i = 0; i < w.terrain.GX; i += 3) {
    const lon = (i + 0.5) / w.terrain.GX * 360 - 180;
    if (oceanFractionAt(w, lat, lon) >= 0.25) continue;
    if (w.layerData('currentSpeed')[j * w.terrain.GX + i] > 0.002) scalarLand++;
  }
}
check('scalar 洋流 layer is zero on land', scalarLand === 0, { cells: scalarLand });

/* --- no holes in open water --------------------------------------------- */
{
  // Shelf seas and archipelagos can sit inside a climate cell that the coarse
  // grid classifies as land; those used to be blank patches with no arrows.
  let deep = 0, deepWith = 0, firstGap = null;
  for (let j = 1; j < w.grid.NB - 1; j++) {
    for (let i = 0; i < w.grid.NL; i++) {
      const k = i + j * w.grid.NL;
      if (w.grid.ocean[k] < 0.5) continue;          // fully-ocean climate cells only
      deep++;
      const lat = w.grid.lats[j];
      const lon = (i + 0.5) / w.grid.NL * 360 - 180;
      const v = w.layerVector('currentSpeed', lat, lon);
      if (v && v.speed > 0.02) deepWith++;
      else if (!firstGap) firstGap = { lat: +lat.toFixed(1), lon: +lon.toFixed(1) };
    }
  }
  check('open-ocean cells all carry a current', deepWith > deep * 0.9,
    { deep, deepWith, firstGap });

  let shelf = 0, shelfWith = 0;
  for (let j = 0; j < w.terrain.GY; j += 2) {
    const lat = 90 - (j + 0.5) / w.terrain.GY * 180;
    for (let i = 0; i < w.terrain.GX; i += 2) {
      const lon = (i + 0.5) / w.terrain.GX * 360 - 180;
      if (oceanFractionAt(w, lat, lon) < 0.9) continue;
      shelf++;
      const v = w.layerVector('currentSpeed', lat, lon);
      if (v && v.speed > 0.02) shelfWith++;
    }
  }
  check('open water never has arrow gaps', shelfWith > shelf * 0.9,
    { samples: shelf, withCurrent: shelfWith });
}

/* --- terrain and wind reach the flow fields ------------------------------ */
{
  const grid = w.grid;
  let liftSum = 0, liftMax = 0;
  for (let k = 0; k < grid.n; k++) {
    liftSum += Math.abs(grid.windLift[k]);
    liftMax = Math.max(liftMax, Math.abs(grid.windLift[k]));
  }
  check('terrain produces orographic lift', liftSum / grid.n > 0.5 && liftMax > 5,
    { meanAbsLift: +(liftSum / grid.n).toFixed(2), maxLift: +liftMax.toFixed(1) });

  const withWind = w.currentSpeedMean;
  const uBefore = Float32Array.from(w.grid.currentU);
  const saved = w.params.atmosphericCirculation;
  w.params.atmosphericCirculation = 0;
  for (let n = 0; n < 3; n++) w.step(1);
  const noWind = w.currentSpeedMean;
  let diff = 0, n2 = 0;
  for (let k = 0; k < w.grid.n; k++) {
    if (w.grid.ocean[k] < 0.5) continue;
    diff += Math.abs(w.grid.currentU[k] - uBefore[k]);
    n2++;
  }
  const meanShift = diff / Math.max(1, n2);
  w.params.atmosphericCirculation = saved;
  for (let n = 0; n < 6; n++) w.step(1);
  // Two separate claims, asserted separately:
  //   1. the wind measurably re-shapes the current field (the vector pattern moves);
  //   2. the prescribed gyre stays the dominant term, so the mean *speed* is
  //      essentially unchanged — the Ekman drift is deliberately small
  //      (EKMAN_DRIFT = 0.02) because this model's atmosphere is the main heat pipe.
  // The old form compared mean speeds with an exact `noWind <= withWind`, which
  // flipped at the 4th decimal (both rounded to 0.354) and so failed on rounding
  // noise rather than on anything physical.
  const speedChange = Math.abs(noWind - withWind);
  check('the wind leaves a measurable imprint on the current field',
    meanShift > 0.03 && speedChange < 0.05 * Math.max(1e-6, withWind),
    {
      meanShift: +meanShift.toFixed(3),
      withWind: +withWind.toFixed(4),
      withoutWind: +noWind.toFixed(4),
      meanSpeedChange: +speedChange.toFixed(5),
    });
}

/* --- Ekman drift: magnitude and 45° turning ------------------------------ */
{
  const { currentAt, EKMAN_DRIFT } = await import('../src/physics/circulation.js');
  const calm = currentAt(30, -40, 1, 1, { windU: 0, windV: 0, gyreScale: 1 });
  const east = currentAt(30, -40, 1, 1, { windU: 10, windV: 0, gyreScale: 1 });
  const du = east.u - calm.u, dv = east.v - calm.v;
  const mag = Math.hypot(du, dv);
  const expected = 10 * EKMAN_DRIFT;
  check('eastward wind adds a wind-driven surface drift of the right size',
    Math.abs(mag - expected) < expected * 0.05,
    { added: +mag.toFixed(3), expected: +expected.toFixed(3) });
  check('the drift is 45° to the right of the wind in the north',
    du > 0 && dv < 0 && Math.abs(Math.abs(du) - Math.abs(dv)) < 0.01 * mag * 0.2 + 1e-6,
    { du: +du.toFixed(3), dv: +dv.toFixed(3) });

  const south = currentAt(-30, -40, 1, 1, { windU: 10, windV: 0, gyreScale: 1 });
  check('the drift turns the other way south of the equator', (south.v - calm.v) > 0,
    { dv: +(south.v - calm.v).toFixed(3) });
}

/* --- habitability is a land-only index ---------------------------------- */
{
  const grid = w.grid;
  let oceanHab = 0, landHab = 0, landN = 0;
  for (let k = 0; k < grid.n; k++) {
    if (grid.ocean[k] > 0.5) oceanHab += grid.habitability[k];
    else { landN++; landHab += grid.habitability[k]; }
  }
  check('habitability is zero over the ocean and positive on land',
    oceanHab === 0 && landHab / landN > 0.2,
    { oceanSum: oceanHab, landMean: +(landHab / landN).toFixed(3) });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall current-mask checks passed');
process.exit(failures ? 1 : 0);
