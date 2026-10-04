/**
 * Coastline geometry, derived from the actual terrain.
 *
 * Why this exists: the ocean-current model used to place its "basins" at fixed
 * longitudes (cosine lobes at lon ≈ −60 and lon ≈ +150 labelled "Atlantic-ish" and
 * "Pacific-ish"). Those lobes had nothing to do with the generated terrain, so the
 * continents could sit anywhere and the currents would not move — the coastline had
 * essentially *no* influence on the ocean. The same fake basins placed coastal
 * upwelling. Meanwhile the wind field only ever saw a local height gradient, with no
 * notion of which side of a ridge it was on.
 *
 * Everything here is computed from the climate grid's water mask (`grid.ocean`) and
 * height (`grid.h`), which `World.syncTerrainToGrid()` rebuilds whenever the terrain
 * changes, so the circulation follows the terrain the user actually sees — including
 * terrain painted in the terrain editor.
 *
 * Produced per climate cell:
 *   coastKm    distance to the nearest coast (0 on land) — the alongshore/offshore scale
 *   offX/offY  unit vector pointing *offshore* (from land into open water)
 *   tanX/tanY  unit vector along the coast (perpendicular to offshore)
 *   shelf      1 at the coast decaying over ~250 km, 0 on land (shallow-water friction)
 *   westKm     distance to the nearest land looking west  (small ⇒ western boundary of a basin)
 *   eastKm     distance to the nearest land looking east  (small ⇒ eastern boundary)
 *   coastFlag  1 for water cells touching land
 */

const EARTH_RADIUS_M = 6371000;
/** Offshore scale of the shelf/coastal-jet influence, km. */
export const SHELF_SCALE_KM = 250;

const INF = 1e9;

/**
 * Two-pass chamfer distance transform to the nearest land cell, in km.
 *
 * Anisotropic because a degree of longitude shrinks with latitude: each row uses
 * dx = dxM·cosφ for the zonal step and dyM for the meridional one, so a "distance"
 * is a real ground distance rather than a cell count.
 */
function distanceToLand(grid) {
  const { NB, NL, n, ocean, lats, dxM, dyM } = grid;
  const out = grid._coastDist || (grid._coastDist = new Float32Array(n));
  const cosLat = grid.cosLat;
  for (let k = 0; k < n; k++) out[k] = ocean[k] > 0.5 ? INF : 0;

  const wrap = (i) => ((i % NL) + NL) % NL;

  // forward: north→south, west→east  (uses N/S/W and the two northern diagonals)
  for (let j = 0; j < NB; j++) {
    const dx = Math.max(1, dxM * cosLat[j]) / 1000;
    const dy = dyM / 1000;
    const diag = Math.hypot(dx, dy);
    for (let i = 0; i < NL; i++) {
      const k = i + j * NL;
      if (out[k] === 0) continue;
      let best = out[k];
      const w = wrap(i - 1) + j * NL;
      if (out[w] + dx < best) best = out[w] + dx;
      if (j > 0) {
        const nn = i + (j - 1) * NL;
        if (out[nn] + dy < best) best = out[nn] + dy;
        const nw = wrap(i - 1) + (j - 1) * NL;
        if (out[nw] + diag < best) best = out[nw] + diag;
        const ne = wrap(i + 1) + (j - 1) * NL;
        if (out[ne] + diag < best) best = out[ne] + diag;
      }
      out[k] = best;
    }
  }
  // backward: south→north, east→west
  for (let j = NB - 1; j >= 0; j--) {
    const dx = Math.max(1, dxM * cosLat[j]) / 1000;
    const dy = dyM / 1000;
    const diag = Math.hypot(dx, dy);
    for (let i = NL - 1; i >= 0; i--) {
      const k = i + j * NL;
      if (out[k] === 0) continue;
      let best = out[k];
      const e = wrap(i + 1) + j * NL;
      if (out[e] + dx < best) best = out[e] + dx;
      if (j < NB - 1) {
        const ss = i + (j + 1) * NL;
        if (out[ss] + dy < best) best = out[ss] + dy;
        const se = wrap(i + 1) + (j + 1) * NL;
        if (out[se] + diag < best) best = out[se] + diag;
        const sw = wrap(i - 1) + (j + 1) * NL;
        if (out[sw] + diag < best) best = out[sw] + diag;
      }
      out[k] = best;
    }
  }
  for (let k = 0; k < n; k++) if (out[k] > INF) out[k] = 0;
  return out;
}

/**
 * Zonal distance to the nearest land, scanning one way around the latitude circle.
 * Run twice around so the wrap is handled without a separate fix-up pass.
 *
 * `dir = -1` scans west (decreasing longitude) → the result is small for cells on the
 * **western boundary** of an ocean basin (land lies to their west, e.g. the Gulf
 * Stream off North America). `dir = +1` scans east → eastern boundaries
 * (California / Peru / Canary / Benguela).
 */
function zonalLandDistance(grid, dir, into) {
  const { NB, NL, n, ocean, dxM } = grid;
  const cosLat = grid.cosLat;
  for (let j = 0; j < NB; j++) {
    const dx = Math.max(1, dxM * cosLat[j]) / 1000;
    const base = j * NL;
    for (let i = 0; i < NL; i++) into[base + i] = ocean[base + i] > 0.5 ? INF : 0;
    // two sweeps in the scan direction take care of the periodic wrap
    for (let pass = 0; pass < 2; pass++) {
      for (let s = 0; s < NL; s++) {
        const i = dir < 0 ? s : NL - 1 - s;
        const prevI = dir < 0
          ? (i === 0 ? NL - 1 : i - 1)
          : (i === NL - 1 ? 0 : i + 1);
        const k = base + i, prev = base + prevI;
        if (into[k] === 0) continue;
        const cand = into[prev] + dx;
        if (cand < into[k]) into[k] = cand;
      }
    }
    for (let i = 0; i < NL; i++) if (into[base + i] > INF) into[base + i] = INF / 1000;
  }
  return into;
}

/**
 * Distance to the nearest *coastline* (not to land), in km, defined on both sides —
 * 0 on a cell that touches the sea/land boundary, positive inland and offshore.
 *
 * `coastKm` can only measure distance from water, so it is 0 across the whole
 * continent; that makes it useless for anything symmetric about the shore (the sea
 * breeze, for instance, must be strongest right at the coast on *both* sides and
 * decay away in each direction).
 */
function shoreDistance(grid, coastFlag) {
  const { NB, NL, n, lats, dxM, dyM } = grid;
  const out = grid._shoreKm || (grid._shoreKm = new Float32Array(n));
  for (let k = 0; k < n; k++) out[k] = coastFlag[k] > 0.5 ? 0 : INF;
  const wrap = (i) => ((i % NL) + NL) % NL;
  for (let j = 0; j < NB; j++) {
    const dx = Math.max(1, dxM * grid.cosLat[j]) / 1000;
    const dy = dyM / 1000;
    const diag = Math.hypot(dx, dy);
    for (let i = 0; i < NL; i++) {
      const k = i + j * NL;
      let best = out[k];
      if (out[wrap(i - 1) + j * NL] + dx < best) best = out[wrap(i - 1) + j * NL] + dx;
      if (j > 0) {
        if (out[i + (j - 1) * NL] + dy < best) best = out[i + (j - 1) * NL] + dy;
        if (out[wrap(i - 1) + (j - 1) * NL] + diag < best) best = out[wrap(i - 1) + (j - 1) * NL] + diag;
        if (out[wrap(i + 1) + (j - 1) * NL] + diag < best) best = out[wrap(i + 1) + (j - 1) * NL] + diag;
      }
      out[k] = best;
    }
  }
  for (let j = NB - 1; j >= 0; j--) {
    const dx = Math.max(1, dxM * grid.cosLat[j]) / 1000;
    const dy = dyM / 1000;
    const diag = Math.hypot(dx, dy);
    for (let i = NL - 1; i >= 0; i--) {
      const k = i + j * NL;
      let best = out[k];
      if (out[wrap(i + 1) + j * NL] + dx < best) best = out[wrap(i + 1) + j * NL] + dx;
      if (j < NB - 1) {
        if (out[i + (j + 1) * NL] + dy < best) best = out[i + (j + 1) * NL] + dy;
        if (out[wrap(i + 1) + (j + 1) * NL] + diag < best) best = out[wrap(i + 1) + (j + 1) * NL] + diag;
        if (out[wrap(i - 1) + (j + 1) * NL] + diag < best) best = out[wrap(i - 1) + (j + 1) * NL] + diag;
      }
      out[k] = best;
    }
  }
  for (let k = 0; k < n; k++) if (out[k] > INF) out[k] = 0;
  return out;
}

/**
 * Build (or refresh) every coastline field on the grid. Cheap enough to run whenever
 * the terrain changes — two linear passes plus two zonal scans — and deliberately not
 * run every simulation step.
 */
export function buildCoastFields(grid) {
  const { NB, NL, n, ocean, lats } = grid;
  const coastKm = distanceToLand(grid);

  const offX = grid._coastOffX || (grid._coastOffX = new Float32Array(n));
  const offY = grid._coastOffY || (grid._coastOffY = new Float32Array(n));
  const tanX = grid._coastTanX || (grid._coastTanX = new Float32Array(n));
  const tanY = grid._coastTanY || (grid._coastTanY = new Float32Array(n));
  const shelf = grid._shelf || (grid._shelf = new Float32Array(n));
  const coastFlag = grid._coastFlag || (grid._coastFlag = new Float32Array(n));
  const westKm = grid._coastWestKm || (grid._coastWestKm = new Float32Array(n));
  const eastKm = grid._coastEastKm || (grid._coastEastKm = new Float32Array(n));

  zonalLandDistance(grid, -1, westKm);
  zonalLandDistance(grid, +1, eastKm);

  // Offshore normal = direction of increasing distance-to-coast, i.e. the gradient of
  // coastKm. On the coast itself that points straight out to sea, which is what the
  // upwelling and coastal-jet terms need.
  for (let j = 0; j < NB; j++) {
    const dx = Math.max(1, grid.dxM * grid.cosLat[j]);
    const dy = grid.dyM;
    for (let i = 0; i < NL; i++) {
      const k = i + j * NL;
      const isSea = ocean[k] > 0.5;
      if (!isSea) {
        offX[k] = 0; offY[k] = 0; tanX[k] = 0; tanY[k] = 0;
        shelf[k] = 0; coastFlag[k] = 0;
        continue;
      }
      const e = ((i + 1) % NL) + j * NL;
      const w = ((i - 1 + NL) % NL) + j * NL;
      const nn = i + Math.max(0, j - 1) * NL;
      const ss = i + Math.min(NB - 1, j + 1) * NL;
      let gx = (coastKm[e] - coastKm[w]) / (2 * dx);
      let gy = (coastKm[nn] - coastKm[ss]) / (2 * dy);
      const gm = Math.hypot(gx, gy);
      if (gm > 1e-12) { gx /= gm; gy /= gm; } else { gx = 0; gy = 0; }
      offX[k] = gx; offY[k] = gy;
      // tangent: rotate the offshore normal 90° (either sign; callers pick a sense)
      tanX[k] = -gy; tanY[k] = gx;

      const d = coastKm[k];
      shelf[k] = Math.exp(-d / SHELF_SCALE_KM);
      // a cell "on the coast" has land within roughly one cell
      const near = Math.min(dx, dy) / 1000 * 1.25;
      const touchesLand = ocean[e] < 0.5 || ocean[w] < 0.5 ||
        (j > 0 && ocean[nn] < 0.5) || (j < NB - 1 && ocean[ss] < 0.5);
      coastFlag[k] = touchesLand || d <= near ? 1 : 0;
    }
  }
  grid.coastReady = true;
  shoreDistance(grid, coastFlag);
  return grid;
}

/**
 * Terrain context for one cell, or null when the cell is land / the fields are not
 * built yet. Small enough to allocate per call; the circulation code is O(n) anyway.
 */
export function coastAt(grid, k) {
  if (!grid.coastReady || grid.ocean[k] < 0.5) return null;
  return {
    coastKm: grid._coastDist[k],
    offX: grid._coastOffX[k], offY: grid._coastOffY[k],
    tanX: grid._coastTanX[k], tanY: grid._coastTanY[k],
    shelf: grid._shelf[k],
    westKm: grid._coastWestKm[k], eastKm: grid._coastEastKm[k],
    onCoast: grid._coastFlag[k] > 0.5,
    /** Distance to the nearest coastline, defined inland too (sea-breeze decay). */
    shoreKm: grid._shoreKm ? grid._shoreKm[k] : 0,
    /** Equatorial cell width in km — lets callers tell "one cell offshore" from "500 km". */
    cellKm: grid.dxM / 1000,
  };
}

/** Mean distance-to-coast over the ocean, used by checks and diagnostics. */
export function meanCoastDistance(grid) {
  let s = 0, w = 0;
  for (let j = 0; j < grid.NB; j++) {
    for (let i = 0; i < grid.NL; i++) {
      const k = i + j * grid.NL;
      if (grid.ocean[k] < 0.5) continue;
      s += grid._coastDist[k] * grid.areaFrac[j];
      w += grid.areaFrac[j];
    }
  }
  return w > 0 ? s / w : 0;
}
