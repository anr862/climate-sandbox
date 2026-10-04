/**
 * Latitudinal energy-balance climate model (EBM) with simplified
 * greenhouse / water-cycle / cryosphere coupling.
 *
 * Per grid cell (NBANDS latitudes x NLONS longitudes):
 *
 *   C ∂T/∂t = S(φ,t)·(1-α) − τ_eff·σ·T⁴ − A + ∇·(D∇T)
 *
 *  - S : top-of-atmosphere insolation from real orbital geometry
 *  - α : surface + cloud albedo (this is where the ice-albedo feedback lives)
 *  - τ : effective atmospheric transmittance (1 = perfectly transparent)
 *  - A : aerosol / dust shortwave forcing (negative = dimming)
 *  - D : heat transport, with a heat-capacity weighted flux so that heat
 *        flowing from a low-capacity cell into the ocean does not blow up
 *
 * The local radiative relaxation time is far shorter than a month, so the
 * surface temperature is integrated by exponential relaxation toward the local
 * radiative equilibrium — stable at any step size, and it reproduces both the
 * fast land response and the lagged ocean response of the seasonal cycle.
 */

import { clamp } from '../core/noise.js';
import { windAt, currentAt, upwellingFactor, transportWeights } from './circulation.js';
import { coastAt } from './coast.js';

export const SIGMA = 5.670374419e-8;
export const EARTH_RADIUS_M = 6.371e6;
export const DEG_M = Math.PI * EARTH_RADIUS_M / 180;   // metres per degree of arc

/* Calibration constants — tuned so that Earth reproduces 288 K and α≈0.30. */
const KAPPA_CO2 = 0.0137;      // per ln(ppm / 420) — this is the Myhre (5.35 W/m²)
                               // radiative forcing converted into a τ change:
                               // Δτ = 5.35·ln(C/C₀) / σT⁴ ≈ 0.0137·ln(C/C₀)
const KAPPA_CH4 = 0.00047;     // per log-ratio of ppb
const KAPPA_N2O = 0.00105;     // per log-ratio of ppb
const KAPPA_H2O = 0.0032;      // per kelvin of global-mean anomaly. This *is* the
                               // water-vapour feedback: a warmer planet holds more
                               // vapour, which lowers τ. Earth's observed water-vapour
                               // feedback is ≈ +1.8 W m⁻² K⁻¹, i.e. ≈ 0.0046 here
                               // (λ = KAPPA_H2O·σT⁴); 0.0032 gives ≈1.25 W m⁻² K⁻¹,
                               // deliberately short of the observed value so the
                               // ice-albedo runaway keeps a wide safety margin.
                               // Note it vanishes at tGlobal = BASE.tRef, so changing
                               // it does NOT move the calibrated 288 K equilibrium —
                               // it only scales the response to departures from it.
const KAPPA_PRESSURE = 0.018;  // per ln(p / 1 atm)
const AEROSOL_FORCING = 22;    // W/m² at load = 1
const CLOUD_ALBEDO_MAX = 0.27; // albedo of a *fully overcast* cell in this model
// Do NOT read this as the albedo of a thick overcast deck (0.4–0.5 in reality). What
// the model needs is the value that reproduces Earth's shortwave cloud radiative
// effect, because `albedo = surf·(1-ca) + ca` with ca = CLOUD_ALBEDO_MAX · cover makes
// ca the *effective* all-cloud-types albedo. Earth's shortwave CRE is −47 W m⁻², i.e.
// 47/(1361/4) = 0.138 of planetary albedo; at the per-cell cover this model actually
// produces (mean 0.596) that pins the excess over clear sky to 0.138, so
// ca·(1 − surf) ≈ 0.138 → ca ≈ 0.162 → CLOUD_ALBEDO_MAX ≈ 0.27. That lands the
// planetary albedo at ~0.29 and absorbed sunlight at ~240 W m⁻², both Earth's.
//
// History: 0.32 → briefly 0.38, then here. The 0.38 step was reasoned from a *wrong*
// world: the check scripts fed defaults().humidity (68) into the cloud formula and so
// believed the mean cover was 0.486, when the app's applyAutoRules derives humidity 78
// / cloud 68.16 and the real cover is 0.596. At 0.38 the real world brightened to
// 0.338 planetary albedo and 225 W m⁻² absorbed, and snowballed in ~30 years — the
// exact symptom this work set out to remove. See build/appworld.mjs.
const UPWELL_TARGET_K = 275;   // deep-water temperature the upwelling relaxes toward
/**
 * Distance from the shoreline over which the sea/land breeze decays, km. Of the same
 * order as a real sea-breeze front (~100 km) scaled up to what a 417 km climate cell
 * can represent — a much shorter scale would be invisible on the grid.
 */
const COASTAL_BREEZE_KM = 1200;
/**
 * Static stability used in the blocking criterion N·h/U, s⁻¹. A typical tropospheric
 * value; it sets how tall a hill has to be, relative to the wind speed, before the
 * flow goes around it instead of over it.
 */
const N_STABILITY = 0.011;
/**
 * Surface wind over land as a fraction of the open-water value at the same latitude.
 * Land is far rougher than sea, and this ratio is the single most visible way the
 * continents imprint themselves on a wind map.
 */
const LAND_ROUGHNESS = 0.68;
/**
 * Reference wind for the surface–air exchange coefficient. Chosen as the global-mean
 * surface wind, so `surfaceAirCoupling` reproduces its earlier calibrated values
 * there while still responding properly to faster or slower winds.
 */
const WIND_COUPLING_REF = 5.5;

/**
 * Internal weights for the three ocean heat terms. They exist so the relative
 * importance of advection / overturning / upwelling can be measured
 * independently (see scripts/ocean-check.mjs); the shipped values are all 1.
 */
export const OCEAN_TUNING = { advection: 1, overturning: 1, upwelling: 1 };
// Precipitation scale (mm per month per g/kg of column moisture). Tuned so the
// Earth default lands near the observed 80 mm/month global mean.
const PRECIP_SCALE = 8.5;

export const BASE = { tRef: 288, co2Ref: 420, ch4Ref: 1920, n2oRef: 332, humRef: 68, pressRef: 1, tauRef: 0.63170 };

/* ------------------------------------------------------------------ */
/* orbital geometry                                                    */
/* ------------------------------------------------------------------ */

/** Daily-mean top-of-atmosphere insolation per latitude band (W/m²). */
export function dailyInsolation(lats, dayOfYear, opts) {
  const S0 = opts.irradiance;
  const tilt = (opts.axialTilt ?? 23.44) * Math.PI / 180;
  const e = clamp(opts.eccentricity ?? 0.0167, 0, 0.85);
  const lonPeri = ((opts.perihelion ?? 102) + 180) * Math.PI / 180;
  const N = lats.length;
  const out = new Float32Array(N);
  const b = 2 * Math.PI * (dayOfYear - 80) / 365.25;
  const M = b - 2 * e * Math.sin(b) + 1.25 * e * e * Math.sin(2 * b);
  const lam = M + lonPeri;
  const sinD = Math.sin(tilt) * Math.sin(lam);
  const cosD = Math.sqrt(Math.max(0, 1 - sinD * sinD));
  const rho2 = (1 - e * e) / Math.pow(1 + e * Math.cos(lam), 2);

  for (let j = 0; j < N; j++) {
    const phi = lats[j] * Math.PI / 180;
    const sinPhi = Math.sin(phi), cosPhi = Math.cos(phi);
    const x = clamp(-Math.tan(phi) * sinD / Math.max(1e-6, cosD), -1, 1);
    const H0 = Math.acos(x);
    const s = sinPhi * sinD * H0 + cosPhi * cosD * Math.sin(H0);
    out[j] = Math.max(0, S0 * rho2 * s / Math.PI);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* greenhouse / radiation                                              */
/* ------------------------------------------------------------------ */

/** Effective atmospheric transmittance (1 = no greenhouse, 0.5965 = Earth today). */
export function effectiveTau(p, tGlobal = BASE.tRef) {
  const co2 = Math.max(0.5, p.co2);
  const ch4 = Math.max(0, p.ch4);
  const n2o = Math.max(0, p.n2o);
  const dCo2 = KAPPA_CO2 * Math.log(co2 / BASE.co2Ref) * (p.ghgCO2 ?? 1);
  const dCh4 = KAPPA_CH4 * (Math.log1p(ch4 / 1000) - Math.log1p(BASE.ch4Ref / 1000)) * (p.ghgCH4 ?? 1);
  const dN2o = KAPPA_N2O * (Math.log1p(n2o / 100) - Math.log1p(BASE.n2oRef / 100)) * (p.ghgN2O ?? 1);
  const dH2O = KAPPA_H2O * (tGlobal - BASE.tRef) * (p.ghgH2O ?? 1)
    * (0.4 + 0.6 * clamp(p.humidity / BASE.humRef, 0, 2));
  const dP = KAPPA_PRESSURE * Math.log(Math.max(1e-4, p.pressure) / BASE.pressRef);
  return clamp(BASE.tauRef - dCo2 - dCh4 - dN2o - dH2O - dP, 0.05, 1);
}

export function cloudAlbedo(p) { return CLOUD_ALBEDO_MAX * clamp(p.cloud / 100, 0, 1.5); }

/** Cloud albedo from a per-cell cloud fraction (0..1). */
export function cloudAlbedoAt(cover) {
  return CLOUD_ALBEDO_MAX * clamp(cover, 0, 1.5);
}

export function aerosolForcing(p) {
  return -AEROSOL_FORCING * clamp(p.aerosolLoad ?? 0, 0, 2) * Math.pow(clamp(p.pressure, 0.001, 200), 0.15);
}

/**
 * Shortwave forcing (W/m²) of a *per-cell* aerosol/dust optical depth. The sign
 * is negative (dimming); a dust load of 1 is worth about -22 W/m², and the
 * meteor impact winter rides on top of this through `grid.dust`.
 */
export function aerosolForcingAt(p, load) {
  return -AEROSOL_FORCING * clamp(load, 0, 6) * Math.pow(clamp(p.pressure, 0.001, 200), 0.15);
}

/**
 * Rebuild the per-cell cloud fraction and aerosol load.
 *
 * These close two feedback loops that were previously open: the cloud albedo
 * used to come from a single global parameter, and the aerosol forcing from the
 * `aerosolLoad` slider alone — so the *computed* humidity and dust fields were
 * display-only. Now relative humidity, wind convergence (rising air), dust load
 * and volcanic/impact dust all feed back into the shortwave budget.
 */
export function updateCloudAerosol(grid, p, impactDust = 0) {
  const { NB, NL } = grid;
  const baseCloud = clamp(p.cloud / 100, 0, 1.5);
  const baseAer = clamp(p.aerosolLoad ?? 0, 0, 2);
  for (let j = 0; j < NB; j++) {
    const conv = clamp(grid.zonalConvergence ? grid.zonalConvergence[j] : 0, -1, 2);
    for (let i = 0; i < NL; i++) {
      const k = i + j * NL;
      const rh = clamp(grid.humidity[k] / 100, 0, 1.2);
      // cloud = parameter baseline, modulated by local humidity and rising air
      const cover = clamp(baseCloud * (0.35 + 0.85 * rh) * (1 + 0.22 * conv), 0, 1);
      grid.cloudCover[k] = cover;
      // dust: the slider, plus wind-blown dust over dry land, plus impact dust
      const wind = clamp(Math.abs(grid.windSpeed[k]) / 18, 0, 1.6);
      const dryLand = (grid.ocean[k] > 0.5 ? 0 : 1) * clamp(grid.dryness[k], 0, 1) * wind;
      grid.dust[k] = Math.max(0, impactDust);
      grid.aerosol[k] = clamp(baseAer * (0.45 + 0.55 * wind) + dryLand * 0.35 + impactDust, 0, 6);
    }
  }
  return grid;
}

export function equilibriumTemp(absorbedFlux, tau) {
  return Math.pow(Math.max(0.01, absorbedFlux) / (Math.max(0.05, tau) * SIGMA), 0.25);
}

/* ------------------------------------------------------------------ */
/* grid                                                                */
/* ------------------------------------------------------------------ */

export function makeGrid(NB, NL) {
  const n = NB * NL;
  const lats = new Float64Array(NB);
  const sinLat = new Float64Array(NB);
  const cosLat = new Float64Array(NB);
  const areaFrac = new Float64Array(NB);
  for (let j = 0; j < NB; j++) {
    const lat = 90 - (j + 0.5) * (180 / NB);
    lats[j] = lat;
    sinLat[j] = Math.sin(lat * Math.PI / 180);
    cosLat[j] = Math.cos(lat * Math.PI / 180);
    areaFrac[j] = cosLat[j];
  }
  // Area weight of one cell, normalised so that sum(areaFrac * NL) === 1 over
  // the whole grid. This is the weight used by every global average.
  let bandTotal = 0;
  for (let j = 0; j < NB; j++) bandTotal += cosLat[j];
  for (let j = 0; j < NB; j++) areaFrac[j] = cosLat[j] / (bandTotal * NL);

  const f = (name) => (grid[name] = new Float32Array(n));
  const grid = {
    NB, NL, n, lats, sinLat, cosLat, areaFrac,
    dyM: DEG_M * (180 / NB),
    dxM: 2 * Math.PI * EARTH_RADIUS_M / NL,
    monthAccum: 0,
    seasonMonths: 0,
    iceVolumeM3: 0,
  };
  for (const name of [
    'T', 'ice', 'snow', 'ocean', 'h', 'albedoSurf', 'albedo', 'absorbed', 'olr', 'net',
    'precip', 'humidity', 'vegetation', 'toxicity', 'aerosol', 'habitability', 'diurnal',
    'seaIce', 'biomass', 'tSeasonMean', 'pSeasonMean', 'tSeasonMax', 'tSeasonMin',
    'pSeasonMax', 'pSeasonMin', 'tAnnual', 'pAnnual', 'dryness', 'tAnomaly',
    'tFiltered', 'tWarm', 'dhdx', 'dhdy', 'snowCover', 'iceFrac',
    'hPeak', 'hSub',
    'windU', 'windV', 'windSpeed', 'currentU', 'currentV', 'currentSpeed', 'upwelling',
    'moisture', 'currentKind', 'cloudCover', 'dust', 'windLift', 'riverNear', 'habitabilityLand',
  ]) f(name);
  // baseline values so the very first sub-step has a usable albedo/forcing field
  for (let k = 0; k < n; k++) { grid.cloudCover[k] = 0.55; grid.aerosol[k] = 0.1; }
  // circulation fields are zonal-mean in latitude (band-indexed) plus per-cell
  grid.zonalWind = new Float64Array(NB);
  grid.zonalWindV = new Float64Array(NB);
  grid.zonalWindSpeed = new Float64Array(NB);
  grid.zonalConvergence = new Float64Array(NB);
  // air-column temperature, one value per latitude band
  grid.airT = new Float64Array(NB);
  for (let j = 0; j < NB; j++) grid.airT[j] = 288;
  for (let k = 0; k < n; k++) { grid.tFiltered[k] = 288; grid.tWarm[k] = 288; }
  // rolling 12-month buffers used for the seasonal-range layers
  grid.tBuf = new Float32Array(n * 12);
  grid.pBuf = new Float32Array(n * 12);
  grid.filterReady = false;
  grid.warmReady = false;
  grid.seasonReady = false;
  grid.seasonCount = new Uint16Array(n);
  grid.pSeasonCount = new Uint16Array(n);
  buildTemperatureShape(grid);
  return grid;
}

/**
 * Seed the temperature field from a requested global mean.
 *
 * The latitudinal *shape* used to come from the local radiative equilibrium,
 * which on a slab model is absurd — with no sunlight the pole comes out near
 * 0 K, so the planet started with 90 K poles and needed years of transport to
 * climb out of it. That spin-up transient looked exactly like "the climate is
 * cooling down on its own".
 *
 * This uses an Earth-like annual-mean profile instead: +16 K at the equator,
 * −31 K at the poles (area-weighted mean 0), i.e. what the circulation actually
 * produces.
 */
export function initialTemperature(grid, tMean, tau) {
  const { NB, NL, lats, T } = grid;
  void tau;
  for (let j = 0; j < NB; j++) {
    const s2 = Math.sin(lats[j] * Math.PI / 180) ** 2;
    const t = clamp(tMean + (15.7 - 47 * s2), 90, 800);
    for (let i = 0; i < NL; i++) T[i + j * NL] = t;
  }
  return grid;
}

/* ------------------------------------------------------------------ */
/* physics helpers                                                     */
/* ------------------------------------------------------------------ */

function surfaceAlbedoOf(p, veg, dryness, oceanFrac) {
  const desert = clamp(dryness, 0, 1);
  const bulk = (p.bareAlbedo * (1 - veg) + p.vegAlbedo * veg) * (1 - desert) + p.desertAlbedo * desert * (1 - veg * 0.5);
  const open = p.oceanAlbedo;
  return open * oceanFrac + bulk * (1 - oceanFrac);
}

/**
 * Cover fraction of permanent ice / snow from the annual-mean temperature.
 *
 * The width and shape of this transition set how strong the ice–albedo feedback
 * is, and that feedback is the one thing in this model that can run away: if the
 * cover swings from 0 to 1 within a few kelvin the marginal zone flips almost at
 * once, the local gain exceeds the Planck response and the planet bifurcates into
 * a snowball (a 420 → 280 ppm CO₂ change would be enough). A wide, smoothstep
 * transition keeps the gain well below the Planck response, so the warm branch
 * stays stable across the whole preset range while the ice edge still moves
 * realistically with the climate.
 */
const COVER_MID = 268.0;
// 24 K spans roughly 244–292 K of annual mean: the ice edge then moves several
// degrees of latitude per kelvin of warming instead of flipping all at once, which
// is what keeps the snowball bifurcation far enough away (measured: the runaway
// needs ~19 W/m² more reflected sunlight than the Earth default reflects).
// See COVER_WIDTH_REPORT in the calibration notes.
const COVER_WIDTH = 24.0;
function coverFromTemperature(tAnnual) {
  const x = clamp((COVER_MID - tAnnual) / COVER_WIDTH + 0.5, 0, 1);
  return x * x * (3 - 2 * x);          // smoothstep: no kink at either end
}
export function snowCoverFraction(tAnnual) {
  return coverFromTemperature(tAnnual);
}
/**
 * Sea-ice *area* from the annual-mean temperature only.
 *
 * The thickness is deliberately not an input any more. It used to gate the area
 * (a thin, marginal ice sheet covered only part of its extent), and because the
 * thickness relaxes towards its target over ~10 years the *albedo* kept creeping
 * up for half a century — which showed up as the planetary mean temperature
 * sliding from 288 K towards 285 K for decades with no CO₂ change at all. Ice
 * area is set by climate (summer melt); thickness only matters for volume and
 * sea level.
 */
export function seaIceFraction(tAnnual) {
  return coverFromTemperature(tAnnual);
}
export function landIceFraction(tAnnual) {
  // Continental ice sheets only exist where the *annual mean* is far below
  // freezing (Greenland/Antarctica-like). Using a 0 °C annual mean here would
  // ice over every temperate latitude and inflate the ice volume ~3x.
  return clamp((253.15 - tAnnual) / 8.0, 0, 1);
}

/** Steady-state ice thickness for a temperature (m); used to seed a new world. */
export function iceThicknessTarget(tInst, p, ocean) {
  const freeze = 273.15;
  const iceScale = (p.iceTempScale ?? 0.42) * (p.iceFlow ?? 1);
  if (tInst >= freeze) return 0;
  return ocean > 0.5
    ? clamp((freeze - tInst) * iceScale * 0.30, 0, 3.0)
    : clamp((freeze - tInst) * iceScale * 0.16, 0, 1.5);
}

/**
 * Fill grid.albedoSurf / grid.albedo including snow, ice and cloud cover.
 *
 * The cloud term is taken from the *predicted* per-cell cloud fraction when it
 * exists (`updateCloudAerosol` fills it every sub-step), so humidity and wind
 * convergence reach the energy budget through the albedo. The `cloudA` argument
 * is only a fallback for callers that run before the first sub-step.
 */
export function surfaceAlbedoPass(grid, p, cloudA) {
  for (let k = 0; k < grid.n; k++) {
    const ocean = grid.ocean[k];
    let a = surfaceAlbedoOf(p, grid.vegetation[k], grid.dryness[k], ocean);
    // snow and ice are combined with max() rather than summed, so a snowy
    // mountainside and a sea-ice floe cannot "double brighten" the same cell.
    const bright = ocean > 0.5 ? grid.iceFrac[k] : Math.max(grid.snowCover[k], grid.iceFrac[k]);
    const brightAlbedo = ocean > 0.5 ? p.iceAlbedo : p.snowAlbedo;
    a = a * (1 - bright) + brightAlbedo * bright;
    grid.albedoSurf[k] = a;
    const cA = grid.cloudCover ? cloudAlbedoAt(grid.cloudCover[k]) : cloudA;
    grid.albedo[k] = clamp(a * (1 - cA) + cA, 0.02, 0.92);
  }
  return grid;
}

export function cellHeatCapacity(p, oceanFrac) {
  const land = (p.landHeatCapacity ?? 1.2) * 2.66e6;
  const sea = (p.oceanHeatCapacity ?? 12) * 2.66e6;
  return land * (1 - oceanFrac) + sea * oceanFrac;
}

/* ------------------------------------------------------------------ */
/* two-layer atmosphere + surface                                     */
/* ------------------------------------------------------------------ */

/**
 * Air column heat capacity (J m⁻² K⁻¹). The atmosphere is thin — one tenth of
 * the ocean mixed layer — which is why air temperature tracks the seasons
 * quickly and why the polar night has to be resupplied by transport.
 */
export function airHeatCapacity(p) {
  const scale = clamp(p.pressure ?? 1, 0.001, 200);
  // Earth: ~1e7 J m⁻² K⁻¹ at 1 atm; on a thin atmosphere the column stores less
  return 1.05e7 * Math.pow(scale, 0.85);
}

/**
 * Surface-to-air exchange coefficient (W m⁻² K⁻¹).
 *
 * This is the *net* sensible + latent exchange between the ground and the air
 * column — not the raw bulk aerodynamic coefficient, which in the real
 * atmosphere is largely cancelled by the downward longwave beam. Earth's value
 * is ~100 W m⁻² over a ~30 K surface/air contrast, i.e. a few W m⁻² K⁻¹.
 *
 * It scales with wind speed and with pressure, and is larger over ocean than
 * over land — the same reason maritime climates have far smaller seasonal
 * swings than continental ones.
 *
 * The wind dependence is the standard bulk one, k ∝ U^0.8, anchored so that at the
 * global-mean wind this returns exactly what the previous linear-in-U form did. The
 * old form clamped U/12 at a floor of 0.25, which saturated for winds below 3 m/s —
 * and since adding surface roughness most land now sits below that, so the floor
 * would have thrown away the wind dependence over every continent.
 */
export function surfaceAirCoupling(p, oceanFrac, windSpeed) {
  const u = Math.max(0.2, windSpeed);
  const wind = clamp(Math.pow(u / WIND_COUPLING_REF, 0.8) * (WIND_COUPLING_REF / 12), 0.08, 3);
  const press = Math.pow(clamp(p.pressure ?? 1, 0.001, 200), 0.5);
  const base = oceanFrac > 0.5 ? 14 : 7;
  return base * wind * press;
}

/**
 * Implicit meridional transport on the air-temperature profile.
 *
 * D is an eddy diffusivity in m²/s; the poleward flux is −D·∂T/∂y, tapered by
 * cos φ for area convergence, with zero flux at both poles. The system is solved
 * with a tridiagonal elimination (Crank–Nicolson style), which is stable at any
 * timestep — necessary here because Earth's required D ≈ 1.2e7 m²/s would blow up
 * an explicit scheme at monthly steps.
 */
export function transportAirStep(grid, p, dtS) {
  const { NB, airT, cosLat, lats } = grid;
  // Atmospheric eddy transport only. The ocean's share of the poleward heat
  // transport is now explicit — see currentHeatStep, which advects surface heat
  // along the actual current field — so this stays at 1.00 for the defaults.
  const master = Math.max(0, p.transport ?? 1);
  const atmos = Math.max(0, p.atmosphericCirculation ?? 1);
  const D0 = 4.2e7 * master * (0.55 + 0.45 * atmos);
  const dy = grid.dyM;
  const dy2 = dy * dy;
  const a = grid._airA || (grid._airA = new Float64Array(NB));
  const b = grid._airB || (grid._airB = new Float64Array(NB));
  const c = grid._airC || (grid._airC = new Float64Array(NB));
  const d = grid._airD || (grid._airD = new Float64Array(NB));
  const sol = grid._airSol || (grid._airSol = new Float64Array(NB));
  const mu = grid._airMu || (grid._airMu = new Float64Array(NB));

  for (let j = 0; j < NB; j++) {
    const cl = Math.max(0.08, cosLat[j]);
    // Deliberately NOT clamped: the tridiagonal solve is unconditionally stable,
    // so this is the true diffusion number and may exceed 1. An explicit-scheme
    // stability clamp here would silently pin the transport at a single value for
    // every setting of the slider.
    mu[j] = D0 * cl * dtS / dy2;
  }

  for (let j = 0; j < NB; j++) {
    const t = Math.max(70, airT[j]);
    // Divide the row by the band's area weight: that is what makes the scheme
    // conserve the *area-weighted* total Σ(cosφ·T) rather than just ΣT. Without
    // it, every poleward exchange moves heat into a band representing far less
    // surface area and the planet quietly loses energy each step — visible as a
    // steady 2-3 K per 40 years cooling drift with no greenhouse change. The
    // weight is the true cos(lat) (not a clamped one) so the conserved quantity is
    // exactly the one the global averages use.
    const area = Math.max(1e-3, cosLat[j]);
    const north = j > 0 ? mu[j - 1] / area : 0;
    const south = j < NB - 1 ? mu[j] / area : 0;
    // Zero flux at both poles. The air temperature is the transported quantity;
    // the polar relaxation in the surface step couples it back to the ground.
    a[j] = -north;
    c[j] = -south;
    b[j] = 1 + north + south;
    d[j] = t;
  }
  solveTridiagonal(a, b, c, d, sol, NB);
  for (let j = 0; j < NB; j++) airT[j] = clamp(sol[j], 70, 700);
  return airT;
}

/**
 * Surface current, upwelling and current-kind fields.
 *
 * Split out of the water cycle so the energy step can use them: the currents are
 * a *predicted* field that then advects surface heat (see currentHeatStep), which
 * is what makes the 洋流强度 slider a climate control rather than a picture.
 */
export function updateCurrentField(grid, p) {
  const { NB, NL } = grid;
  const strength = p.oceanCirculation ?? 1;
  // SST gradient drives the geostrophic part of the flow (thermal wind): a
  // stronger meridional temperature contrast means a stronger gyre.
  const sstGrad = grid._sstGrad || (grid._sstGrad = new Float32Array(grid.n));
  const gradRef = 9e-6;                       // K/m, ≈1 K per 110 km
  for (let j = 0; j < NB; j++) {
    const jn = Math.min(NB - 1, j + 1), js = Math.max(0, j - 1);
    for (let i = 0; i < NL; i++) {
      const k = i + j * NL;
      const dt = (grid.T[i + jn * NL] - grid.T[i + js * NL]) * 0.5;
      sstGrad[k] = Math.abs(dt) / Math.max(1, grid.dyM);
    }
  }
  let sum = 0, windSum = 0;
  for (let j = 0; j < NB; j++) {
    const lat = grid.lats[j];
    for (let i = 0; i < NL; i++) {
      const k = i + j * NL;
      const lon = (i + 0.5) / NL * 360 - 180;
      const gyreScale = clamp(sstGrad[k] / gradRef, 0.45, 1.8);
      const env = {
        windU: grid.windU[k], windV: grid.windV[k], gyreScale,
        // Real coastline geometry: this is what anchors the boundary currents to the
        // land the user actually generated. See physics/coast.js.
        coast: coastAt(grid, k),
      };
      const cur = currentAt(lat, lon, strength, grid.ocean[k], env);
      grid.currentU[k] = cur.u;
      grid.currentV[k] = cur.v;
      grid.currentSpeed[k] = cur.speed;
      grid.upwelling[k] = upwellingFactor(lat, lon, strength, grid.ocean[k], env);
      grid.currentKind[k] = cur.kind === 'western-boundary' ? 1 : cur.kind === 'eastern-boundary' ? 2
        : cur.kind === 'equatorial' ? 3 : cur.kind === 'polar' ? 4 : 0;
      sum += cur.speed * grid.areaFrac[j];
      windSum += Math.hypot(grid.windU[k], grid.windV[k]) * grid.areaFrac[j];
    }
  }
  grid.currentSpeedMean = sum;
  grid.windSpeedMean = windSum;
  return grid;
}

/**
 * Impact ("impact winter") dust load.
 *
 * A meteor shower is modelled by the *climate* effect that actually matters on
 * human timescales: the impact energy vaporises rock and throws dust and sulfate
 * into the stratosphere, which dims the sun for years. The load is a saturating
 * function of the total impactor mass, so one 1e17 kg impactor and a thousand
 * 1e14 kg impactors are comparable — which is roughly how the atmospheric dust
 * budget works — and it decays with a ~2 year e-folding time.
 *
 * The immediate fireball heating is *not* modelled as a global temperature spike
 * (the energy is real but it is deposited into a tiny area and radiated away in
 * hours); instead a fraction of it is delivered to the impact cell, which keeps
 * the local response visible without blowing up the timestep.
 *
 * The load is a *reservoir*: every meteor's production decays from its own impact
 * month (see World.dustReservoir), so a bombardment spread over years accumulates
 * and then fades instead of all of the dust being tied to the most recent impact.
 */
export function meteorDustLoad(world) {
  if (!world || !world.impact) return 0;
  if (typeof world.dustLoadAt === 'function') {
    return world.dustLoadAt(world.time.month || 0);
  }
  // fallback for a bare record without the reservoir helpers
  const imp = world.impact;
  if (!imp.month) return 0;
  const age = Math.max(0, (world.time.month || 0) - imp.month) / 12;   // years
  return imp.load * Math.exp(-age / (imp.decayYears || 2.2));
}

export function meteorTotalMass(p) {
  return Math.max(0, p.meteorMass ?? 0) * Math.max(1, Math.round(p.meteorCount ?? 1));
}

/**
 * Dust load for a given total impactor mass (kg).
 * 1e12 kg ⇒ negligible, 1e15 kg ⇒ a big regional event, 1e18 kg ⇒ a Chicxulub-
 * class impact winter, 1e21 kg ⇒ a sterilising global dust shroud.
 */
export function dustLoadForMass(totalMass) {
  if (!(totalMass > 0)) return 0;
  return clamp((Math.log10(totalMass) - 12) / 3.2, 0, 3);
}

/**
 * Per-cell surface wind: the zonal three-cell pattern *plus* the topography.
 *
 * Three effects matter and none of them existed before:
 *   - **blocking**: the flow slows down over high, rough ground (the same
 *     pressure gradient has to move thinner air, and friction is larger);
 *   - **deflection / diversion**: over a slope the flow is turned along the
 *     contours, which is what puts a windward/leeward contrast on a ridge and
 *     makes wind funnel through gaps;
 *   - **local circulations**: a sea/land breeze (towards the warmer surface, the
 *     same mechanism that drives monsoons) near coastlines, and an anabatic
 *     (upslope) component over sun-warmed high ground.
 *
 * `grid.windLift[k]` is the resulting orographic vertical motion U·∇h, which the
 * water cycle uses for windward-side rainfall.
 */
export function updateWindField(grid, p) {
  const { NB, NL } = grid;
  const breezeGain = 0.9 * Math.max(0, p.atmosphericCirculation ?? 1);
  const wrap = (i) => ((i % NL) + NL) % NL;
  /* ---- pass 0: the zonal base flow and the raw terrain forcing ---- */
  // `grid._windLift` is computed first for every cell because the lee-side terms in
  // pass 1 need to know what the flow met *upwind*: a wind shadow only exists
  // downwind of something tall.
  const face = grid._windFace || (grid._windFace = new Float32Array(grid.n));
  for (let j = 0; j < NB; j++) {
    const u0 = grid.zonalWind[j];
    const v0 = grid.zonalWindV[j];
    for (let i = 0; i < NL; i++) {
      const k = i + j * NL;
      const hx = grid.dhdx[k], hy = grid.dhdy[k];
      // Signed upslope gradient the base flow actually faces. A ridge *across* the
      // flow has a large value; one the flow runs along has almost none. This is what
      // makes blocking depend on the wind direction rather than on height alone.
      const sp = Math.hypot(u0, v0);
      face[k] = sp > 1e-6 ? (u0 * hx + v0 * hy) / sp : 0;
    }
  }

  /* ---- pass 0b: land-minus-sea contrast per latitude band, for the sea breeze ---- */
  // A single scalar per band rather than a local anomaly: the breeze is driven by
  // how much warmer the land is than the sea at that latitude.
  let bandContrast = null;
  if (grid.coastReady) {
    bandContrast = grid._bandContrast || (grid._bandContrast = new Float64Array(NB));
    for (let j = 0; j < NB; j++) {
      let landSum = 0, landN = 0, seaSum = 0, seaN = 0;
      for (let i = 0; i < NL; i++) {
        const k = i + j * NL;
        if (grid.ocean[k] > 0.5) { seaSum += grid.T[k]; seaN++; }
        else { landSum += grid.T[k]; landN++; }
      }
      const landT = landN ? landSum / landN : (seaN ? seaSum / seaN : 288);
      const seaT = seaN ? seaSum / seaN : landT;
      bandContrast[j] = clamp((landT - seaT) / 8, -1, 1);
    }
  }

  /* ---- pass 1: per-cell wind ---- */
  for (let j = 0; j < NB; j++) {
    const u0 = grid.zonalWind[j];
    const v0 = grid.zonalWindV[j];
    const base = Math.max(0.4, Math.hypot(u0, v0));
    // discretise the base flow to one of 8 neighbours so we can sample upwind
    const sp = Math.max(1e-6, base);
    const si = Math.abs(u0) / sp > 0.38 ? Math.sign(u0) : 0;
    const sj = Math.abs(v0) / sp > 0.38 ? -Math.sign(v0) : 0;
    for (let i = 0; i < NL; i++) {
      const k = i + j * NL;
      const hx = grid.dhdx[k], hy = grid.dhdy[k];
      const gmag = Math.hypot(hx, hy);
      // The blocking height is the *sub-grid peak*, not the cell mean: a 417 km cell
      // averaging 900 m can still hold a 2.4 km peak, and it is the peak the flow
      // actually runs into. Cell means made every mountain in this model invisible
      // (they top out near 2.3 km, so height/3200 hardly ever exceeded 0.7).
      const hBlock = Math.max(0, grid.hPeak[k] || grid.h[k]);

      // 1) blocking, as the non-dimensional mountain height N·h/U. This is the
      //    standard criterion for whether stratified flow goes over a ridge or around
      //    it, and it makes blocking depend on the *wind speed* as well as the
      //    terrain: light winds are blocked by hills that a gale sweeps straight over.
      //    `align` then says whether the ridge lies across the flow (blocked hard) or
      //    along it (barely slowed) — with only height in the formula, a ridge the
      //    wind runs parallel to used to block exactly as much as one facing it.
      const speed0 = Math.max(1.5, base);
      const NhU = (N_STABILITY * hBlock) / speed0;
      const align = gmag > 1e-9
        ? Math.abs(u0 * hx + v0 * hy) / (Math.max(1e-6, base) * gmag)
        : 0;
      const block = 1 / (1 + 0.5 * NhU * (0.25 + 0.75 * align) + 0.35 * (grid.hSub[k] || 0) / 1500);

      // 2) surface roughness: land is far rougher than open water, so the same
      //    pressure gradient produces a markedly slower wind over a continent. This
      //    was missing entirely — the wind field was almost blind to the coastline.
      const rough = grid.ocean[k] > 0.5 ? 1 : LAND_ROUGHNESS;

      // 3) deflection along the contours, keeping the base flow's sense. Slopes are
      //    in m/km (p99 ≈ 12), so the reference is 14 m/km.
      let u = u0 * block * rough, v = v0 * block * rough;
      if (gmag > 1e-7) {
        let cx = -hy / gmag, cy = hx / gmag;
        if (cx * u0 + cy * v0 < 0) { cx = -cx; cy = -cy; }
        const w = clamp(gmag / 14, 0, 0.92);
        const along = base * block * rough;
        u = u * (1 - w) + cx * along * w;
        v = v * (1 - w) + cy * along * w;
      }

      // 4) lee side: sample the terrain and the forced ascent one cell upwind.
      //    Climbing a ridge and then descending means a wind shadow followed by
      //    downslope (foehn) acceleration; still climbing means the flow stays blocked.
      //    Thresholds are in m/km, matching `face` — an earlier version used 0.2,
      //    which every slope in this terrain exceeds, so the branch fired everywhere.
      let shadow = 1;
      if (si !== 0 || sj !== 0) {
        const ui = wrap(i + (si > 0 ? -1 : si < 0 ? 1 : 0));
        const uj = clamp(j + (sj > 0 ? -1 : sj < 0 ? 1 : 0), 0, NB - 1);
        const uk = ui + uj * NL;
        const upRise = face[uk];
        const here = face[k];
        if (upRise > 2.5 && here < -2.5) {
          const climb = Math.min(2.5, (upRise - here) / 8);
          shadow = 1 + 0.22 * climb;                        // downslope acceleration
        } else if (here > 3) {
          shadow = 1 / (1 + 0.7 * Math.min(2.5, here / 8)); // windward, still blocked
        }
        const dh = (grid.hPeak[uk] || 0) - hBlock;
        if (dh > 300 && here <= 2) {
          shadow *= 1 / (1 + Math.min(1.4, dh / 1800));     // sheltered by what is upwind
        }
      }
      u *= shadow; v *= shadow;

      // 5) gap funnelling: if the terrain to either side (along the contours) is much
      //    higher, the air is squeezed through the gap and speeds up.
      if (gmag > 1e-7) {
        const cxu = -hy / gmag, cyu = hx / gmag;         // unit along the contours
        const li = wrap(Math.round(i + cxu)); const lj = clamp(Math.round(j - cyu), 0, NB - 1);
        const ri = wrap(Math.round(i - cxu)); const rj = clamp(Math.round(j + cyu), 0, NB - 1);
        const hl = grid.h[li + lj * NL], hr = grid.h[ri + rj * NL];
        const wall = Math.min(hl - grid.h[k], hr - grid.h[k]);
        if (wall > 300) {
          const f = 1 + 0.5 * Math.min(1.5, wall / 1800);
          u *= f; v *= f;
        }
      }

      // 5) sea / land breeze: blow toward the warmer surface. The driver is the
      //    *land-minus-sea* temperature contrast of the latitude band, so a warm
      //    continent draws air onshore (the sea breeze, and the mechanism behind
      //    monsoons) while a cold one pushes air offshore. It decays with distance
      //    from the shoreline on both sides, and it previously used the departure
      //    from the zonal mean — which is mostly a *longitudinal* anomaly and so
      //    barely related to the land/sea contrast at all.
      if (grid.coastReady) {
        const shoreKm = grid._shoreKm[k];
        if (shoreKm < COASTAL_BREEZE_KM) {
          const ox = (grid.ocean[wrap(i + 1) + j * NL] - grid.ocean[wrap(i - 1) + j * NL]) * 0.5;
          const oy = (grid.ocean[i + Math.min(NB - 1, j + 1) * NL] - grid.ocean[i + Math.max(0, j - 1) * NL]) * 0.5;
          const omag = Math.hypot(ox, oy);
          if (omag > 1e-6 && bandContrast) {
            // -∇(ocean fraction) points from the sea toward the land
            const push = breezeGain * bandContrast[j] * 2.6 * Math.exp(-shoreKm / COASTAL_BREEZE_KM);
            u += (-ox / omag) * push;
            v += (-oy / omag) * push;
          }
        }
      }
      // 5b) anabatic (upslope) flow over warm high ground
      if (gmag > 1e-7 && grid.h[k] > 200) {
        const warm = clamp((grid.T[k] - (grid._zonalT ? grid._zonalT[j] : grid.T[k])) / 10, -1, 1);
        const a = breezeGain * warm * 0.8 * clamp(gmag * 500, 0, 1);
        u += (hx / gmag) * a;
        v += (hy / gmag) * a;
      }

      grid.windU[k] = u;
      grid.windV[k] = v;
      grid.windSpeed[k] = Math.hypot(u, v);
      // orographic lifting: w = U·∇h (positive = upslope = forced ascent)
      grid.windLift[k] = u * hx + v * hy;
    }
  }
  return grid;
}

/**
 * Ocean heat transport and upwelling.
 *
 * The advection is upwind differencing along the *actual* current field, applied
 * as an antisymmetric exchange between each ocean cell and its upwind neighbour,
 * so the pair gains and loses exactly the same amount and the global energy
 * budget is untouched — currents only move heat around. This term carries the
 * ocean's share of the poleward heat transport (the Gulf-Stream / Kuroshio
 * effect) and scales with 洋流强度.
 *
 * Upwelling is a genuine sink: it brings cold deep water to the surface, which is
 * why eastern-boundary currents and the equatorial cold tongue are cold.
 */
export function currentHeatStep(grid, p, dtS) {
  const { NB, NL, T } = grid;
  const strength = clamp(p.oceanCirculation ?? 1, 0, 3);
  if (strength <= 1e-4) return grid;
  const cellW = 2 * Math.PI * EARTH_RADIUS_M / NL;
  const cellH = DEG_M * (180 / NB);

  for (let j = 0; j < NB; j++) {
    const cosLat = Math.max(0.08, Math.cos(grid.lats[j] * Math.PI / 180));
    for (let i = 0; i < NL; i++) {
      const k = i + j * NL;
      if (grid.ocean[k] < 0.5) continue;
      const u = grid.currentU[k], v = grid.currentV[k];
      const speed = Math.hypot(u, v);
      if (speed < 0.03) continue;
      // one cell upstream, along the dominant component
      const zonal = Math.abs(u) >= Math.abs(v) && Math.abs(u) > 1e-6;
      const di = zonal ? (u > 0 ? -1 : 1) : 0;
      const dj = zonal ? 0 : (v > 0 ? -1 : 1);
      const uj = clamp(j + dj, 0, NB - 1);
      const ui = ((i + di) % NL + NL) % NL;
      const uk = ui + uj * NL;
      if (grid.ocean[uk] < 0.5) continue;
      const t0 = Math.max(70, T[k]);
      const t1 = Math.max(70, T[uk]);
      const L = zonal ? Math.max(1e5, cellW * cosLat) : cellH;
      // upwind advection: dT = U*dt/L * (T_upstream - T_local), deliberately
      // scaled down. The gyre field is largely zonal and the atmosphere is the
      // dominant heat pipe in this model, so this term exists to shape SST
      // patterns (warm western boundary, cold eastern boundary) rather than to
      // carry the planet's heat budget.
      let dT = 0.10 * OCEAN_TUNING.advection * (speed * dtS / L) * (t1 - t0);
      const maxMove = 0.02 * Math.abs(t1 - t0);
      dT = clamp(dT, -maxMove, maxMove);
      // Meridional pairs sit in bands of different area, so the *energy* exchanged
      // has to be divided by each band's weight to conserve Σ(cosφ·T).
      const wS = zonal ? 1 : Math.max(1e-3, cosLat);
      const wN = zonal ? 1 : Math.max(1e-3, Math.cos(grid.lats[uj] * Math.PI / 180));
      T[k] = clamp(t0 + dT * wS / wS, 70, 900);
      T[uk] = clamp(t1 - dT * wS / wN, 70, 900);
    }
  }

  // upwelling: cold deep water replacing the surface layer. It can only *cool* —
  // relaxing toward the deep-water temperature unconditionally would warm a
  // surface that is already colder than the abyss.
  const upwellingRate = 1.6 * Math.sqrt(strength) * OCEAN_TUNING.upwelling;                  // W m⁻² K⁻¹ at upwelling = 1
  for (let j = 0; j < NB; j++) {
    for (let i = 0; i < NL; i++) {
      const k = i + j * NL;
      const up = grid.upwelling[k];
      if (up <= 0.01 || grid.ocean[k] < 0.5) continue;
      const t = Math.max(70, T[k]);
      const target = Math.min(t, UPWELL_TARGET_K);
      const C = cellHeatCapacity(p, 1);
      const alpha = 1 - Math.exp(-upwellingRate * up * dtS / C);
      T[k] = clamp(t + alpha * (target - t), 70, 900);
    }
  }
  return grid;
}

/**
 * Meridional overturning (thermohaline) heat transport.
 *
 * Gyre circulation is mostly zonal, so upwind advection alone barely moves heat
 * poleward — yet the real ocean carries about a quarter of the planet's poleward
 * heat transport, and it is that convergence at 30–60° that keeps the North
 * Atlantic and the Southern Ocean habitable. This term prescribes it directly:
 * a poleward flux profile that vanishes at the equator and at ~60° (the shape of
 * the observed ocean heat transport).
 *
 * The exchange is written as an energy flux divided by the receiving band's area
 * weight, so Σ(cosφ·T) is conserved: the same joules raise the temperature of a
 * small polar band more than they lower a wide tropical one.
 */
export function overturningHeatStep(grid, p, dtS) {
  const { NB, NL } = grid;
  const T = grid.T;
  const strength = clamp(p.oceanCirculation ?? 1, 0, 3);
  if (strength <= 1e-4) return grid;
  // 0.6 PW total at strength 1. Earth's ocean carries ~2 PW, but most of that is
  // the Atlantic overturning acting on a basin geometry this model does not
  // resolve; prescribing the full value here over-cools the tropics by ~8 K and
  // then the ice-albedo feedback does the rest, so the share is deliberately
  // conservative.
  const F0 = 1.5e13 * strength * OCEAN_TUNING.overturning;           // W per longitude strip
  const cellArea = (2 * Math.PI * EARTH_RADIUS_M / NL) * (DEG_M * (180 / NB));
  const prof = (lat) => {
    const a = Math.abs(lat);
    if (a >= 60) return 0;
    return Math.sin(Math.PI * a / 60);
  };
  for (let j = 0; j < NB - 1; j++) {
    const latMid = 0.5 * (grid.lats[j] + grid.lats[j + 1]);
    const sign = latMid >= 0 ? 1 : -1;
    const flux = sign * F0 * prof(latMid);        // northward positive
    if (Math.abs(flux) < 1) continue;
    const areaS = Math.max(1e-3, Math.cos(grid.lats[j] * Math.PI / 180));
    const areaN = Math.max(1e-3, Math.cos(grid.lats[j + 1] * Math.PI / 180));
    const dS = flux * dtS / (cellHeatCapacity(p, 1) * cellArea * areaS);
    const dN = flux * dtS / (cellHeatCapacity(p, 1) * cellArea * areaN);
    for (let i = 0; i < NL; i++) {
      const k = i + j * NL;
      const north = i + (j + 1) * NL;
      if (grid.ocean[k] < 0.5 || grid.ocean[north] < 0.5) continue;
      T[k] = clamp(T[k] - dS, 70, 900);
      T[north] = clamp(T[north] + dN, 70, 900);
    }
  }
  return grid;
}

/**
 * Advance the surface + air-column system one sub-step.
 *
 *   surface:  C_s dTs/dt = S(1-a) + aero + k*(Ta - Ts) - tau*sigma*Ts^4
 *   air:      C_a dTa/dt = k*(Ts - Ta) + div(D grad Ta)
 *
 * `tau` is the *effective transmittance* of the atmosphere: the surface radiates
 * sigma*Ts^4 upward and the atmosphere returns (1-tau) of it as back-radiation,
 * so the net longwave loss at the ground is exactly tau*sigma*Ts^4. This is the
 * parametrisation the greenhouse-gas parameters are calibrated against, and it
 * is what keeps the planetary mean at the observed value instead of letting the
 * column leak energy.
 *
 * The air layer is then a heat pipe rather than a second radiator:
 *   - it stores heat with its own (thin) heat capacity, so land and ocean can
 *     hold different seasonal lags;
 *   - it is what the circulation transports (see transportAirStep), which is how
 *     the polar night is kept from radiating the ground down towards 100 K;
 *   - the sensible exchange `k` is the only surface <-> air coupling, and it is
 *     exactly antisymmetric, so the pair conserves energy and the planetary
 *     balance is untouched by the coupling strength.
 *
 * Both updates are exponential (exact for a linearised budget), so the step is
 * stable at any Δt and at any coupling strength.
 */
export function atmosphereSurfaceStep(grid, p, dtS, insol, tau) {
  const { NB, NL, T, airT } = grid;
  const tauC = Math.max(0.02, tau);

  // 1) surface budget ------------------------------------------------------
  for (let j = 0; j < NB; j++) {
    const ta = Math.max(70, airT[j]);
    for (let i = 0; i < NL; i++) {
      const k = i + j * NL;
      const t = Math.max(70, T[k]);
      const ocean = grid.ocean[k];
      const kEff = surfaceAirCoupling(p, ocean, grid.zonalWindSpeed[j]);
      // aerosol/dust dimming is per cell now, so a dusty continent or an impact
      // winter is colder than the ocean beside it
      const aerF = aerosolForcingAt(p, grid.aerosol[k]);
      const absorbed = Math.max(0.01, insol[j] * (1 - grid.albedo[k]) + aerF);
      // linearise the longwave loss about the current temperature:
      //   tau*sigma*T'^4 ~ 4*tau*sigma*t^3*T' - 3*tau*sigma*t^4
      const lambda = Math.max(0.2, kEff + 4 * tauC * SIGMA * t * t * t);
      const C = cellHeatCapacity(p, ocean);
      const alpha = 1 - Math.exp(-lambda * dtS / C);
      const tEq = (absorbed + kEff * ta + 3 * tauC * SIGMA * t * t * t * t) / lambda;
      T[k] = clamp(t + alpha * (tEq - t), 70, 900);
      grid.absorbed[k] = absorbed;
      grid.olr[k] = tauC * SIGMA * t * t * t * t;
      grid.net[k] = absorbed - grid.olr[k];
    }
  }

  // 2) air budget: sensible exchange with the band's surface, then transport -
  //
  // The band gains sum_i k_i*(Ts_i - Ta)/NL. Using the k-weighted band surface
  // temperature keeps that identity exact when land and ocean have very
  // different coupling, so the exchange adds nothing to the column's total.
  for (let j = 0; j < NB; j++) {
    let kSum = 0, ktSum = 0;
    for (let i = 0; i < NL; i++) {
      const k = i + j * NL;
      const kc = surfaceAirCoupling(p, grid.ocean[k], grid.zonalWindSpeed[j]);
      kSum += kc;
      ktSum += kc * T[k];
    }
    const kMean = kSum / NL;
    if (kMean > 1e-9) {
      const target = ktSum / kSum;
      const ta = Math.max(70, airT[j]);
      const C = airHeatCapacity(p);
      const alpha = 1 - Math.exp(-kMean * dtS / C);
      airT[j] = clamp(ta + alpha * (target - ta), 70, 700);
    }
  }
  transportAirStep(grid, p, dtS);
  return grid;
}

/* ------------------------------------------------------------------ */
/* annual-mean anchor profile                                          */
/* ------------------------------------------------------------------ */

/**
 * Build the planetary equilibrium temperature used by the transport pass.
 *
 * The anchor is the *area-weighted planetary mean* temperature, obtained from the
 * current global mean absorption (so the real simulated albedo — and therefore
 * ice cover — feeds back into it, keeping the response bounded instead of the
 * unbounded runaway a fixed-albedo anchor would give). A dimensionless anomaly
 * pattern supplies the latitude structure that individual bands relax toward.
 *
 * The fourth-power weighting is applied by a few fixed-point iterations because
 * 〈T⁴〉 ≠ 〈T〉⁴.
 */
export function updateAnchorProfile(grid, p, tau) {
  const { NB, areaFrac, NL } = grid;
  // the annual-mean latitude weighting depends on the orbital parameters
  const orbitKey = [p.axialTilt, p.eccentricity, p.perihelion].join('|');
  if (grid._orbitKey !== orbitKey) {
    buildAnnualInsolation(grid, p);
    grid._orbitKey = orbitKey;
  }

  let absWeighted = 0;
  for (let j = 0; j < NB; j++) absWeighted += grid._zonalAbsorbed[j] * areaFrac[j] * NL;
  const absorbedMean = Math.max(1, absWeighted);

  const tauC = Math.max(0.05, tau);
  // Required area-weighted mean of T⁴, in K⁴ (σ is factored out on both sides).
  const targetT4 = absorbedMean / (tauC * SIGMA);
  const meanT4 = (planet) => {
    let sum = 0;
    for (let j = 0; j < NB; j++) {
      const t = Math.max(70, planet + grid.tShape[j]);
      sum += t * t * t * t * areaFrac[j] * NL;
    }
    return sum;
  };
  // monotone in `planet`, so a short bisection is both robust and exact
  let lo = 70, hi = 900;
  for (let it = 0; it < 60; it++) {
    const mid = 0.5 * (lo + hi);
    if (meanT4(mid) > targetT4) hi = mid; else lo = mid;
  }
  const planet = 0.5 * (lo + hi);
  grid.globalEq = planet;
  grid.anchorPlanet = planet;
  grid._tGlobalEq = planet;
  grid._anchorKey = anchorKey(p, tau);
  if (grid.debugAnchor) {
    console.log('[anchor] absMean=' + absorbedMean.toFixed(2) + ' tau=' + tauC.toFixed(4) +
      ' targetT4=' + targetT4.toExponential(3) + ' -> globalEq=' + planet.toFixed(2));
  }
  return grid.globalEq;
}

function anchorKey(p, tau) {
  return [p.transport, tau.toFixed(4), p.irradiance].join('|');
}

/**
 * Dimensionless latitude pattern of the equilibrium temperature anomaly.
 *
 * It is normalised so that Σ share[j]·p[j] === 0, which makes the anchor
 * temperature directly the area-weighted planetary mean — the physically
 * meaningful definition, and the one that keeps the τσT⁴ budget exact.
 */
export function buildTemperatureShape(grid) {
  const { NB, sinLat, areaFrac, NL } = grid;
  const shape = grid.tShape || (grid.tShape = new Float64Array(NB));
  let offset = 0;
  for (let j = 0; j < NB; j++) {
    shape[j] = 1 - 1.25 * sinLat[j] * sinLat[j];
    offset += shape[j] * areaFrac[j] * NL;
  }
  for (let j = 0; j < NB; j++) shape[j] -= offset;
  grid.tShapeOffset = offset;
  grid.tShapeK4 = 0;
  return shape;
}

/**
 * Annual-mean daily insolation per latitude band (W/m²) at the reference solar
 * constant. This is the stable weighting used by the anchor: it encodes where
 * sunlight actually arrives over a year, independent of the current season.
 */
export function buildAnnualInsolation(grid, p) {
  const { NB, lats, areaFrac, NL } = grid;
  if (!p) throw new Error('buildAnnualInsolation requires the parameter bag');
  const annual = grid.annualInsol || (grid.annualInsol = new Float64Array(NB));
  const opts = {
    irradiance: 1361,
    axialTilt: p.axialTilt ?? 23.44,
    eccentricity: p.eccentricity ?? 0.0167,
    perihelion: p.perihelion ?? 102,
  };
  const probe = new Float64Array([0]);
  let weighted = 0;
  for (let j = 0; j < NB; j++) {
    probe[0] = lats[j];
    let acc = 0;
    for (let d = 0; d < 12; d++) acc += dailyInsolation(probe, d * 30.4375 + 15, opts)[0];
    annual[j] = acc / 12;
    weighted += annual[j] * areaFrac[j] * NL;
  }
  grid.annualInsolMean = weighted;
  return annual;
}

/**
 * Zonal-mean (transport) pass — Newtonian relaxation toward the planetary mean.
 *
 * A local diffusion coefficient is not usable here: clearing the observed ≈5.5 PW
 * out of the tropics with the observed gradient would need a diffusivity around
 * 1e12 m²/s (or an equilibrium gradient of ~100 K per band, which Earth does not
 * have). What actually happens is that eddies and overturning cells homogenise
 * each band toward the planetary temperature, so each cell blends
 *
 *   T_eq = (1−f)·T_local + f·T_planet,   f(φ) = fMin + (fPole−fMin)·sin²φ
 *
 * `f` is then modulated by the two circulation systems:
 *
 *   f *= 1 + 0.45·(atmosphericCirculation − 1) + 0.25·(oceanCirculation − 1)
 *
 * so turning the ocean currents off weakens how far the mid-latitude flux
 * reaches, and turning the atmospheric circulation off weakens it everywhere —
 * which is what the pole-to-equator contrast in the diagnostics shows. The
 * *explicit* ocean-current and wind fields in physics/circulation.js carry the
 * moisture, upwelling and visualisation side of both systems.
 */
export function zonalMeanPass(grid, p, dtS, aerF) {
  const { NB, T, sinLat, NL } = grid;
  const zTau = grid._zonalTau;
  const insol = grid._zonalInsol;

  updateAnchorProfile(grid, p, grid._zonalTau[0]);
  const anchor = grid.anchorPlanet;

  const master = Math.max(0, p.transport ?? 1);
  const atmosStr = Math.max(0, p.atmosphericCirculation ?? 1);
  const oceanStr = Math.max(0, p.oceanCirculation ?? 1);
  grid.circulationWeights = transportWeights(oceanStr, atmosStr, master);
  const fMin = clamp(0.10 * master * (1 + 0.25 * (atmosStr - 1) + 0.15 * (oceanStr - 1)), 0, 0.6);
  const fPole = clamp(0.72 * master * (1 + 0.30 * (atmosStr - 1) + 0.20 * (oceanStr - 1)), 0, 0.95);

  for (let j = 0; j < NB; j++) {
    const s2 = sinLat[j] * sinLat[j];
    const f = clamp(fMin + (fPole - fMin) * (1 - s2), 0, 0.95);
    for (let i = 0; i < NL; i++) {
      const k = i + j * NL;
      const t = Math.max(70, T[k]);
      const tau = Math.max(0.05, zTau[j]);
      const absorbed = Math.max(0.01, insol[j] * (1 - grid.albedo[k]) + aerF);
      const olr = tau * SIGMA * t * t * t * t;
      grid.absorbed[k] = absorbed;
      grid.olr[k] = olr;
      grid.net[k] = absorbed - olr;

      const tLocEq = Math.pow(absorbed / (tau * SIGMA), 0.25);
      const tEq = (1 - f) * tLocEq + f * anchor;

      const lambda = Math.max(0.2, 4 * tau * SIGMA * t * t * t);
      const C = cellHeatCapacity(p, grid.ocean[k]);
      const alpha = 1 - Math.exp(-lambda * dtS / C);
      T[k] = clamp(t + alpha * (tEq - t), 70, 900);
    }
  }
  return grid;
}

export function solveTridiagonal(a, b, c, d, out, n) {
  const cp = new Float64Array(n);
  const dp = new Float64Array(n);
  cp[0] = c[0] / b[0];
  dp[0] = d[0] / b[0];
  for (let k = 1; k < n; k++) {
    const m = b[k] - a[k] * cp[k - 1];
    cp[k] = m !== 0 ? c[k] / m : 0;
    dp[k] = m !== 0 ? (d[k] - a[k] * dp[k - 1]) / m : 0;
  }
  out[n - 1] = dp[n - 1];
  for (let k = n - 2; k >= 0; k--) out[k] = dp[k] - cp[k] * out[k + 1];
  return out;
}

/**
 * Bring each cell toward its latitude band's implicitly-solved temperature.
 *
 * The band solve assumes a single (area-weighted) heat capacity, so a cell with
 * a smaller capacity must move further to conserve energy. Relaxing with the
 * per-cell capacity, with the exponential (exact) form of the linearised
 * longwave response, is stable at any Δt and keeps the land/ocean seasonal
 * contrast: land tracks the season, ocean lags it by weeks.
 */
export function relaxCellsToZonal(grid, p, dtS, aerF) {
  const { NB, NL, T, cosLat } = grid;
  const zT = grid._zonalT;
  const zCap = grid._zonalCap;
  const tau = grid._zonalTau[0];
  const insol = grid._zonalInsol;

  for (let j = 0; j < NB; j++) {
    const bandT = zT[j];
    const bandCap = Math.max(1e4, zCap[j]);
    for (let i = 0; i < NL; i++) {
      const k = i + j * NL;
      const t = Math.max(70, T[k]);
      const absorbed = Math.max(0.01, insol[j] * (1 - grid.albedo[k]) + aerF);
      grid.absorbed[k] = absorbed;
      const olr = tau * SIGMA * t * t * t * t;
      grid.olr[k] = olr;
      grid.net[k] = absorbed - olr;

      const lambda = Math.max(0.2, 4 * tau * SIGMA * t * t * t);
      const C = cellHeatCapacity(p, grid.ocean[k]);
      const x = lambda * dtS / C;
      const gain = x > 1e-9 ? (1 - Math.exp(-x)) / lambda : dtS / C;
      // Implicit first-order update with the band temperature as the (already
      // diffusion-corrected) local target.
      const tNext = t + gain * (absorbed - olr - lambda * (t - bandT));
      T[k] = clamp(tNext, 70, 900);
    }
  }
  return grid;
}
export function computeZonalMeans(grid, p, tau, aerF) {
  const { NB, NL, T } = grid;
  const zT = grid._zonalT || (grid._zonalT = new Float64Array(NB));
  const zCap = grid._zonalCap || (grid._zonalCap = new Float64Array(NB));
  const zTau = grid._zonalTau || (grid._zonalTau = new Float64Array(NB));
  const zAbs = grid._zonalAbsorbed || (grid._zonalAbsorbed = new Float64Array(NB));
  const zAlb = grid._zonalAlb || (grid._zonalAlb = new Float64Array(NB));
  const insol = grid._zonalInsol;

  for (let j = 0; j < NB; j++) {
    let tAcc = 0, cAcc = 0, aAcc = 0, albAcc = 0;
    for (let i = 0; i < NL; i++) {
      const k = i + j * NL;
      tAcc += T[k];
      cAcc += cellHeatCapacity(p, grid.ocean[k]);
      aAcc += Math.max(0.01, insol[j] * (1 - grid.albedo[k]) + aerF);
      albAcc += grid.albedo[k];
    }
    zT[j] = tAcc / NL;
    zCap[j] = cAcc / NL;
    zTau[j] = tau;
    zAbs[j] = aAcc / NL;
    zAlb[j] = albAcc / NL;
  }
  return { zT, zCap, zTau, zAbs };
}

/** Radiatively useful helper: top-of-atmosphere balance for a band. */
export function bandBalance(insol, albedo, tau, t) {
  const absorbed = insol * (1 - albedo);
  const olr = tau * SIGMA * Math.pow(t, 4);
  return absorbed - olr;
}

/**
 * Advance the climate by `months` months with `substeps` internal iterations.
 * Mutates the grid; returns nothing (world diagnostics are updated by the caller).
 */
export function stepClimate(grid, world, months = 1, substeps = 4) {
  const p = world.params;
  const { NB, NL, T } = grid;
  const tilt = p.axialTilt ?? 23.44;
  const subMonths = months / substeps;
  const dtDays = subMonths * 30.4375;
  const dtS = dtDays * 86400;
  const S0 = world.stars.fluxAt(world.time.month);
  const impactDust = meteorDustLoad(world);

  for (let s = 0; s < substeps; s++) {
    const monthNow = world.time.month + months * (s + 0.5) / substeps;
    const day = 15 + ((monthNow % 12) + 12) % 12 * 30.4375;
    const insol = dailyInsolation(grid.lats, day, {
      irradiance: S0, axialTilt: tilt,
      eccentricity: p.eccentricity ?? 0.0167, perihelion: p.perihelion ?? 0,
    });

    const tau = effectiveTau(p, world.tGlobal);

    // 0) wind / current / cloud / dust fields ----------------------------
    // All four are *predicted* fields that then feed back into the energy
    // budget below: wind drives the surface exchange and moisture advection,
    // the currents advect surface heat and cool it where they upwell, clouds
    // brighten the planet and dust dims it.
    grid._zonalInsol = insol;
    updateZonalWind(grid, p);
    updateWindField(grid, p);
    updateCurrentField(grid, p);
    updateCloudAerosol(grid, p, impactDust);
    const cloudA = cloudAlbedo(p);

    // 1) albedo — ice-albedo + cloud feedback ----------------------------
    surfaceAlbedoPass(grid, p, cloudA);

    // 2) zonal means for the transport/relaxation terms
    computeZonalMeans(grid, p, tau, 0);

    // 3) two-layer atmosphere + surface: the air layer carries the poleward heat
    //    transport, which is what keeps the polar night from running away
    atmosphereSurfaceStep(grid, p, dtS, insol, tau);
    currentHeatStep(grid, p, dtS);
    overturningHeatStep(grid, p, dtS);

    // 4) cryosphere ------------------------------------------------------
    // Freezing is driven by a short-term mean temperature (not the instantaneous
    // one), otherwise every winter night would nucleate permanent ice — the
    // classic failure mode of a one-layer seasonal model.
    mergeFilteredTemperature(grid, 45, dtDays);     // ~45 day memory: seasonal state
    mergeWarmTemperature(grid, 730, dtDays);        // ~2 year memory: "annual mean"
    cryosphereStep(grid, world, dtDays, p);
  }

  waterCyclePass(grid, world);
  accumulateSeason(grid, months);
  return grid;
}

/**
 * Zonal surface wind, used by the air–surface coupling, the moisture advection
 * and the wind layer. Kept here (rather than in the water cycle) because the
 * atmosphere step needs it before the water cycle runs.
 */
export function updateZonalWind(grid, p) {
  const { NB, T, NL } = grid;
  const strength = p.atmosphericCirculation ?? 1;
  const jPolar = Math.max(0, Math.round(NB * 0.03));
  const jTropic = Math.round(NB * 0.5);
  let tPolar = 0, tTropic = 0;
  for (let i = 0; i < NL; i++) { tPolar += T[i + jPolar * NL]; tTropic += T[i + jTropic * NL]; }
  const gradient = Math.abs(tTropic - tPolar) / NL;
  const gradientFactor = clamp(gradient / 45, 0.35, 2);
  grid.windGradientFactor = gradientFactor;
  for (let j = 0; j < NB; j++) {
    const w = windAt(grid.lats[j], strength, gradientFactor);
    grid.zonalWind[j] = w.u;
    grid.zonalWindV[j] = w.v;
    grid.zonalWindSpeed[j] = w.speed;
    grid.zonalConvergence[j] = w.convergence;
  }
  return grid;
}

/**
 * Exponential smoother used by the cryosphere (memory in days).
 *
 * `dtDays` is the *sub-step* length, not a month: this runs once per internal
 * sub-step, so using a fixed 30-day weight made every "memory" four times too
 * short at the default four sub-steps per month (a 45-day filter became ~11
 * days), which let a single cold spell nucleate permanent ice and made the
 * ice-albedo feedback far too trigger-happy.
 */
export function mergeFilteredTemperature(grid, memoryDays, dtDays = 30.4) {
  const w = grid.filterReady ? 1 - Math.exp(-dtDays / Math.max(0.5, memoryDays)) : 1;
  for (let k = 0; k < grid.n; k++) grid.tFiltered[k] += (grid.T[k] - grid.tFiltered[k]) * w;
  grid.filterReady = true;
  return grid;
}

/**
 * Slow smoother (default ~2 years) that represents the local *annual mean*
 * surface temperature. Permanent ice and snow thresholds are judged against
 * this, so a single cold winter cannot nucleate permanent ice.
 */
export function mergeWarmTemperature(grid, memoryDays, dtDays = 30.4) {
  const w = grid.warmReady ? 1 - Math.exp(-dtDays / Math.max(1, memoryDays)) : 1;
  for (let k = 0; k < grid.n; k++) grid.tWarm[k] += (grid.T[k] - grid.tWarm[k]) * w;
  grid.warmReady = true;
  return grid;
}

/** Ice sheets / sea ice / snow, plus the resulting eustatic sea level. */
export function cryosphereStep(grid, world, dtDays, p) {
  const { NB, NL } = grid;
  const freeze = 273.15;
  const iceScale = (p.iceTempScale ?? 0.35) * (p.iceFlow ?? 1);
  // One cell's surface area. `cellArea` is in m², `cellAreaKm2` in km², so that
  // (ice thickness in m) x (area in km²) gives 10^3 km³ directly.
  const cellArea = (2 * Math.PI * EARTH_RADIUS_M / NL) * (DEG_M * (180 / NB));
  const cellAreaKm2 = cellArea / 1e6;
  let seaIceVolKm3 = 0;
  let landIceVolKm3 = 0;

  for (let j = 0; j < NB; j++) {
    for (let i = 0; i < NL; i++) {
      const k = i + j * NL;
      // Permanent ice cover is governed by the *annual mean*; the instantaneous
      // temperature only modulates thickness. This is what keeps a cold winter
      // from nucleating permanent ice and running away.
      const tAnnual = grid.tWarm[k];
      const tInst = grid.tFiltered[k];
      const ocean = grid.ocean[k];
      if (ocean > 0.5) {
        const target = tInst < freeze ? clamp((freeze - tInst) * iceScale * 0.30, 0, 3.0) : 0;
        grid.ice[k] += (target - grid.ice[k]) * (1 - Math.exp(-dtDays / (95 / Math.max(0.1, p.iceFlow ?? 1))));
        grid.ice[k] = clamp(grid.ice[k], 0, 3.0);
        grid.seaIce[k] = seaIceFraction(tAnnual, grid.ice[k]);
        grid.snowCover[k] = 0;
        grid.iceFrac[k] = grid.seaIce[k];
        grid.snow[k] = 0;
        seaIceVolKm3 += grid.ice[k] * cellAreaKm2 * grid.seaIce[k];
      } else {
        grid.snowCover[k] = snowCoverFraction(tAnnual);
        grid.snow[k] += (grid.snowCover[k] - grid.snow[k]) * (1 - Math.exp(-dtDays / 40));
        const target = tInst < freeze ? clamp((freeze - tInst) * iceScale * 0.16, 0, 1.5) : 0;
        const lag = 1600 / Math.max(0.08, iceScale);
        grid.ice[k] += (target - grid.ice[k]) * (1 - Math.exp(-dtDays / lag));
        grid.ice[k] = clamp(grid.ice[k], 0, 1.5);
        grid.iceFrac[k] = landIceFraction(tAnnual, grid.ice[k]);
        grid.seaIce[k] = 0;
        landIceVolKm3 += grid.ice[k] * cellAreaKm2 * grid.iceFrac[k];
      }
    }
  }
  // Volumes are in km³ (ice thickness in m × area in km² × 10⁻³). Only *land*
  // ice changes sea level; floating sea ice already displaces its own mass.
  // Eustatic sea level then follows directly from the ocean area:
  //   ΔSL = −V_ice / A_ocean  (converted from km to m)
  const oceanAreaKm2 = 4 * Math.PI * (EARTH_RADIUS_M / 1000) ** 2 * Math.max(0.02, world.oceanFraction);
  grid.landIceVolumeKm3 = landIceVolKm3 / 1e3;
  grid.seaIceVolumeKm3 = seaIceVolKm3 / 1e3;
  grid.landIceVolume = grid.landIceVolumeKm3;
  grid.iceVolumeM3 = grid.landIceVolumeKm3;
  world.iceVolumeEarth = grid.landIceVolumeKm3 / 2.9e7;   // Earth ≈ 29e6 km³
  world.seaIceVolumeEarth = grid.seaIceVolumeKm3 / 3.0e4; // Earth ≈ 30e3 km³
  const inventory = clamp(p.waterInventory ?? 1, 0, 6);
  world.seaLevelDelta = -(grid.landIceVolumeKm3 * inventory / Math.max(1e6, oceanAreaKm2)) * 1000;}

/**
 * River proximity on the climate grid.
 *
 * Habitability is a land index, and fresh water is one of its inputs, but rivers
 * live on the fine *terrain* grid while habitability lives on the coarse climate
 * grid. This splats the terrain river network onto the climate grid (max within a
 * ±1 cell neighbourhood) once per month.
 */
export function updateRiverProximity(grid, world) {
  const t = world && world.terrain;
  const field = grid.riverNear;
  if (!field) return grid;
  field.fill(0);
  if (!t || !t.river) return grid;
  const { GX, GY, river } = t;
  const { NB, NL } = grid;
  for (let j = 0; j < GY; j++) {
    const cj = clamp(Math.floor((j + 0.5) / GY * NB), 0, NB - 1);
    for (let i = 0; i < GX; i++) {
      const rv = river[i + j * GX];
      if (rv <= 0.02) continue;
      const ci = clamp(Math.floor((i + 0.5) / GX * NL), 0, NL - 1);
      const k = ci + cj * NL;
      if (rv > field[k]) field[k] = rv;
    }
  }
  // spread to the neighbouring cells so "near a river" covers the flood plain
  const src = grid._riverTmp || (grid._riverTmp = new Float32Array(grid.n));
  src.set(field);
  for (let j = 0; j < NB; j++) {
    for (let i = 0; i < NL; i++) {
      const k = i + j * NL;
      let best = src[k];
      best = Math.max(best, src[((i + 1) % NL) + j * NL] * 0.75, src[((i - 1 + NL) % NL) + j * NL] * 0.75);
      if (j > 0) best = Math.max(best, src[i + (j - 1) * NL] * 0.75);
      if (j < NB - 1) best = Math.max(best, src[i + (j + 1) * NL] * 0.75);
      field[k] = Math.min(1, best);
    }
  }
  return grid;
}

/** Humidity, precipitation, vegetation, toxicity, habitability, diurnal range. */
export function waterCyclePass(grid, world) {
  const p = world.params;
  const { NB, NL, T } = grid;
  const pressF = Math.pow(clamp(p.pressure, 0.001, 200), 0.45);
  updateRiverProximity(grid, world);
  let windSumAcc = 0, currentSumAcc = 0, oceanFrac = 0, biomass = 0, toxSum = 0, qSum = 0;
  // The wind and current fields were already built before the energy step (they
  // feed back into it), so here they only need to be summarised.
  updateCurrentField(grid, p);
  for (let j = 0; j < NB; j++) {
    for (let i = 0; i < NL; i++) {
      const k = i + j * NL;
      // areaFrac already carries the 1/NL factor (see makeGrid), so a global
      // mean is just the plain weighted sum — dividing by NL again is a 96× error
      windSumAcc += grid.windSpeed[k] * grid.areaFrac[j];
      currentSumAcc += grid.currentSpeed[k] * grid.areaFrac[j];
    }
  }
  world.windSpeedMean = windSumAcc;
  world.currentSpeedMean = currentSumAcc;

  // Column-integrated moisture, treated as a specific humidity in g/kg. Using an
  // absolute measure keeps the water budget physical: the seasonal cycle then
  // follows the Clausius-Clapeyron relation rather than being an artefact of a
  // relative-humidity parameterisation.
  for (let j = 0; j < NB; j++) {
    for (let i = 0; i < NL; i++) {
      const k = i + j * NL;
      const t = T[k];
      const ocean = grid.ocean[k];
      const dT = clamp(t - 288, -80, 80);
      // saturation specific humidity, normalised to ≈13 g/kg at 288 K
      const qSat = 13 * Math.exp(dT / 15.5) * Math.pow(clamp(p.pressure, 0.02, 4), 0.3);
      // surface source: an ocean supplies freely, land is limited by soil
      // moisture and by how much vapour the wind brings from upwind
      const source = ocean > 0.5
        ? 0.5 + 0.12 * clamp(grid.zonalWindSpeed[j] / 12, 0, 2)
        : 0.16 + 0.34 * grid.vegetation[k] + 0.28 * grid.dryness[k];
      grid.moisture[k] = clamp(qSat * clamp(p.humidity / 68, 0.05, 2) * source, 0.05, 90);
      qSum += grid.moisture[k] * grid.areaFrac[j];
    }
  }
  world.moistureMean = qSum;

  for (let j = 0; j < NB; j++) {
    for (let i = 0; i < NL; i++) {
      const k = i + j * NL;
      const t = T[k];
      const ocean = grid.ocean[k];
      const dT = t - 288;
      const q = grid.moisture[k];
      const rh = clamp(100 * q / Math.max(0.05, 13 * Math.exp(clamp(dT, -80, 80) / 15.5) * Math.pow(clamp(p.pressure, 0.02, 4), 0.3)), 1, 100);
      // NOTE: this field used to be computed and then thrown away, which left the
      // humidity layer at zero and made habitability / diurnal range / cloud cover
      // all ignore moisture. It is stored now because it is one of the outputs that
      // feeds back into the albedo and the energy budget.
      grid.humidity[k] = rh;

      // precipitation: moisture x efficiency x pressure, plus the circulation
      // terms — wind convergence (rising air) adds, coastal upwelling of cold
      // water suppresses. Orographic lift uses the local slope.
      //
      // The efficiency term is deliberately *weaker* than Clausius-Clapeyron
      // (the moisture itself already carries exp(ΔT/15.5)): real precipitation
      // grows at roughly 2-3 %/K, not at the 7 %/K the column moisture does.
      const efi = clamp(Math.exp(-dT / 43), 0.2, 2.5);
      // Orographic lift now uses the *actual* local wind against the terrain
      // gradient (w = U·∇h) rather than a fixed latitude-independent weight, so a
      // ridge only wrings out its rain when the wind is blowing onto it — and the
      // dry side really is downwind of the crest.
      const lift = grid.windLift[k];
      // lift is U·∇h in (m/s)·(slope×1000): 10 ≈ a 10 m/s wind over a 1:1000 slope
      const oro = 1 + clamp(lift * 0.045, -0.55, 1.7);
      const conv = 1 + clamp(grid.zonalConvergence[j] * 0.85, -0.6, 1.8);
      const upw = 1 - clamp(grid.upwelling[k] * 0.5, 0, 0.5);
      let pr = PRECIP_SCALE * clamp(p.precipFactor ?? 1, 0.1, 5) * q * efi * oro * conv * upw;
      grid.precip[k] = clamp(pr, 0, 900);

      // aridity for the albedo model
      const dryThreshold = 26 + 0.9 * Math.max(0, t - 253);
      grid.dryness[k] = clamp(1 - grid.precip[k] / dryThreshold, 0, 1);

      // vegetation: temperature window x moisture
      const tWin = Math.exp(-Math.pow((t - 295) / 26, 2));
      const moist = clamp(grid.precip[k] / (18 + 0.8 * Math.max(0, t - 250)), 0, 1.4);
      const co2Win = clamp(Math.log10(Math.max(1, p.co2) / 25) / 1.3, 0, 1.2);
      const o2Win = clamp(p.o2 / 12, 0, 1.2);
      let veg = 0;
      if (ocean < 0.5) veg = clamp(tWin * Math.min(1.15, moist) * co2Win * o2Win, 0, 1);
      grid.vegetation[k] = veg;

      // ---------------------------------------------------------------
      // habitability — this is a *human civilisation* index, so it is only
      // defined on land: nobody lives on the open ocean. Every factor the
      // user sees in the panel takes part: temperature, humidity, aerosol,
      // toxic gases, vegetation cover, oxygen, precipitation and whether the
      // cell sits near a river.
      // ---------------------------------------------------------------
      const tox = toxicityOf(p, grid, k);
      grid.toxicity[k] = tox;
      if (ocean > 0.5) {
        grid.habitability[k] = 0;
        grid.habitabilityLand[k] = 0;
      } else {
        const tScore = Math.exp(-Math.pow((t - (p.axHabitabilityTemp ?? 288)) / 18, 2));
        const rh = clamp(grid.humidity[k], 0, 100);
        const wScore = Math.exp(-Math.pow((rh - 58) / 34, 2));          // 30–85 % RH is comfortable
        const rain = grid.precip[k];
        const pScore = Math.exp(-Math.pow((Math.log10(Math.max(0.05, rain)) - Math.log10(78)) / 0.62, 2));
        const vScore = clamp(grid.vegetation[k] * 1.25, 0, 1);
        const oScore = Math.exp(-Math.pow((p.o2 - 21) / 9, 2));
        const aScore = 1 - clamp(grid.aerosol[k] / 2.2, 0, 1);
        const toxScore = 1 - clamp(tox, 0, 1);
        const prScore = clamp(1 - Math.abs(Math.log10(clamp(p.pressure, 0.01, 100))) * 0.8, 0, 1);
        // fresh water: a river through the cell, or one nearby
        const riverScore = clamp(grid.riverNear[k] * 3.0, 0, 1);
        const score = tScore * 0.19 + wScore * 0.13 + pScore * 0.13 + vScore * 0.13
          + oScore * 0.11 + aScore * 0.07 + toxScore * 0.11 + prScore * 0.04 + riverScore * 0.09;
        // hard limits: none of the nice weights matter if the air is unbreathable
        const press = clamp(p.pressure, 0.01, 100);
        const survives = clamp((t - 233) / 20, 0, 1) * clamp((330 - t) / 20, 0, 1)
          * clamp((p.o2 - 6) / 6, 0, 1)
          * clamp((press - 0.35) / 0.25, 0, 1) * clamp((4 - press) / 1.5, 0, 1);
        grid.habitability[k] = clamp(score * survives, 0, 1);
        grid.habitabilityLand[k] = 1;
      }

      // aerosol optical depth / dust
      const wind = 0.4 + 0.6 * clamp(Math.abs(grid.dhdx[k]) / 900 + Math.abs(grid.dhdy[k]) / 900, 0, 1.5);
      grid.aerosol[k] = clamp((p.aerosolLoad ?? 0) * (0.45 + 0.55 * wind) + (ocean < 0.5 ? 0.05 : 0.02), 0, 2);

      // diurnal range: slow rotators and dry land swing hardest
      const rotFactor = clamp(1.6 / Math.sqrt(Math.max(0.02, p.rotationSpeed ?? 1)), 0.12, 12);
      const cap = cellHeatCapacity(p, ocean) / 2.66e6;
      const cloudDamp = 1 - clamp(p.cloud / 100, 0, 1) * 0.55;
      grid.diurnal[k] = clamp(30 * rotFactor / Math.max(0.16, Math.pow(cap, 0.75)) * (1 - clamp(grid.humidity[k] / 130, 0, 0.6)) * cloudDamp, 0, 90);

      // biomass (relative to Earth's total biosphere ≈ 1)
      const bm = ocean > 0.5 ? clamp(0.25 + 0.75 * Math.exp(-Math.pow((t - 283) / 22, 2)), 0, 1) * 0.10 : veg * 0.72;
      grid.biomass[k] = bm;
      oceanFrac += ocean * grid.areaFrac[j];
      biomass += bm * grid.areaFrac[j];
      toxSum += tox * grid.areaFrac[j];
    }
  }
  // Second stage: moisture advection. A cell's rainfall depends on how moist the
  // air arriving from upwind is, which is what puts the dry side of a mountain
  // range downwind of a wet one, and why west coasts at 30-45° are wet while the
  // same latitude inland is dry.
  const dryAdvect = grid._dryAdvect || (grid._dryAdvect = new Float32Array(grid.n));
  const qAdvect = grid._qAdvect || (grid._qAdvect = new Float32Array(grid.n));
  const advectStrength = clamp(p.windMoisture ?? 1, 0, 3);
  for (let i = 0; i < grid.n; i++) { dryAdvect[i] = grid.dryness[i]; qAdvect[i] = grid.moisture[i]; }
  for (let j = 0; j < NB; j++) {
    const wind = { u: grid.zonalWind[j], v: grid.zonalWindV[j] };
    const speed = Math.max(0.5, Math.hypot(wind.u, wind.v));
    // one cell upwind is enough: the goal is the windward/leeward contrast and
    // the dry-interior effect, not a full transport solve
    const di = -Math.sign(wind.u) * clamp(Math.abs(wind.u) / speed, 0, 1);
    const dj = -Math.sign(wind.v) * clamp(Math.abs(wind.v) / speed, 0, 1);
    for (let i = 0; i < NL; i++) {
      const k = i + j * NL;
      const ui = ((i + Math.round(di)) % NL + NL) % NL;
      const uj = clamp(j + Math.round(dj), 0, NB - 1);
      const uk = ui + uj * NL;
      // vapour the wind actually delivers: a share of the upwind air, so a cell
      // downwind of ocean is much wetter than one deep inside a continent
      const delivered = qAdvect[uk] * (1 - dryAdvect[uk] * 0.55);
      const q = grid.moisture[k];
      grid.moisture[k] = clamp(q + (delivered - q) * (0.5 * advectStrength), 0.05, 90);
      // rainfall follows the (advected) moisture, keeping the cyclonic source
      const efi = clamp(Math.exp(-clamp(T[k] - 288, -80, 80) / 43), 0.2, 2.5);
      grid.precip[k] = clamp(PRECIP_SCALE * clamp(p.precipFactor ?? 1, 0.1, 5) * grid.moisture[k] * efi, 0, 900);
      grid.dryness[k] = clamp(1 - grid.precip[k] / (26 + 0.9 * Math.max(0, T[k] - 253)), 0, 1);
    }
  }

  world.oceanFraction = oceanFrac;
  world.biomass = biomass / 0.72;
  return grid;
}

function toxicityOf(p, grid, k) {
  const ch4 = clamp((p.ch4 ?? 0) / 4000, 0, 1);
  const so2 = clamp((p.aerosolLoad ?? 0) / 1.2, 0, 1) * 0.7;
  const co2 = clamp((p.co2 - 4000) / 30000, 0, 1) * 0.8;
  const o2low = clamp((16 - p.o2) / 16, 0, 1) * 0.55;
  const o2high = clamp((p.o2 - 30) / 20, 0, 1) * 0.45;
  const press = clamp(Math.abs(Math.log10(clamp(p.pressure, 0.001, 200))) / 1.8, 0, 1) * 0.6;
  const base = Math.max(ch4 * 0.5, so2, co2, o2low, o2high, press);
  const local = grid.aerosol[k] * 0.35;
  return clamp(base * 0.85 + local, 0, 1);
}

/**
 * Track the seasonal extremes of temperature and precipitation.
 *
 * A rolling min/max corrects itself: keeping the running extremes and rescanning
 * the last 12 monthly samples once a full year is in the window means the layer
 * is correct from the very first month of the second year onwards, regardless of
 * which calendar month the simulation happened to start in.
 */
function accumulateSeason(grid, months) {
  for (let k = 0; k < grid.n; k++) {
    const t = grid.T[k];
    grid.tSeasonMean[k] += t * months;
    grid.pSeasonMean[k] += grid.precip[k] * months;
  }
  grid.seasonMonths += months;

  for (let m = 0; m < months; m++) {
    const idx = grid.monthAccum % 12;
    for (let k = 0; k < grid.n; k++) {
      grid.tBuf[k * 12 + idx] = grid.T[k];
      grid.pBuf[k * 12 + idx] = grid.precip[k];
    }
    grid.monthAccum++;
    if (grid.monthAccum % 12 === 0) {
      for (let k = 0; k < grid.n; k++) {
        const base = k * 12;
        let tLo = Infinity, tHi = -Infinity, pLo = Infinity, pHi = -Infinity;
        for (let i = 0; i < 12; i++) {
          const tv = grid.tBuf[base + i];
          const pv = grid.pBuf[base + i];
          if (tv < tLo) tLo = tv;
          if (tv > tHi) tHi = tv;
          if (pv < pLo) pLo = pv;
          if (pv > pHi) pHi = pv;
        }
        grid.tSeasonMin[k] = tLo;
        grid.tSeasonMax[k] = tHi;
        grid.pSeasonMin[k] = pLo;
        grid.pSeasonMax[k] = pHi;
      }
    }
  }

  if (grid.seasonMonths >= 12) {
    const inv = 1 / grid.seasonMonths;
    for (let k = 0; k < grid.n; k++) {
      grid.tAnnual[k] = grid.tSeasonMean[k] * inv;
      grid.pAnnual[k] = grid.pSeasonMean[k] * inv;
      grid.tSeasonMean[k] = 0;
      grid.pSeasonMean[k] = 0;
    }
    grid.seasonMonths = 0;
  }
}

export function averageField(grid, field) {
  let s = 0;
  for (let j = 0; j < grid.NB; j++) {
    for (let i = 0; i < grid.NL; i++) s += field[i + j * grid.NL] * grid.areaFrac[j];
  }
  return s;
}

/** Area-weighted ice cover fraction (0..1). */
export function iceAreaFraction(grid) {
  let s = 0;
  for (let j = 0; j < grid.NB; j++) {
    for (let i = 0; i < grid.NL; i++) {
      const k = i + j * grid.NL;
      const f = grid.ocean[k] > 0.5 ? clamp(grid.ice[k] / 2.0, 0, 1) : clamp(grid.ice[k] / 6, 0, 1);
      s += f * grid.areaFrac[j];
    }
  }
  return s;
}
