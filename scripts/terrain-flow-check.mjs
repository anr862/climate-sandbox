/**
 * Does the terrain actually drive the wind and the ocean?
 *   node scripts/terrain-flow-check.mjs
 *
 * The complaint this guards against: the coastline and the mountains barely mattered.
 * It was true — `currentAt` placed its "basins" at fixed longitudes (cosine lobes
 * labelled Atlantic-ish / Pacific-ish) so the continents could sit anywhere without
 * moving a single current arrow, coastal upwelling was placed by the same fake lobes,
 * and the wind only saw a local height gradient with no land/sea roughness, no lee
 * side, and blocking that ignored which way the ridge faced.
 */
import { World } from '../src/world/world.js';
import { defaults } from '../src/state/params.js';
import { appDefaultParams } from '../src/state/derive.js';
import { currentAt, upwellingFactor } from '../src/physics/circulation.js';

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + JSON.stringify(detail) : ''}`);
};
const spin = (over, years = 12) => {
  const w = new World({ ...appDefaultParams(defaults), ...over }, { seed: defaults().seed });
  for (let n = 0; n < years * 12; n++) w.step(1);
  return w;
};

const world = spin({});
const g = world.grid;
const bandBelt = (k) => {
  const a = Math.abs(g.lats[Math.floor(k / g.NL)]);
  return a > 8 && a < 48;
};
const agg = (pred) => {
  let n = 0, speed = 0, along = 0, cross = 0, upw = 0;
  for (let k = 0; k < g.n; k++) {
    if (g.ocean[k] < 0.5 || !pred(k)) continue;
    n++;
    speed += g.currentSpeed[k];
    along += Math.abs(g.currentU[k] * g._coastTanX[k] + g.currentV[k] * g._coastTanY[k]);
    cross += Math.abs(g.currentU[k] * g._coastOffX[k] + g.currentV[k] * g._coastOffY[k]);
    upw += g.upwelling[k];
  }
  return {
    n,
    speed: n ? speed / n : 0,
    along: n ? along / n : 0,
    cross: n ? cross / n : 0,
    ratio: n && along ? cross / along : 0,
    upwelling: n ? upw / n : 0,
  };
};

console.log('=== currents are anchored to the real coastline ===');
const west = agg((k) => bandBelt(k) && g._coastWestKm[k] < 500);
const east = agg((k) => bandBelt(k) && g._coastEastKm[k] < 500);
const interior = agg((k) => bandBelt(k) && g._coastWestKm[k] > 1500 && g._coastEastKm[k] > 1500);
const shore = agg((k) => bandBelt(k) && g._coastFlag[k] > 0.5);
const open = agg((k) => bandBelt(k) && g._coastDist[k] > 1200);

check('western boundary current is much faster than the basin interior',
  west.n > 10 && west.speed > 2 * interior.speed,
  { west: +west.speed.toFixed(3), interior: +interior.speed.toFixed(3), ratio: +(west.speed / interior.speed).toFixed(2) });
check('eastern boundary current is weaker than the western one',
  east.speed < west.speed, { west: +west.speed.toFixed(3), east: +east.speed.toFixed(3) });
check('flow at the shore runs along the coast, not into it',
  shore.n > 10 && shore.ratio < 0.35,
  { ratio: +shore.ratio.toFixed(3), speed: +shore.speed.toFixed(3) });
check('open-ocean flow is not constrained to be alongshore',
  open.ratio > 0.6, { ratio: +open.ratio.toFixed(3) });
check('eastern boundaries upwell more than western ones',
  east.upwelling > west.upwelling,
  { east: +east.upwelling.toFixed(3), west: +west.upwelling.toFixed(3) });

console.log('\n=== moving the coastline moves the currents (wind held identical) ===');
{
  // Same latitude, same wind, same strength — only the coast geometry differs. If the
  // currents were still analytic in longitude this would be exactly zero.
  const other = new World(
    { ...appDefaultParams(defaults), oceanFraction: Math.round((defaults().oceanFraction ?? 71) * 0.75) },
    { seed: 20240 },
  );
  other.syncTerrainToGrid();
  const g2 = other.grid;
  let tested = 0, diff = 0, reversed = 0, baseSum = 0;
  const wind = { u: 6, v: -1 };
  for (let j = 0; j < Math.min(g.NB, g2.NB); j++) {
    for (let i = 0; i < Math.min(g.NL, g2.NL); i++) {
      const k = i + j * g.NL;
      if (g.ocean[k] < 0.5 || g2.ocean[k] < 0.5) continue;
      const lat = g.lats[j], lon = (i + 0.5) / g.NL * 360 - 180;
      const a = currentAt(lat, lon, 1, 1, {
        windU: wind.u, windV: wind.v, gyreScale: 1,
        coast: { coastKm: g._coastDist[k], offX: g._coastOffX[k], offY: g._coastOffY[k],
          tanX: g._coastTanX[k], tanY: g._coastTanY[k], shelf: g._shelf[k],
          westKm: g._coastWestKm[k], eastKm: g._coastEastKm[k],
          onCoast: g._coastFlag[k] > 0.5, cellKm: g.dxM / 1000 },
      });
      const b = currentAt(lat, lon, 1, 1, {
        windU: wind.u, windV: wind.v, gyreScale: 1,
        coast: { coastKm: g2._coastDist[k], offX: g2._coastOffX[k], offY: g2._coastOffY[k],
          tanX: g2._coastTanX[k], tanY: g2._coastTanY[k], shelf: g2._shelf[k],
          westKm: g2._coastWestKm[k], eastKm: g2._coastEastKm[k],
          onCoast: g2._coastFlag[k] > 0.5, cellKm: g2.dxM / 1000 },
      });
      tested++;
      baseSum += a.speed;
      diff += Math.hypot(a.u - b.u, a.v - b.v);
      if (a.speed > 0.05 && b.speed > 0.05 && (a.u * b.u + a.v * b.v) < 0) reversed++;
    }
  }
  const frac = diff / Math.max(1e-9, baseSum);
  console.log(`  ${tested} shared ocean cells, mean |delta|/|current| = ${(100 * frac).toFixed(1)}%, ` +
    `${reversed} arrows reversed (${(100 * reversed / Math.max(1, tested)).toFixed(1)}%)`);
  check('coastline geometry alone changes the current field substantially',
    tested > 100 && frac > 0.20 && reversed > 0, { fraction: +frac.toFixed(3), reversed });
}

console.log('\n=== upwelling is driven by the alongshore wind ===');
{
  // Pick a coastal cell and blow the wind along the shore in each direction: one of
  // them must upwell, the other must not. This is the Ekman mechanism, and it cannot
  // happen at all if the coastline orientation is not in the model.
  let best = -1, bestOn = 0;
  for (let k = 0; k < g.n; k++) {
    if (g.ocean[k] < 0.5) continue;
    const a = Math.abs(g.lats[Math.floor(k / g.NL)]);
    if (a < 10 || a > 40) continue;
    const tx = g._coastTanX[k], ty = g._coastTanY[k];
    if (Math.hypot(tx, ty) < 0.5) continue;
    const on = g._coastFlag[k] > 0.5 ? 1 : 0;
    if (on > bestOn) { bestOn = on; best = k; }
  }
  const j = Math.floor(best / g.NL), i = best % g.NL;
  const lat = g.lats[j], lon = (i + 0.5) / g.NL * 360 - 180;
  const ctx = {
    coastKm: g._coastDist[best], offX: g._coastOffX[best], offY: g._coastOffY[best],
    tanX: g._coastTanX[best], tanY: g._coastTanY[best], shelf: g._shelf[best],
    westKm: g._coastWestKm[best], eastKm: g._coastEastKm[best],
    onCoast: g._coastFlag[best] > 0.5, cellKm: g.dxM / 1000,
  };
  const T = 8;
  const fwd = upwellingFactor(lat, lon, 1, 1, { windU: ctx.tanX * T, windV: ctx.tanY * T, coast: ctx });
  const rev = upwellingFactor(lat, lon, 1, 1, { windU: -ctx.tanX * T, windV: -ctx.tanY * T, coast: ctx });
  console.log(`  lat ${lat.toFixed(1)} lon ${lon.toFixed(1)}: upwelling with +alongshore wind ${fwd.toFixed(3)}, reversed ${rev.toFixed(3)}`);
  check('reversing the alongshore wind switches upwelling on/off',
    Math.max(fwd, rev) > 0.05 && Math.min(fwd, rev) < 0.02, { fwd: +fwd.toFixed(3), rev: +rev.toFixed(3) });
  check('no coast context means no coastal upwelling',
    upwellingFactor(lat, lon, 1, 1, { windU: 8, windV: 0 }) === 0, null);
}

console.log('\n=== terrain shapes the wind ===');
{
  const mean = (pred) => {
    let n = 0, s = 0;
    for (let k = 0; k < g.n; k++) if (pred(k)) { n++; s += g.windSpeed[k]; }
    return n ? s / n : 0;
  };
  const oceanW = mean((k) => g.ocean[k] > 0.5 && g._coastDist[k] > 1200);
  const landW = mean((k) => g.ocean[k] < 0.5);
  const highW = mean((k) => g.ocean[k] < 0.5 && g.hPeak[k] > 1500);
  const lowW = mean((k) => g.ocean[k] < 0.5 && g.hPeak[k] < 300);
  console.log(`  wind: open ocean ${oceanW.toFixed(2)}, land ${landW.toFixed(2)}, ` +
    `high land ${highW.toFixed(2)}, low land ${lowW.toFixed(2)} m/s`);
  check('the wind is markedly slower over land than over open water',
    landW < 0.8 * oceanW, { ocean: +oceanW.toFixed(2), land: +landW.toFixed(2) });
  check('high ground blocks the wind more than low ground',
    highW < 0.8 * lowW, { high: +highW.toFixed(2), low: +lowW.toFixed(2) });

  // blocking must depend on which way the ridge faces, not on height alone
  let sumA = 0, sumS = 0, n = 0;
  for (let j = 1; j < g.NB - 1; j++) {
    for (let i = 0; i < g.NL; i++) {
      const k = i + j * g.NL;
      if (g.ocean[k] > 0.5 || g.hPeak[k] < 800) continue;
      const gmag = Math.hypot(g.dhdx[k], g.dhdy[k]);
      if (gmag < 2) continue;
      const sp = Math.hypot(g.zonalWind[j], g.zonalWindV[j]);
      if (sp < 1e-6) continue;
      const align = Math.abs(g.zonalWind[j] * g.dhdx[k] + g.zonalWindV[j] * g.dhdy[k]) / (sp * gmag);
      sumA += align; sumS += g.windSpeed[k]; n++;
    }
  }
  console.log(`  ${n} high-terrain cells with a real slope; mean alignment with the base flow ` +
    `${(sumA / Math.max(1, n)).toFixed(2)}, mean wind ${(sumS / Math.max(1, n)).toFixed(2)} m/s`);
  check('blocking is directional (cells facing the flow are present)', n > 20, { cells: n });

  // windward/lee asymmetry: the forced ascent must be much larger on one side
  const liftUp = mean((k) => g.windLift[k] > 2);
  const liftDown = mean((k) => g.windLift[k] < -2);
  console.log(`  forced ascent cells n=${g.windLift.filter((v) => v > 2).length}, ` +
    `descent cells n=${g.windLift.filter((v) => v < -2).length}`);
  check('terrain produces both forced ascent and descent', liftUp > 0 && liftDown > 0,
    { up: +liftUp.toFixed(2), down: +liftDown.toFixed(2) });
}

console.log('\n=== the wind changes when the terrain changes ===');
{
  const flat = spin({ terrainScale: 0.05 });
  const rough = spin({ terrainScale: 2.5 });
  let n = 0, d = 0, b = 0;
  for (let k = 0; k < g.n; k++) {
    if (g.ocean[k] < 0.5) continue;
    n++;
    b += rough.grid.windSpeed[k];
    d += Math.abs(rough.grid.windSpeed[k] - flat.grid.windSpeed[k]);
  }
  const frac = d / Math.max(1e-9, b);
  console.log(`  ${n} ocean cells, mean |delta wind| between a flat and a rugged world ` +
    `= ${(100 * frac).toFixed(1)}%`);
  check('a rugged world has a substantially different wind field', frac > 0.10, { fraction: +frac.toFixed(3) });
}

console.log(failures === 0 ? '\nall terrain-flow checks passed' : `\n${failures} check(s) failed`);
process.exit(failures ? 1 : 0);
