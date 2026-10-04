/**
 * Terrain: procedural plate-tectonic heightfield generation, sea-level solving,
 * river flow routing, and (de)serialisation.
 *
 * A planet's heightfield is a GXH equirectangular float grid in metres,
 * relative to a base sea level of 0 m. Rows run north -> south.
 */

import { Rng } from '../core/rng.js';
import { fbm3, ridged2, noise3, clamp, smoothstep } from '../core/noise.js';

/* ------------------------------------------------------------------ */
/* spherical helpers                                                   */
/* ------------------------------------------------------------------ */

export function latLonOf(i, j, GX, GY) {
  const lon = (i + 0.5) / GX * 360 - 180;
  const lat = 90 - (j + 0.5) / GY * 180;
  return { lat, lon };
}

export function unitVec(latDeg, lonDeg) {
  const la = latDeg * Math.PI / 180;
  const lo = lonDeg * Math.PI / 180;
  const cl = Math.cos(la);
  return [cl * Math.cos(lo), cl * Math.sin(lo), Math.sin(la)];
}

/* ------------------------------------------------------------------ */
/* allocation                                                          */
/* ------------------------------------------------------------------ */

export function allocTerrain(GX = 360, GY = 180) {
  return { GX, GY, height: new Float32Array(GX * GY) };
}

/* ------------------------------------------------------------------ */
/* generation                                                          */
/* ------------------------------------------------------------------ */

/**
 * @param {object} o
 *   GX, GY        grid size
 *   seed          integer
 *   plateCount    number of tectonic plates
 *   fragmentation 0..100  (low = solid continents, high = archipelagos)
 *   relief        0..100  continental relief amplitude
 *   seaFloorRelief 0..100 oceanic relief amplitude
 *   oceanTarget   desired ocean area fraction 0..1
 *   minElevation / maxElevation  clamp range in metres
 */
export function generateTerrain(o = {}) {
  const GX = o.GX || 360, GY = o.GY || 180;
  const seed = (o.seed | 0) || 20240;
  const plateCount = Math.max(2, o.plateCount ?? 14);
  const frag = clamp((o.fragmentation ?? 45) / 100, 0, 1);
  const relief = (o.relief ?? 55) / 100;
  const seaRelief = (o.seaFloorRelief ?? 50) / 100;
  const oceanTarget = clamp(o.oceanTarget ?? 0.708, 0.001, 0.999);
  const minE = o.minElevation ?? -11000;
  const maxE = o.maxElevation ?? 9000;

  const rng = new Rng(seed);
  const grid = allocTerrain(GX, GY);
  const H = grid.height;

  /* ---- 1. plate seeds on the unit sphere ---- */
  const sites = [];
  for (let k = 0; k < plateCount; k++) {
    const u = rng.range(-1, 1);
    const th = rng.range(0, Math.PI * 2);
    const r = Math.sqrt(Math.max(0, 1 - u * u));
    sites.push({
      v: [r * Math.cos(th), r * Math.sin(th), u],
      continental: rng.bool(0.42 + 0.35 * (1 - oceanTarget)),
      amp: rng.range(0.55, 1.45),
    });
  }

  /* ---- 2. coarse crust field (Voronoi + boundary crumpling) ---- */
  const CGX = Math.min(GX, 180), CGY = Math.min(GY, 90);
  const cCrust = new Float32Array(CGX * CGY);
  const cEdge = new Float32Array(CGX * CGY);
  const detailFreq = 2.2 + frag * 5.5;
  const edgeNoiseAmp = 0.02 + frag * 0.10;

  for (let j = 0; j < CGY; j++) {
    const lat = 90 - (j + 0.5) / CGY * 180;
    for (let i = 0; i < CGX; i++) {
      const lon = (i + 0.5) / CGX * 360 - 180;
      const [x, y, z] = unitVec(lat, lon);
      let d1 = Infinity, d2 = Infinity, best = 0;
      for (let k = 0; k < sites.length; k++) {
        const s = sites[k];
        const dx = x - s.v[0], dy = y - s.v[1], dz = z - s.v[2];
        const d = dx * dx + dy * dy + dz * dz;
        if (d < d1) { d2 = d1; d1 = d; best = k; }
        else if (d < d2) { d2 = d; }
      }
      const nA = fbm3(x * detailFreq, y * detailFreq, z * detailFreq, seed + 91, 3, 2, 0.5);
      const boundary = Math.sqrt(d2) - Math.sqrt(d1) + (nA - 0.5) * edgeNoiseAmp;
      const interior = clamp(boundary / (0.085 + 0.055 * (1 - frag)), 0, 1);
      const s = sites[best];
      const base = s.continental
        ? -240 + 1850 * s.amp * Math.pow(interior, 0.62)
        : -4200 - 3200 * s.amp * Math.pow(interior, 0.75);
      cCrust[i + j * CGX] = base;
      cEdge[i + j * CGX] = interior;
    }
  }
  blurWrap(cCrust, CGX, CGY, 2);
  blurWrap(cEdge, CGX, CGY, 1);

  /* ---- 3. detail: upsample crust + fractal relief ---- */
  const landAmp = 260 + relief * 2600;
  const seaAmp = 220 + seaRelief * 2400;
  const landF = 1.6 + frag * 1.0;
  const seaF = 1.2 + frag * 0.8;

  for (let j = 0; j < GY; j++) {
    const lat = 90 - (j + 0.5) / GY * 180;
    for (let i = 0; i < GX; i++) {
      const idx = i + j * GX;
      const lon = (i + 0.5) / GX * 360 - 180;
      const [x, y, z] = unitVec(lat, lon);
      const base = bilinearCoarse(cCrust, CGX, CGY, i, j, GX, GY);
      const interior = bilinearCoarse(cEdge, CGX, CGY, i, j, GX, GY);
      const isCont = base > -600;
      const u1 = fbm3(x * 1.1, y * 1.1, z * 1.1, seed + 311, 4, 2, 0.5) - 0.5;
      // ridged belts concentrate along plate margins
      const belt = ridged2(((lon + 180) / 360) * 4.5 * landF, ((lat + 90) / 180) * 4.5 * landF, seed + 733, 4, 4.5 * landF);
      const margin = Math.pow(1 - clamp(interior / 0.45, 0, 1), 2.0);

      let h = base;
      if (isCont) {
        h += u1 * landAmp * 1.35;
        h += belt * landAmp * (0.32 + 0.98 * margin);
        h += (fbm3(x * 9 * landF, y * 9 * landF, z * 9 * landF, seed + 55, 3, 2, 0.5) - 0.5) * landAmp * 0.28;
      } else {
        h += u1 * seaAmp * 1.1;
        h += belt * seaAmp * (0.12 + 0.78 * margin);
        h += (fbm3(x * 7 * seaF, y * 7 * seaF, z * 7 * seaF, seed + 991, 3, 2, 0.5) - 0.5) * seaAmp * 0.22;
      }
      H[idx] = h;
    }
  }

  blurWrap(H, GX, GY, 1);
  normalise(H, minE, maxE);

  const seaLevel = solveSeaLevel(H, oceanTarget);
  for (let k = 0; k < H.length; k++) H[k] -= seaLevel;

  const wm = new Uint8Array(GX * GY);
  for (let k = 0; k < H.length; k++) wm[k] = H[k] < 0 ? 1 : 0;
  grid.waterMask = wm;
  grid.meta = { seaLevel, seed, plateCount, frag, relief, seaRelief, oceanTarget };
  return grid;
}

/** Bilinear sample of a lower-resolution grid with x-wrap and y-clamp. */
function bilinearCoarse(A, CGX, CGY, i, j, GX, GY) {
  const fx = (i + 0.5) / GX * CGX - 0.5;
  const fy = (j + 0.5) / GY * CGY - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const xa = ((x0 % CGX) + CGX) % CGX, xb = ((x0 + 1) % CGX + CGX) % CGX;
  const ya = clamp(y0, 0, CGY - 1), yb = clamp(y0 + 1, 0, CGY - 1);
  const v00 = A[xa + ya * CGX], v10 = A[xb + ya * CGX];
  const v01 = A[xa + yb * CGX], v11 = A[xb + yb * CGX];
  return (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
}

/** Choose the height threshold that yields the requested ocean area fraction. */
export function solveSeaLevel(H, oceanTarget) {
  const n = H.length;
  const sorted = Float32Array.from(H);
  sorted.sort();
  const idx = clamp(Math.round(oceanTarget * (n - 1)), 0, n - 1);
  return sorted[idx];
}

/** Fraction of grid cells below the given level (approximate ocean fraction). */
export function oceanFractionBelow(H, level = 0) {
  let c = 0;
  for (let i = 0; i < H.length; i++) if (H[i] < level) c++;
  return c / H.length;
}

function normalise(H, minE, maxE) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < H.length; i++) { const v = H[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
  const span = hi - lo || 1;
  const targetSpan = maxE - minE;
  for (let i = 0; i < H.length; i++) H[i] = minE + (H[i] - lo) / span * targetSpan;
}

/** Box blur that wraps in x (longitude) and clamps in y (latitude). */
export function blurWrap(A, GX, GY, passes = 1) {
  const tmp = new Float32Array(A.length);
  for (let p = 0; p < passes; p++) {
    for (let j = 0; j < GY; j++) {
      for (let i = 0; i < GX; i++) {
        let s = 0, c = 0;
        for (let dj = -1; dj <= 1; dj++) {
          const jj = j + dj;
          if (jj < 0 || jj >= GY) continue;
          for (let di = -1; di <= 1; di++) {
            const ii = ((i + di) % GX + GX) % GX;
            s += A[ii + jj * GX]; c++;
          }
        }
        tmp[i + j * GX] = s / c;
      }
    }
    A.set(tmp);
  }
}

/* ------------------------------------------------------------------ */
/* sculpting tools (used by the terrain editor / wizard)               */
/* ------------------------------------------------------------------ */

/**
 * Apply a radial brush stroke on the heightfield.
 * @param {*} grid terrain grid
 * @param {number} latC centre latitude (deg)
 * @param {number} lonC centre longitude (deg)
 * @param {number} radiusDeg brush radius in degrees
 * @param {number} strength 0..1
 * @param {'raise'|'lower'|'smooth'|'flatten'} tool
 * @param {number} flattenTarget target height for 'flatten'
 * @param {object} limits { minElevation, maxElevation, radius, gravity }
 */
export function paintTerrain(grid, latC, lonC, radiusDeg, strength, tool = 'raise', flattenTarget = 0, limits = null) {
  const { GX, GY, height: H } = grid;
  const minE = limits?.minElevation ?? -12000;
  const maxE = limits?.maxElevation ?? 12000;
  // The heightfield is stored before the planet radius / gravity are applied,
  // so we scale the brush amplitude by them: a big, high-gravity world needs
  // taller terrain to produce the same visual and climatic effect.
  const radiusScale = limits?.radius ? clamp(limits.radius / 6371, 0.15, 4) : 1;
  const gravityScale = limits?.gravity ? clamp(Math.sqrt(9.807 / Math.max(0.3, limits.gravity)), 0.4, 3) : 1;
  // For raise/lower the brush applies an absolute height change in metres
  // ("改变高度"), not an abstract strength.
  const brushHeight = limits?.brushHeight ?? 600;
  const rLat = radiusDeg;
  const rLon = radiusDeg / Math.max(0.18, Math.cos(latC * Math.PI / 180));
  const j0 = Math.max(0, Math.floor((90 - (latC + rLat)) / 180 * GY));
  const j1 = Math.min(GY - 1, Math.ceil((90 - (latC - rLat)) / 180 * GY));
  const amount = (tool === 'raise' ? 1 : tool === 'lower' ? -1 : 0) * brushHeight * radiusScale * gravityScale;

  for (let j = j0; j <= j1; j++) {
    const lat = 90 - (j + 0.5) / GY * 180;
    const dy = (lat - latC) / rLat;
    for (let i = 0; i < GX; i++) {
      const lon = (i + 0.5) / GX * 360 - 180;
      let dx = (lon - lonC) / rLon;
      if (dx > 1) dx -= 360 / rLon;
      if (dx < -1) dx += 360 / rLon;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > 1) continue;
      const w = Math.pow(1 - d * d, 1.6) * clamp(strength, 0, 1);
      const idx = i + j * GX;
      if (tool === 'raise' || tool === 'lower') {
        H[idx] = clamp(H[idx] + amount * w, minE, maxE);
      } else if (tool === 'smooth') {
        const avg = neighbourAvg(H, GX, GY, i, j);
        H[idx] = H[idx] + (avg - H[idx]) * Math.min(1, w * 1.6);
      } else if (tool === 'flatten') {
        H[idx] = H[idx] + (flattenTarget - H[idx]) * Math.min(1, w * 1.5);
      }
    }
  }
  return grid;
}

function neighbourAvg(H, GX, GY, i, j) {
  let s = 0, c = 0;
  for (let dj = -1; dj <= 1; dj++) {
    const jj = j + dj; if (jj < 0 || jj >= GY) continue;
    for (let di = -1; di <= 1; di++) {
      const ii = ((i + di) % GX + GX) % GX;
      s += H[ii + jj * GX]; c++;
    }
  }
  return s / c;
}

/** Rescale the whole field about its mean (used by "地形高低起伏"). */
export function scaleTerrain(grid, factor, pivot = 0) {
  const H = grid.height;
  for (let i = 0; i < H.length; i++) H[i] = pivot + (H[i] - pivot) * factor;
}

/** Shift the field so that the requested ocean fraction is met at 0 m. */
export function applyOceanTarget(grid, oceanTarget) {
  const level = solveSeaLevel(grid.height, clamp(oceanTarget, 0.001, 0.999));
  const H = grid.height;
  for (let i = 0; i < H.length; i++) H[i] -= level;
}

export function invertLandSea(grid) {
  const H = grid.height;
  for (let i = 0; i < H.length; i++) H[i] = -H[i];
}

export function fillAll(grid, value) {
  grid.height.fill(value);
}

/** Recompute the ocean mask from the height field (height < 0 ⇒ water). */
export function updateWaterMask(terrain) {
  const { height: H } = terrain;
  const wm = terrain.waterMask && terrain.waterMask.length === H.length
    ? terrain.waterMask : (terrain.waterMask = new Uint8Array(H.length));
  for (let i = 0; i < H.length; i++) wm[i] = H[i] < 0 ? 1 : 0;
  return terrain;
}

/* ------------------------------------------------------------------ */
/* rivers — flow routing on the land surface                           */
/* ------------------------------------------------------------------ */

/**
 * Deterministic D8 flow routing with a priority queue (highest ground first).
 * Returns normalised river intensity per cell (0 = no channel).
 */
export function computeRivers(grid, opts = {}) {
  const { GX, GY, height: H } = grid;
  const n = GX * GY;
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const arr = Array.from(order);
  arr.sort((a, b) => H[b] - H[a]);

  const flow = new Float32Array(n);
  const isLand = (k) => H[k] >= 0;
  const idxOf = (i, j) => i + j * GX;

  for (let o = 0; o < arr.length; o++) {
    const k = arr[o];
    flow[k] += 1;                       // local rainfall contribution
    if (!isLand(k)) continue;
    const i = k % GX, j = (k - i) / GX;
    let best = -1, bestH = H[k];
    for (let dj = -1; dj <= 1; dj++) {
      const jj = j + dj;
      if (jj < 0 || jj >= GY) continue;
      for (let di = -1; di <= 1; di++) {
        if (di === 0 && dj === 0) continue;
        const ii = ((i + di) % GX + GX) % GX;
        const kk = idxOf(ii, jj);
        if (H[kk] < bestH) { bestH = H[kk]; best = kk; }
      }
    }
    if (best >= 0) flow[best] += flow[k];
  }

  // normalise: only meaningful channels survive
  const minAcc = opts.minAccum ?? 26;
  const out = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    if (!isLand(k)) continue;
    const f = flow[k];
    out[k] = f <= minAcc ? 0 : clamp(Math.log(f / minAcc) / Math.log(900), 0, 1);
  }
  return { intensity: out, flow };
}

/* ------------------------------------------------------------------ */
/* (de)serialisation                                                   */
/* ------------------------------------------------------------------ */

export function terrainToObject(grid) {
  // Stored as whole-metre deltas from the previous cell: neighbouring cells in
  // a heightfield differ by a few metres, so JSON stays around 250 kB for a
  // 360x180 grid instead of ~1.3 MB of absolute values.
  const n = grid.height.length;
  const height = new Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const v = Math.round(grid.height[i]);
    height[i] = v - prev;
    prev = v;
  }
  const waterMask = grid.waterMask ? new Array(grid.waterMask.length) : null;
  if (waterMask) for (let i = 0; i < waterMask.length; i++) waterMask[i] = grid.waterMask[i];
  const river = grid.river ? new Array(grid.river.length) : null;
  if (river) for (let i = 0; i < river.length; i++) river[i] = Math.round(grid.river[i] * 255);
  return { GX: grid.GX, GY: grid.GY, heightDelta: true, height, waterMask, river, meta: grid.meta || null };
}

export function terrainFromObject(obj) {
  if (!obj || !obj.height) throw new Error('场景缺少地形数据');
  const GX = obj.GX, GY = obj.GY;
  if (obj.height.length !== GX * GY) throw new Error('地形网格尺寸不匹配');
  const grid = allocTerrain(GX, GY);
  const h = obj.height;
  if (obj.heightDelta) {
    let prev = 0;
    for (let i = 0; i < h.length; i++) { prev += h[i]; grid.height[i] = prev; }
  } else {
    for (let i = 0; i < h.length; i++) grid.height[i] = h[i];
  }
  grid.waterMask = obj.waterMask && obj.waterMask.length === GX * GY ? Uint8Array.from(obj.waterMask) : null;
  grid.river = obj.river && obj.river.length === GX * GY ? Float32Array.from(obj.river, (v) => v / 255) : null;
  grid.meta = obj.meta || null;
  return grid;
}

/** Simple structural checksum used to share terrain between branch saves. */
export function terrainHash(grid) {
  const H = grid.height;
  let h1 = 2166136261 >>> 0;
  const step = Math.max(1, Math.floor(H.length / 4096));
  for (let i = 0; i < H.length; i += step) {
    const v = Math.round(H[i]);
    h1 ^= v & 0xff; h1 = Math.imul(h1, 16777619) >>> 0;
    h1 ^= (v >> 8) & 0xff; h1 = Math.imul(h1, 16777619) >>> 0;
  }
  return h1.toString(16) + '-' + grid.GX + 'x' + grid.GY;
}

/** Convenience used by charts / probes: bilinear height lookup. */
export function heightAt(grid, lat, lon) {
  const { GX, GY, height: H } = grid;
  let fi = (lon + 180) / 360 * GX - 0.5;
  let fj = (90 - lat) / 180 * GY - 0.5;
  fi = ((fi % GX) + GX) % GX;
  fj = clamp(fj, 0, GY - 1);
  const i0 = Math.floor(fi), i1 = (i0 + 1) % GX;
  const j0 = Math.floor(fj), j1 = Math.min(GY - 1, j0 + 1);
  const tx = fi - i0, ty = fj - j0;
  const a = H[i0 + j0 * GX], b = H[i1 + j0 * GX], c = H[i0 + j1 * GX], d = H[i1 + j1 * GX];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

export { noise3, smoothstep };
