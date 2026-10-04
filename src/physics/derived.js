/**
 * Derived fields: base surface colour texture, per-layer overlay data for the
 * globe, biome classification and probe read-outs.
 */

import { clamp } from '../core/noise.js';
import { LAYERS, hx, mix, mix3 } from '../core/colors.js';
import { currentAt } from './circulation.js';

/* ------------------------------------------------------------------ */
/* sampling helpers                                                    */
/* ------------------------------------------------------------------ */

/** Bilinear sample of a coarse climate field at a lat/lon. */
export function sampleClimate(grid, field, lat, lon) {
  const { NB, NL } = grid;
  let fi = (lon + 180) / 360 * NL - 0.5;
  let fj = (90 - lat) / 180 * NB - 0.5;
  fi = ((fi % NL) + NL) % NL;
  fj = clamp(fj, 0, NB - 1);
  const i0 = Math.floor(fi), i1 = (i0 + 1) % NL;
  const j0 = Math.floor(fj), j1 = Math.min(NB - 1, j0 + 1);
  const tx = fi - i0, ty = fj - j0;
  const a = field[i0 + j0 * NL], b = field[i1 + j0 * NL], c = field[i0 + j1 * NL], d = field[i1 + j1 * NL];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

/**
 * Bilinear ocean fraction (0..1) from the *terrain* water mask.
 *
 * Needed because currents are defined on the coarse climate grid while the
 * overlay is drawn on the fine terrain grid: sampling `currentSpeed` alone
 * bilinearly pulls ocean values up to a climate cell (≈4°) inland, which is why
 * current arrows used to appear over continents. Multiplying by this mask keeps
 * the arrows in the water.
 */
export function oceanFractionAt(world, lat, lon) {
  const t = world.terrain;
  if (!t || !t.waterMask) return 0;
  const { GX, GY, waterMask } = t;
  let fi = (lon + 180) / 360 * GX - 0.5;
  let fj = (90 - lat) / 180 * GY - 0.5;
  fi = ((fi % GX) + GX) % GX;
  fj = clamp(fj, 0, GY - 1);
  const i0 = Math.floor(fi), i1 = (i0 + 1) % GX;
  const j0 = Math.floor(fj), j1 = Math.min(GY - 1, j0 + 1);
  const tx = fi - i0, ty = fj - j0;
  const a = waterMask[i0 + j0 * GX], b = waterMask[i1 + j0 * GX];
  const c = waterMask[i0 + j1 * GX], d = waterMask[i1 + j1 * GX];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

/* ------------------------------------------------------------------ */
/* layer computation (float values in physical units)                  */
/* ------------------------------------------------------------------ */

/**
 * Produce a Float32Array of physical layer values on the terrain grid.
 * Returned arrays are cached on the world keyed by layer name.
 */
export function computeLayer(world, layerKey) {
  const grid = world.grid;
  const { GX, GY, height: H, waterMask, river } = world.terrain;
  const cache = world.layerCache || (world.layerCache = new Map());
  const stamp = layerKey + '|' + world.time.month.toFixed(0) + '|' + (world.frameId || 0);
  const hit = cache.get(layerKey);
  if (hit && hit.stamp === stamp) return hit.data;

  const out = new Float32Array(GX * GY);
  const land = (k) => waterMask[k] || H[k] < 0;

  for (let j = 0; j < GY; j++) {
    const lat = 90 - (j + 0.5) / GY * 180;
    for (let i = 0; i < GX; i++) {
      const k = i + j * GX;
      const lon = (i + 0.5) / GX * 360 - 180;
      let v;
      switch (layerKey) {
        case 'none': v = 0; break;
        case 'temperature': v = sampleClimate(grid, grid.tAnnual[k] ? grid.tAnnual : grid.T, lat, lon) - 273.15; break;
        case 'anomaly': v = sampleClimate(grid, grid.tAnomaly, lat, lon); break;
        case 'precipitation': v = sampleClimate(grid, grid.pAnnual[0] ? grid.pAnnual : grid.precip, lat, lon); break;
        case 'precipSeason': {
          // wet month − dry month, converted to an annual-equivalent total (mm/yr)
          const diff = Math.max(0, sampleClimate(grid, grid.pSeasonMax, lat, lon)
            - sampleClimate(grid, grid.pSeasonMin, lat, lon));
          v = diff * 12;
          break;
        }
        case 'seasonal': v = Math.max(0, sampleClimate(grid, grid.tSeasonMax, lat, lon) - sampleClimate(grid, grid.tSeasonMin, lat, lon)); break;
        case 'humidity': v = sampleClimate(grid, grid.humidity, lat, lon); break;
        case 'vegetation': v = sampleClimate(grid, grid.vegetation, lat, lon) * 100; break;
        case 'habitability': {
          // land-only index: without this mask the bilinear sample bleeds a
          // coastal land cell's value out over the water
          if (land(k)) { v = 0; break; }
          const base = sampleClimate(grid, grid.habitability, lat, lon);
          const elev = Math.max(0, H[k]);
          v = base * Math.exp(-elev / 9000);
          break;
        }
        case 'toxicity': v = sampleClimate(grid, grid.toxicity, lat, lon); break;
        case 'aerosol': v = sampleClimate(grid, grid.aerosol, lat, lon); break;
        case 'diurnal': v = sampleClimate(grid, grid.diurnal, lat, lon); break;
        case 'oxygen': {
          // vertical mixing: high ground and cold water hold slightly less O2
          const base = world.params.o2;
          const elev = Math.max(0, H[k]);
          v = base * Math.exp(-elev / 14000);
          if (land(k)) v *= 1 + clamp(sampleClimate(grid, grid.vegetation, lat, lon), 0, 1) * 0.06;
          break;
        }
        case 'seaIce': v = sampleClimate(grid, grid.seaIce, lat, lon) * 100; break;
        case 'cloud': v = sampleClimate(grid, grid.cloudCover, lat, lon) * 100; break;
        case 'windSpeed': v = sampleClimate(grid, grid.windSpeed, lat, lon); break;
        case 'currentSpeed': {
          // currents exist only in water
          const oc = waterMask ? (waterMask[k] ? 1 : 0) : 1;
          v = oc ? sampleClimate(grid, grid.currentSpeed, lat, lon) : 0;
          break;
        }
        case 'rivers': v = river ? river[k] : 0; break;
        default: v = 0;
      }
      out[k] = v;
    }
  }
  cache.set(layerKey, { stamp, data: out });
  return out;
}

/**
 * Vector companion of `computeLayer`: the u (eastward) / v (northward) components
 * of a flow layer, so the main view can draw arrows for speed *and* direction.
 * Values are sampled from the climate grid at any lat/lon.
 */
export function layerVector(world, layerKey, lat, lon) {
  const grid = world.grid;
  const L = LAYERS[layerKey];
  if (!L || !L.vector) return null;
  if (L.vector === 'wind') {
    return {
      u: sampleClimate(grid, grid.windU, lat, lon),
      v: sampleClimate(grid, grid.windV, lat, lon),
      speed: sampleClimate(grid, grid.windSpeed, lat, lon),
    };
  }
  // Currents are masked by the terrain water fraction: a current exists only in
  // water, and bilinear sampling of the coarse climate grid would otherwise drag
  // ocean values a whole climate cell (≈4°) inland.
  const oc = oceanFractionAt(world, lat, lon);
  if (oc < 0.5) return { u: 0, v: 0, speed: 0 };      // mostly land ⇒ no current
  const wet = Math.min(1, (oc - 0.5) / 0.3);
  const u = sampleClimate(grid, grid.currentU, lat, lon) * wet;
  const v = sampleClimate(grid, grid.currentV, lat, lon) * wet;
  const speed = sampleClimate(grid, grid.currentSpeed, lat, lon) * wet;
  if (speed > 0.02) return { u, v, speed };
  // Shelf seas and archipelagos can sit inside a climate cell that the 3.75° grid
  // classifies as land, which used to leave holes with no arrows in open water.
  // Fall back to the same parametric current the field itself is built from.
  const windU = sampleClimate(grid, grid.windU, lat, lon);
  const windV = sampleClimate(grid, grid.windV, lat, lon);
  // Use the real coastline geometry where the coarse grid has it; over a shelf sea
  // that the 3.75 deg grid classifies as land the sampled fields are degenerate, and
  // currentAt falls back to the latitude-belt structure + Ekman drift on its own.
  const coast = grid.coastReady ? {
    coastKm: sampleClimate(grid, grid._coastDist, lat, lon),
    offX: sampleClimate(grid, grid._coastOffX, lat, lon),
    offY: sampleClimate(grid, grid._coastOffY, lat, lon),
    tanX: sampleClimate(grid, grid._coastTanX, lat, lon),
    tanY: sampleClimate(grid, grid._coastTanY, lat, lon),
    shelf: sampleClimate(grid, grid._shelf, lat, lon),
    westKm: sampleClimate(grid, grid._coastWestKm, lat, lon),
    eastKm: sampleClimate(grid, grid._coastEastKm, lat, lon),
  } : null;
  const fallback = currentAt(lat, lon, world.params.oceanCirculation ?? 1, oc, { windU, windV, gyreScale: 1, coast });
  if (fallback.speed > 1e-4) return fallback;
  return { u, v, speed };
}

/**
 * Min/max used to normalise a layer for the GPU colormap path.
 *
 * `override` is the user's manually entered range from the legend editor; when
 * it is absent the layer's registered default is used (`fixedRange`), and only
 * layers without one fall back to scanning the data.
 */
export function layerRange(layerKey, data, override) {
  const L = LAYERS[layerKey];
  if (!L) return { min: 0, max: 1 };
  if (override && isFinite(override.min) && isFinite(override.max) && override.max > override.min) {
    return { min: override.min, max: override.max, custom: true };
  }
  if (L.fixedRange) return { min: L.min, max: L.max };
  if (layerKey === 'oxygen') return { min: L.min, max: L.max };
  let lo = Infinity, hi = -Infinity;
  const step = Math.max(1, Math.floor(data.length / 20000));
  for (let i = 0; i < data.length; i += step) {
    const v = data[i];
    if (!isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!isFinite(lo)) { lo = L.min; hi = L.max; }
  if (hi - lo < 1e-6) { hi = lo + Math.max(1e-3, Math.abs(lo) * 0.05 + 1e-3); }
  return { min: lo, max: hi };
}

/* ------------------------------------------------------------------ */
/* base surface texture                                                */
/* ------------------------------------------------------------------ */

/**
 * RGBA base map (equirectangular, GX x GY) used by the globe shader.
 * Ocean depth shading, land relief, snow/ice, vegetation tint.
 */
export function computeBaseTexture(world) {
  const t = world.terrain;
  const grid = world.grid;
  const { GX, GY, height: H, waterMask } = t;
  const out = world.baseTex && world.baseTex.length === GX * GY * 4
    ? world.baseTex : (world.baseTex = new Uint8Array(GX * GY * 4));
  const p = world.params;
  const sea = [hx(p.oceanColor || '#2c4a66')];
  const deep = [14, 30, 47];
  const shelf = [48, 84, 112];
  const lower = [104, 122, 92];
  const mid = [138, 132, 108];
  const high = [168, 160, 142];
  const peak = [216, 218, 214];
  const snowC = [230, 238, 244];
  const vegC = [88, 122, 74];
  const desertC = [176, 160, 118];
  const iceC = [214, 228, 238];

  for (let j = 0; j < GY; j++) {
    const lat = 90 - (j + 0.5) / GY * 180;
    for (let i = 0; i < GX; i++) {
      const k = i + j * GX;
      const h = H[k];
      const ocean = waterMask[k];
      let c;
      if (ocean) {
        const depth = clamp(-h / 5500, 0, 1);
        c = mix3(shelf[0], shelf[1], shelf[2], deep, Math.pow(depth, 0.6));
        c = mix(sea[0], c, clamp(depth * 3, 0, 1));
        const seaIce = sampleClimate(grid, grid.seaIce, lat, (i + 0.5) / GX * 360 - 180);
        if (seaIce > 0.02) c = mix(c, iceC, clamp(seaIce * 1.15, 0, 1));
      } else {
        const hh = clamp(h / 3800, 0, 1.4);
        c = hh < 0.22 ? mix(lower, mid, hh / 0.22)
          : hh < 0.6 ? mix(mid, high, (hh - 0.22) / 0.38)
            : mix(high, peak, clamp((hh - 0.6) / 0.7, 0, 1));
        const lon = (i + 0.5) / GX * 360 - 180;
        const veg = sampleClimate(grid, grid.vegetation, lat, lon);
        const dry = sampleClimate(grid, grid.dryness, lat, lon);
        // land cover: vegetation greens the lowlands, aridity sands them over
        c = mix(c, desertC, clamp(dry * 0.8, 0, 0.8));
        c = mix(c, vegC, clamp(veg, 0, 1) * 0.55);
        const snow = sampleClimate(grid, grid.snowCover, lat, lon);
        const iceF = sampleClimate(grid, grid.iceFrac, lat, lon);
        const cover = clamp(Math.max(snow, iceF), 0, 1);
        if (cover > 0.02) c = mix(c, snowC, Math.pow(cover, 0.75));
      }
      // relief shading from the local slope (cheap fake hillshade)
      const kE = i + 1 < GX ? k + 1 : k - GX + 1;
      const kS = j + 1 < GY ? k + GX : k;
      const gx = (H[kE] - H[k]) / 800;
      const gy = (H[kS] - H[k]) / 800;
      const sh = 1 + clamp((-gx * 0.9 - gy * 0.7), -0.45, 0.45);
      c = [c[0] * sh, c[1] * sh, c[2] * sh];
      // optional temperature tint
      const tint = clamp(p.tempTint ?? 0, 0, 1);
      if (tint > 0.001) {
        const temp = sampleClimate(grid, grid.T, lat, (i + 0.5) / GX * 360 - 180);
        const warm = clamp((temp - 273.15 + 30) / 80, 0, 1);
        c = mix(c, mix([110, 130, 170], [190, 130, 100], warm), tint * 0.55);
      }
      const o = k * 4;
      out[o] = clamp(c[0], 0, 255);
      out[o + 1] = clamp(c[1], 0, 255);
      out[o + 2] = clamp(c[2], 0, 255);
      out[o + 3] = 255;
    }
  }
  return out;
}
/* ------------------------------------------------------------------ */
/* biome + probe read-outs                                             */
/* ------------------------------------------------------------------ */

export function classifyBiome(tempC, precip, humidity, ocean) {
  if (ocean) {
    if (tempC < -1.8) return { id: 'sea-ice', label: '海冰', color: '#9fb4c4' };
    if (tempC < 4) return { id: 'polar-sea', label: '极地海', color: '#4a6b86' };
    if (tempC < 20) return { id: 'temperate-sea', label: '温带海', color: '#3d6a86' };
    return { id: 'tropical-sea', label: '热带海', color: '#356f86' };
  }
  if (tempC < -10) return { id: 'ice-sheet', label: '冰盖 / 极地荒漠', color: '#c6d2da' };
  if (tempC < 0) return { id: 'tundra', label: '苔原', color: '#8f9689' };
  if (tempC < 6) return { id: 'taiga', label: '针叶林', color: '#5c7550' };
  if (precip < 16) return { id: 'cold-desert', label: '冷荒漠', color: '#9a917c' };
  if (tempC < 14) return { id: 'temperate-forest', label: '温带森林', color: '#5f8253' };
  if (precip < 22) return { id: 'steppe', label: '草原 / 干草原', color: '#8e9159' };
  if (tempC < 22) return { id: 'mediterranean', label: '地中海灌丛', color: '#7d8b55' };
  if (precip < 40) return { id: 'savanna', label: '热带稀树草原', color: '#8d9455' };
  if (precip < 90) return { id: 'tropical-seasonal', label: '热带季雨林', color: '#4f7a4a' };
  if (precip < 150) return { id: 'rainforest', label: '热带雨林', color: '#3f6e42' };
  return { id: 'wetland', label: '湿地 / 沼泽', color: '#4a6b52' };
}

/** Full local climate read-out for a probe / chart region. */
export function probeAt(world, lat, lon, radiusDeg = 4) {
  const grid = world.grid;
  const t = world.terrain;
  const { NB, NL } = grid;
  const jC = Math.round((90 - lat) / 180 * NB - 0.5);
  const iC = Math.round((lon + 180) / 360 * NL - 0.5);
  const rj = Math.max(0, Math.round(radiusDeg / (180 / NB)));
  const ri = Math.max(0, Math.round(radiusDeg / (360 / NL)));

  let wsum = 0, tSum = 0, pSum = 0, hSum = 0, vSum = 0, oSum = 0, hbSum = 0, toxSum = 0, dSum = 0;
  let oceanFrac = 0, count = 0, iceSum = 0, sea = 0;
  for (let dj = -rj; dj <= rj; dj++) {
    const j = jC + dj;
    if (j < 0 || j >= NB) continue;
    const w = grid.areaFrac[j];
    for (let di = -ri; di <= ri; di++) {
      const i = ((iC + di) % NL + NL) % NL;
      const k = i + j * NL;
      wsum += w;
      tSum += grid.T[k] * w;
      pSum += grid.precip[k] * w;
      hSum += grid.h[k] * w;
      vSum += grid.vegetation[k] * w;
      oSum += grid.ocean[k] * w;
      hbSum += grid.habitability[k] * w;
      toxSum += grid.toxicity[k] * w;
      dSum += grid.diurnal[k] * w;
      iceSum += grid.ice[k] * w;
      count++;
    }
  }
  const inv = wsum > 0 ? 1 / wsum : 1;
  const tempK = tSum * inv;
  const tempC = tempK - 273.15;
  const precip = pSum * inv;
  const h = hSum * inv;
  const ocean = oSum * inv;
  const hum = sampleClimate(grid, grid.humidity, lat, lon);
  const biome = classifyBiome(tempC, precip, hum, ocean > 0.5);
  const latRad = lat * Math.PI / 180;
  const rho2 = (1 - (world.params.eccentricity ?? 0.0167) ** 2) /
    Math.pow(1 + (world.params.eccentricity ?? 0.0167) * Math.cos(2 * Math.PI * ((world.time.month % 12) / 12)), 2);
  const insolation = grid.absorbed[iC >= 0 ? ((iC % NL) + NL) % NL + Math.max(0, jC) * NL : 0] || 0;

  return {
    lat, lon,
    radiusDeg,
    tempK, tempC,
    precip, humidity: hum,
    vegetation: vSum * inv,
    habitability: hbSum * inv,
    toxicity: toxSum * inv,
    diurnal: dSum * inv,
    elevation: h,
    ocean: ocean > 0.5,
    oceanFraction: ocean,
    iceThickness: iceSum * inv,
    seaIce: sampleClimate(grid, grid.seaIce, lat, lon),
    aerosol: sampleClimate(grid, grid.aerosol, lat, lon),
    oxygen: world.params.o2,
    co2: world.params.co2,
    pressure: world.params.pressure,
    absorbed: insolation,
    biome,
    cells: count,
    latBand: Math.asin(clamp(latRad > -1.5 && latRad < 1.5 ? Math.sin(latRad) : Math.sin(latRad), -1, 1)),
  };
}

/* ------------------------------------------------------------------ */
/* regional time series (used when a probe / region is selected)       */
/* ------------------------------------------------------------------ */

export function regionSeriesFields(world, lat, lon, radiusDeg = 4) {
  const grid = world.grid;
  const { NB, NL } = grid;
  const jC = Math.round((90 - lat) / 180 * NB - 0.5);
  const iC = Math.round((lon + 180) / 360 * NL - 0.5);
  const rj = Math.max(0, Math.round(radiusDeg / (180 / NB))) || 0;
  const ri = Math.max(1, Math.round(radiusDeg / (360 / NL)));
  const idx = [];
  let wsum = 0;
  const weights = [];
  for (let dj = -rj; dj <= rj; dj++) {
    const j = clamp(jC + dj, 0, NB - 1);
    for (let di = -ri; di <= ri; di++) {
      const i = ((iC + di) % NL + NL) % NL;
      idx.push(i + j * NL);
      weights.push(grid.areaFrac[j]);
      wsum += grid.areaFrac[j];
    }
  }
  return { idx, weights: weights.map((w) => w / (wsum || 1)) };
}

export function weightedAverage(grid, field, region) {
  let s = 0;
  for (let k = 0; k < region.idx.length; k++) s += field[region.idx[k]] * region.weights[k];
  return s;
}

export { mix, clamp };
