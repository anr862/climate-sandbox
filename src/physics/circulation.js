/**
 * Ocean currents and atmospheric circulation.
 *
 * The energy-balance model deliberately does not resolve fluid dynamics, so the
 * two circulation systems are represented explicitly but parametrically:
 *
 *  - **Atmospheric circulation**: three cells per hemisphere — Hadley (0–30°),
 *    Ferrel (30–60°) and Polar (60–90°) — each with a surface wind band. The
 *    zonal wind is easterly in the trades and polar easterlies, westerly in the
 *    mid latitudes, and the meridional component converges at the ITCZ / polar
 *    front and diverges over the subtropical highs. Wind speed also scales with
 *    the meridional temperature gradient, because the thermal wind is driven by
 *    exactly that gradient.
 *
 *  - **Ocean circulation**: a wind-driven subtropical/tropical gyre system plus
 *    a thermohaline overturning. Western boundary currents (Gulf Stream /
 *    Kuroshio analogues) are narrow, fast and warm; eastern boundaries are broad,
 *    slow and cold with upwelling.
 *
 * Both feed back into the climate through three channels:
 *   1. poleward heat transport (they carry most of the ~5.5 PW the model needs),
 *   2. moisture supply, via the meridional wind convergence that drives rainfall,
 *   3. coastal upwelling, which suppresses precipitation (the classic reason
 *      western continental margins are deserts).
 *
 * Everything is driven from latitude and the wind direction, so it stays cheap
 * enough to evaluate per cell per sub-step.
 */

import { clamp } from '../core/noise.js';

/** Nominal maximum near-surface wind speed at circulation strength 1 (m/s). */
export const WIND_REF = 14;
/** Nominal maximum surface current speed at circulation strength 1 (m/s). */
export const CURRENT_REF = 1.0;
/**
 * Ekman drift: fraction of the wind speed that appears as a *mean* surface
 * current. The instantaneous 3 % rule is for wind-driven transport; averaged over
 * a month the Eulerian mean current is a little smaller.
 */
export const EKMAN_DRIFT = 0.02;

/**
 * Alongshore decay scales for the coastline-driven currents, in km.
 *
 * These decide how strongly the coastline shapes the ocean. A western boundary
 * current (Gulf Stream, Kuroshio, Brazil, Agulhas, East Australian) is narrow and
 * fast, pinned to the coast; an eastern boundary current (California, Peru, Canary,
 * Benguela) is broad and slow, so its scale is longer. Both are anchored to land the
 * terrain generator actually produced, not to a fixed longitude.
 *
 * Sizing is a compromise forced by the climate grid: at the default 96×48 mesh a
 * cell is 417 km across, so the *smallest possible* distance from an ocean cell to
 * land is one cell. Scales much below that would be inert — an earlier version used
 * 260 km for the cross-shore suppression, and `smoothstep(0, 260, 417)` saturated at
 * 1, so the term silently did nothing. Anything that must apply to the cells that
 * actually touch land is therefore also gated on `onCoast`, which is measured in
 * cells and so survives any mesh size.
 */
export const W_BC_SCALE_KM = 900;
export const E_BC_SCALE_KM = 1400;
/** Scale of the general coastal jet that makes flow hug any shoreline, km. */
export const COASTAL_JET_KM = 800;
/** Scale over which the coast suppresses cross-shore flow, km. */
export const CROSS_SHORE_KM = 800;

function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0 || 1e-9), 0, 1);
  return t * t * (3 - 2 * t);
}

function gauss(x, sigma) { return Math.exp(-(x * x) / (2 * sigma * sigma)); }


/* ------------------------------------------------------------------ */
/* atmospheric circulation                                            */
/* ------------------------------------------------------------------ */

/**
 * Surface wind at a latitude.
 * @param {number} latDeg
 * @param {number} strength     circulation strength (1 = Earth-like)
 * @param {number} gradientFactor  0.4..1.6, scales with the meridional temperature
 *        gradient (the thermal wind is driven by that gradient)
 * @returns {{u:number, v:number, speed:number, band:string, convergence:number}}
 *   u = zonal (east positive), v = meridional (north positive), m/s
 */
export function windAt(latDeg, strength = 1, gradientFactor = 1) {
  const a = Math.abs(latDeg);
  const hemi = latDeg >= 0 ? 1 : -1;
  const s = Math.max(0, strength) * clamp(gradientFactor, 0.35, 2);

  /* ---- zonal bands ---- */
  // Peak at ~15° (trades) and ~45° (westerlies); the Gaussian tails overlap so
  // the equatorial doldrums stay light but non-zero.
  const trades = gauss(a - 15, 9);        // easterly
  const westerlies = gauss(a - 45, 10);   // westerly
  const polar = gauss(a - 75, 11);        // easterly
  const u = WIND_REF * s * hemi *
    (-0.55 * trades + 1.00 * westerlies - 0.45 * polar);

  /* ---- meridional cells ---- */
  // Hadley: equatorward at the surface (toward the ITCZ)
  // Ferrel: poleward at the surface (toward the polar front)
  // Polar: equatorward at the surface
  const itcz = gauss(a, 9);
  const front = gauss(a - 60, 9);
  const v = WIND_REF * s * hemi * (0.50 * itcz - 0.55 * front + 0.25 * smoothstep(62, 88, a));

  const band = a < 30 ? 'trade' : a < 60 ? 'westerly' : 'polar';
  return {
    u,
    v,
    speed: Math.hypot(u, v),
    band,
    convergence: windConvergence(latDeg, strength),
  };
}

/** Convergence of the surface wind field (positive = air converging = rising). */
export function windConvergence(latDeg, strength = 1) {
  const a = Math.abs(latDeg);
  const s = Math.max(0, strength);
  const itcz = gauss(a, 9);
  const front = gauss(a - 60, 9);
  const high = gauss(a - 30, 8);
  // surface air converges at the ITCZ and the polar front, diverges over the
  // subtropical highs — this is what the zonal wind field above actually does
  return (itcz * 1.15 + front * 0.85 - high * 0.95) * s;
}

/* ------------------------------------------------------------------ */
/* ocean circulation                                                  */
/* ------------------------------------------------------------------ */

/**
 * Surface current at a latitude and longitude.
 *
 * `oceanFrac` is the ocean fraction of the cell (1 = open ocean, 0 = land): a
 * current exists only in water. NOTE the argument used to be *named* `landFrac`
 * while callers passed the ocean fraction, so the test was inverted and the
 * resulting arrows were drawn over the continents.
 *
 * `env` couples the current to the rest of the model:
 *   - `windU`/`windV` — the local surface wind. Wind *drives* the ocean: Ekman
 *     drift is ≈3 % of the wind speed, turned 45° (right in the northern
 *     hemisphere, left in the southern), so the wind field leaves its signature
 *     on the current map;
 *   - `gyreScale` — strength of the wind-stress-curl gyres, scaled by the local
 *     SST gradient (thermal wind: the same wind spins a gyre harder when the
 *     water on its flanks is at very different temperatures);
 *   - `coast` — the geometry of the *actual* coastline from physics/coast.js:
 *     `{coastKm, offX, offY, tanX, tanY, shelf, westKm, eastKm, onCoast}`.
 *
 * The coast term is what makes the continents matter. Upstream this function
 * placed its "basins" at fixed longitudes (cosine lobes labelled Atlantic-ish and
 * Pacific-ish), so the land could be moved anywhere and the currents would not
 * change: the coastline had no influence on the ocean at all. Now the boundary
 * currents are anchored to real land, the flow is turned along the shore, and it is
 * damped across the shore and over the shelf. Omitting `coast` (or passing a cell
 * with no usable normal) falls back to the latitude-belt structure alone, which is
 * what the fine-resolution shelf fallback in derived.js needs.
 *
 * @returns {{u:number, v:number, speed:number, kind:string}}
 */
export function currentAt(latDeg, lonDeg, strength = 1, oceanFrac = 0, env = {}) {
  const s = Math.max(0, strength);
  const a = Math.abs(latDeg);
  const hemi = latDeg >= 0 ? 1 : -1;
  const wet = clamp(oceanFrac, 0, 1);
  // smooth ramp so shelf seas and archipelago water still carry a (weaker)
  // current instead of switching off at exactly 50 % ocean
  const seaWeight = smoothstep(0.12, 0.62, wet);
  const sea = seaWeight > 1e-4;
  const gyreScale = clamp(env.gyreScale ?? 1, 0.2, 3);
  const coast = env.coast || null;

  // Gyre belt: strong between ~10° and ~45° latitude
  const gyre = gauss(a - 28, 16) * gyreScale;

  /* ---- latitude-belt structure (independent of terrain) ---- */
  const gyreU = -hemi * CURRENT_REF * s * gyre * 0.20;             // basin-wide drift
  const eqCurrent = -hemi * CURRENT_REF * s * gauss(a, 7) * 0.6;
  const polarCurrent = hemi * CURRENT_REF * s * smoothstep(55, 75, a) * 0.45;
  const meridional = -hemi * CURRENT_REF * s * gauss(a - 35, 14) * 0.22;

  let u = gyreU + eqCurrent + polarCurrent;
  let v = meridional;

  /* ---- coastline-driven terms ---- */
  let westEdge = 0, eastEdge = 0, jet = 0;
  if (coast && sea) {
    const d = Math.max(0, coast.coastKm);
    const atShore = !!coast.onCoast;
    // A cell touching land is the shoreline as far as this grid can tell, so it is
    // floored to a strong boundary weight regardless of the km scale.
    const westFromLand = Math.exp(-coast.westKm / W_BC_SCALE_KM);
    westEdge = atShore && coast.westKm < 1.5 * (coast.cellKm || 417)
      ? Math.max(westFromLand, 0.9)
      : westFromLand;
    eastEdge = Math.exp(-coast.eastKm / E_BC_SCALE_KM);
    jet = atShore ? Math.max(Math.exp(-d / COASTAL_JET_KM), 0.85) : Math.exp(-d / COASTAL_JET_KM);

    // A western boundary current is narrow, fast and *poleward*; an eastern one is
    // broad, slow and *equatorward*. Both follow the local shoreline, so the sense is
    // expressed through the coast tangent rather than a fixed zonal direction.
    const tx = coast.tanX, ty = coast.tanY;
    const tangentUsable = Math.hypot(tx, ty) > 0.3;
    // orient the tangent so its meridional part is poleward; for an almost zonal
    // shoreline there is no meridional sense to speak of, so use the hemisphere.
    const poleward = tangentUsable && Math.abs(ty) > 0.15 ? (ty > 0 ? 1 : -1) * hemi : hemi;
    // the jet follows whichever boundary current dominates here, so a western coast
    // gets a poleward coastal current and an eastern coast an equatorward one
    const jetSense = westEdge >= eastEdge ? poleward : -poleward;

    const wMag = CURRENT_REF * s * gyre * 1.95 * westEdge;
    const eMag = CURRENT_REF * s * gyre * 0.55 * eastEdge;
    const jMag = CURRENT_REF * s * (0.25 + 0.55 * gyre) * jet;
    const along = poleward * (wMag - eMag) + jetSense * jMag;
    if (tangentUsable) {
      u += tx * along;
      v += ty * along;
    } else {
      u += poleward * along;
    }
  }

  /* ---- wind-driven Ekman drift ---- */
  // 2 % of the wind, turned 45° to the *right* in the northern hemisphere and to
  // the left in the southern. Rotating (wu, wv) by ∓45° means
  // u' = wu·cosθ + wv·sinθ, v' = −wu·sinθ + wv·cosθ with θ = +45° for the northern
  // hemisphere (the minus sign in v is what puts the drift on the right of the wind).
  const wu = env.windU ?? 0, wv = env.windV ?? 0;
  const ct = Math.cos(Math.PI / 4);
  const st = hemi * Math.sin(Math.PI / 4);
  u += EKMAN_DRIFT * (ct * wu + st * wv);
  v += EKMAN_DRIFT * (-st * wu + ct * wv);

  /* ---- the coast as a boundary condition ---- */
  // Water cannot flow into the land: near a shore the cross-shore component is
  // suppressed and the alongshore one is damped by shelf friction. This is what
  // makes the currents visibly follow the coastline instead of running through it.
  if (coast && sea) {
    const d = Math.max(0, coast.coastKm);
    const nx = coast.offX, ny = coast.offY;
    if (Math.hypot(nx, ny) > 0.3) {
      const tx = coast.tanX, ty = coast.tanY;
      const alongComp = u * tx + v * ty;
      const crossComp = u * nx + v * ny;
      // A cell that touches land is the shoreline as far as this grid can tell, so
      // it gets the full boundary condition; the suppression then relaxes with
      // distance. `onCoast` is measured in cells, so this still works on a mesh where
      // one cell is wider than CROSS_SHORE_KM (which is the case by default).
      const crossKeep = (0.2 + 0.8 * smoothstep(0, CROSS_SHORE_KM, d)) * (coast.onCoast ? 0.5 : 1);
      const shelfFriction = (1 - 0.35 * Math.exp(-d / 600)) * (coast.onCoast ? 0.8 : 1);
      u = tx * alongComp * shelfFriction + nx * crossComp * crossKeep;
      v = ty * alongComp * shelfFriction + ny * crossComp * crossKeep;
    }
  }

  // Applied unconditionally: seaWeight is 0 over land, and it *must* be applied there
  // or the latitude-belt terms above survive as a current field on the continents.
  // (The earlier version guarded the whole accumulation with `if (sea)`, which is why
  // the land-eastward `u`/`v` did not leak; restructuring it without this line did.)
  u *= seaWeight; v *= seaWeight;

  let kind = 'none';
  if (sea) {
    if (westEdge > 0.55 && gyre > 0.35) kind = 'western-boundary';
    else if (eastEdge > 0.55 && gyre > 0.35) kind = 'eastern-boundary';
    else if (jet > 0.6) kind = 'coastal';
    else if (a < 12) kind = 'equatorial';
    else if (a > 60) kind = 'polar';
    else kind = 'gyre';
  }
  return { u, v, speed: Math.hypot(u, v), kind, westEdge, eastEdge, jet };
}

/**
 * Coastal upwelling factor (1 = strong upwelling → cold, dry coasts).
 *
 * The mechanism is the real one: the wind blows along the shore, and the Ekman
 * transport it drives (90° to the right of the wind in the northern hemisphere, to
 * the left in the southern) carries surface water *offshore*, which is what forces
 * cold deep water to rise and makes the classic coastal deserts.
 *
 * Upstream this was computed from the same fixed cosine-lobe "basins" as the
 * currents, so upwelling appeared at lon ≈ −60 / +150 regardless of where the coast
 * actually was. It now needs the real shoreline orientation *and* the real wind.
 * The eastern-boundary weight is kept because the great coastal deserts (Atacama,
 * Namib, Baja, Morocco) all sit on the eastern side of an ocean basin.
 *
 * @param {object} env {windU, windV, coast}
 */
export function upwellingFactor(latDeg, lonDeg, strength = 1, oceanFrac = 0, env = {}) {
  const s = Math.max(0, strength);
  if (clamp(oceanFrac, 0, 1) < 0.5) return 0;
  const coast = env.coast;
  if (!coast) return 0;
  const a = Math.abs(latDeg);
  const hemi = latDeg >= 0 ? 1 : -1;
  const nx = coast.offX, ny = coast.offY;
  if (Math.hypot(nx, ny) < 0.3) return 0;

  // Ekman volume transport direction: 90° to the right of the wind (NH) / left (SH).
  const wu = env.windU ?? 0, wv = env.windV ?? 0;
  const ekX = hemi * wv;
  const ekY = -hemi * wu;
  const offshore = ekX * nx + ekY * ny;              // >0 ⇒ surface water pushed offshore
  if (offshore <= 0) return 0;

  // strongest where the wind blows along the coast rather than onshore
  const tangent = Math.abs(wu * coast.tanX + wv * coast.tanY);
  const alongWeight = clamp(tangent / Math.max(1e-6, Math.hypot(wu, wv) + 1e-6), 0, 1);

  // eastern boundaries of basins are the strong upwelling coasts
  const eastWeight = 0.45 + 0.55 * Math.exp(-coast.eastKm / E_BC_SCALE_KM);
  // trade-wind belt, plus the equatorward flank of the westerlies
  const belt = gauss(a - 20, 16) + 0.5 * gauss(a - 40, 12);

  const raw = clamp(offshore / 6, 0, 1) * alongWeight * eastWeight * belt * s;
  return clamp(raw, 0, 1);
}


/* ------------------------------------------------------------------ */
/* heat transport partitioning                                        */
/* ------------------------------------------------------------------ */

/**
 * How the total poleward heat transport is split between the two systems.
 * The transport pass consumes these weights directly, so raising either
 * parameter increases that system's share of the poleward flux.
 */
export function transportWeights(oceanCirculation = 1, atmosphericCirculation = 1, master = 1) {
  const total = Math.max(0, master);
  const ocean = 0.25 * Math.max(0, oceanCirculation);
  const atmos = 0.60 * Math.max(0, atmosphericCirculation);
  const sum = ocean + atmos;
  if (sum <= 1e-6) return { ocean: 0, atmos: 0, fPole: 0.15 * total, fMin: 0.03 * total };
  const scale = total / sum;
  return {
    ocean: ocean * scale,
    atmos: atmos * scale,
    // the poles are overwhelmingly heated by fluid transport, so the effective
    // polar relaxation weight follows the circulation strength
    fPole: clamp(0.85 * total, 0, 0.97),
    fMin: clamp(0.15 * total, 0, 0.6),
  };
}

export { smoothstep };
