/**
 * World: ties the terrain, the climate grid, the star list, the time series and
 * the checkpoint history together. A World is the unit that gets cloned when the
 * user forks a "what if" branch, and the unit that gets serialised into a scene.
 */

import {
  makeGrid, initialTemperature, stepClimate, effectiveTau, aerosolForcing, cloudAlbedo,
  averageField, iceAreaFraction, dailyInsolation, surfaceAlbedoPass, waterCyclePass, SIGMA, BASE,
  dustLoadForMass, meteorDustLoad, cryosphereStep, updateCloudAerosol, iceThicknessTarget,
} from '../physics/climate.js';
import { Stars, Star } from '../physics/stars.js';
import { generateTerrain, computeRivers, blurWrap, terrainToObject, terrainFromObject, allocTerrain, heightAt, applyOceanTarget, updateWaterMask } from './terrain.js';
import { buildCoastFields } from '../physics/coast.js';
import { computeLayer, layerRange, layerVector, computeBaseTexture, probeAt, regionSeriesFields, weightedAverage } from '../physics/derived.js';
import { Series, GLOBAL_SCOPE, ALL_SERIES_KEYS } from '../sim/series.js';
import { clamp } from '../core/noise.js';
import { Rng } from '../core/rng.js';
import { emit } from '../core/bus.js';

export const CLIMATE_NB = 48;
export const CLIMATE_NL = 96;
export const TERRAIN_GX = 360;
export const TERRAIN_GY = 180;

import { climateSizeFor } from './gridSizes.js';

export { GRID_PRESETS, GRID_MIN, GRID_MAX, gridDimsFor, climateSizeFor, nearestPreset, gridCostHint } from './gridSizes.js';

const MAX_CHECKPOINTS = 420;

export class World {
  /**
   * @param {object} params parameter bag (state.params)
   * @param {object} opts   { terrain, seed, name }
   */
  constructor(params, opts = {}) {
    this.params = params;
    this.name = opts.name || '未命名星球';
    this.seed = opts.seed ?? params.seed ?? 20240;
    this.time = { month: 0, stepMonths: params.stepMonths || 1 };

    this.stars = Stars.single({
      irradiance: params.irradiance,
      tempK: params.starTemp,
      label: '主星',
    });

    // terrain ---------------------------------------------------------
    this.terrainScaleApplied = 1;
    if (opts.terrain) {
      // A supplied terrain (scene load, terrain editor, wizard) is already
      // authored — never rescale it, or every reload would drift.
      this.terrain = opts.terrain;
      this.terrainScaleApplied = params.terrainScale ?? 1;
    } else {
      this.terrain = generateTerrain({
        GX: opts.gridX || TERRAIN_GX,
        GY: opts.gridY || TERRAIN_GY,
        seed: this.seed,
        plateCount: params.plateCount,
        fragmentation: params.fragmentation,
        relief: params.relief,
        seaFloorRelief: params.seaFloorRelief,
        oceanTarget: clamp((params.oceanFraction ?? 70.8) / 100, 0.001, 0.999),
      });
      applyTerrainScale(this.terrain, params.terrainScale ?? 1);
    }
    if (!this.terrain.river) {
      try { refreshRivers(this); } catch (e) { console.warn('[world] river routing failed', e); this.terrain.river = new Float32Array(this.terrain.height.length); }
    }
    // Smoothing is part of *generating* a planet. A supplied terrain was already
    // shaped (and possibly hand-painted) by the user, so leave it untouched —
    // otherwise every save/load cycle would erode the terrain a little more.
    if (!opts.terrain) smoothTerrainVisual(this.terrain, 2);
    updateWaterMask(this.terrain);

    // climate grid ----------------------------------------------------
    // The solver resolution follows the terrain resolution so that a
    // high-detail heightfield is not averaged away by a coarse climate grid.
    const cl = climateSizeFor(this.terrain.GX, this.terrain.GY);
    this.grid = makeGrid(cl.NB, cl.NL);
    this.syncTerrainToGrid();

    // diagnostics -----------------------------------------------------
    this.tGlobal = 288;
    this.tau = effectiveTau(params, 288);
    this.absorbedGlobal = 0;
    this.olrGlobal = 0;
    this.energyNet = 0;
    this.albedoGlobal = 0.3;
    this.oceanFraction = 0.708;
    this.seaLevelDelta = 0;
    this.biomass = 1;
    this.iceVolumeEarth = 0;
    this.layerCache = new Map();
    this.frameId = 0;

    initialTemperature(this.grid, opts.initialTemp ?? 288, this.tau);
    // The cryosphere reads a smoothed temperature field; seed those smoothers with
    // the initial profile (they used to start at a uniform 288 K, so the model
    // began with *no* ice anywhere and then grew its ice caps over the first few
    // years — that spin-up transient is what made a 2024-Earth look like it was
    // cooling down out of nowhere).
    this.grid.tWarm.set(this.grid.T);
    this.grid.tFiltered.set(this.grid.T);
    surfaceAlbedoPass(this.grid, this.params, cloudAlbedo(this.params));
    updateCloudAerosol(this.grid, this.params, 0);
    // Seed the ice thickness at its steady-state value for the initial profile:
    // relaxing it instead would leave the ice (and therefore the albedo) drifting
    // for decades after the world is created.
    for (let k = 0; k < this.grid.n; k++) {
      this.grid.ice[k] = iceThicknessTarget(this.grid.tFiltered[k], this.params, this.grid.ocean[k]);
    }
    cryosphereStep(this.grid, this, 30, this.params);
    // populate every derived field immediately so the first frame, the layer
    // strip and the data panel are meaningful before the first step
    surfaceAlbedoPass(this.grid, this.params, cloudAlbedo(this.params));
    waterCyclePass(this.grid, this);
    this.refreshFields();
    this.measureOcean();
    this.recordIceBaseline();

    // time series & checkpoints ---------------------------------------
    this.series = new Series();
    this.history = new CheckpointHistory();
    this.sampleSeries();
    this.checkpoint(true);
    this.seriesStart = 0;
    this.anomalyBase = null;
  }

  /* ---------------- terrain <-> climate grid ---------------- */

  /** Project the high-res heightfield down onto the coarse climate grid. */
  syncTerrainToGrid() {
    const g = this.grid;
    const t = this.terrain;
    const { NB, NL } = g;
    const bx = t.GX / NL, by = t.GY / NB;
    for (let j = 0; j < NB; j++) {
      for (let i = 0; i < NL; i++) {
        let sum = 0, min = Infinity, max = -Infinity, n = 0;
        for (let jj = 0; jj < by; jj++) {
          const tj = clamp(Math.floor(j * by + jj), 0, t.GY - 1);
          for (let ii = 0; ii < bx; ii++) {
            const ti = (Math.floor(i * bx + ii)) % t.GX;
            const h = t.height[ti + tj * t.GX];
            sum += h; n++;
            if (h < min) min = h;
            if (h > max) max = h;
          }
        }
        const k = i + j * NL;
        const mean = sum / Math.max(1, n);
        g.h[k] = mean;
        // Sub-grid extremes. Cell *means* are a poor proxy for what the wind meets:
        // a 417 km cell that averages 900 m can still contain a 2.4 km peak, and it is
        // the peak that blocks the flow. Keeping max/min also preserves the relief the
        // averaging would otherwise erase.
        g.hPeak[k] = Math.max(0, max);
        g.hSub[k] = Math.max(0, max - mean);
        // ocean decision uses the sub-cell minimum so that a cell containing any
        // deep water counts as ocean (matches the coastline the user sees)
        const oceanFrac = clamp((0 - min) / Math.max(1e-6, max - min), 0, 1);
        g.ocean[k] = oceanFrac > 0.5 || mean < 0 ? 1 : 0;
      }
    }
    // sea level offset for the visual / eustatic reference
    const seaOffset = (this.params.seaLevel || 0) + (this.seaLevelDelta || 0);
    if (seaOffset !== 0) {
      for (let k = 0; k < g.n; k++) { g.h[k] -= seaOffset; g.hPeak[k] -= seaOffset; }
    }
    // slopes drive orographic precipitation and dust
    for (let j = 0; j < NB; j++) {
      for (let i = 0; i < NL; i++) {
        const k = i + j * NL;
        const e = (i + 1) % NL, w = (i - 1 + NL) % NL;
        const n = Math.max(0, j - 1), s = Math.min(NB - 1, j + 1);
        g.dhdx[k] = (g.h[e + j * NL] - g.h[w + j * NL]) / (2 * g.dxM) * 1000;
        g.dhdy[k] = (g.h[i + n * NL] - g.h[i + s * NL]) / (2 * g.dyM) * 1000;
      }
    }
    // Coastline geometry (distance to coast, offshore normal, shelf, zonal
    // land-distance) — the wind and current models are driven from this, so it has
    // to be rebuilt with the terrain rather than every simulation step.
    buildCoastFields(g);
    return g;
  }

  /** Height at a lat/lon on the visual terrain grid. */
  heightAt(lat, lon) { return heightAt(this.terrain, lat, lon); }

  /**
   * Apply the "地形高低起伏" factor by baking the *delta* into the heightfield,
   * so a supplied terrain is never silently rescaled on load.
   */
  setTerrainScale(factor) {
    const target = Math.max(0.02, factor ?? 1);
    const current = this.terrainScaleApplied || 1;
    if (Math.abs(target - current) < 1e-6) return;
    applyTerrainScale(this.terrain, target / current);
    this.terrainScaleApplied = target;
    updateWaterMask(this.terrain);
    this.syncTerrainToGrid();
    refreshRivers(this);
    this.layerCache.clear();
    this.refreshFields();
    return this;
  }

  /** Recompute everything that depends on the current climate state. */
  refreshFields() {
    const g = this.grid;
    const p = this.params;
    surfaceAlbedoPass(g, p, cloudAlbedo(p));
    this.measureOcean();
    this.tGlobal = averageField(g, g.T);
    this.albedoGlobal = averageField(g, g.albedo);
    this.iceAreaFrac = iceAreaFraction(g);
    this.energyNet = averageField(g, g.net);
    this.absorbedGlobal = averageField(g, g.absorbed);
    this.olrGlobal = averageField(g, g.olr);
    this.impactDust = meteorDustLoad(this);
    this.cloudMean = averageField(g, g.cloudCover);
    this.aerosolMean = averageField(g, g.aerosol);
    // 12-month running mean of the global mean: what a climate dashboard should
    // quote, so a seasonal cycle is not mistaken for a trend
    if (!this.tGlobalRing) this.tGlobalRing = new Float64Array(12);
    if (!this.tGlobalSummary) this.tGlobalSummary = { n: 0, i: 0, sum: 0 };
    const ring = this.tGlobalRing;
    const st = this.tGlobalSummary;
    if (st.n >= 12) st.sum -= ring[st.i];
    ring[st.i] = this.tGlobal;
    st.sum += this.tGlobal;
    st.i = (st.i + 1) % 12;
    if (st.n < 12) st.n++;
    this.tGlobalAnnual = st.sum / st.n;
    return this;
  }

  measureOcean() {
    let o = 0;
    for (let j = 0; j < this.grid.NB; j++) {
      for (let i = 0; i < this.grid.NL; i++) o += this.grid.ocean[i + j * this.grid.NL] * this.grid.areaFrac[j];
    }
    this.oceanFraction = o;
    return o;
  }

  recordIceBaseline() {
    this.iceBaselineVolume = this.grid.iceVolumeM3 || 0;
  }

  /* ---------------- integration ---------------- */

  /**
   * Advance the world by `months` (fractional allowed).
   * `regionScope` (optional) additionally records a regional series sample.
   */
  step(months = null, regionScope = null) {
    const m = months ?? this.time.stepMonths ?? 1;
    const p = this.params;
    this.stars.primary.apply({ irradiance: p.irradiance, tempK: p.starTemp });
    this.triggerImpacts(m);
    // internal resolution: sub-monthly substeps keep the seasonal cycle smooth
    const substeps = clamp(Math.round(4 * Math.max(1, this.time.stepMonths || 1)), 2, 24);
    stepClimate(this.grid, this, m, substeps);
    this.time.month += m;
    this.frameId++;
    this.refreshFields();
    this.updateAnomaly();
    this.sampleSeries(regionScope);
    this.checkpoint(false);
    return m;
  }

  /**
   * The bombardment plan: one entry per meteor, each with its own time, mass and
   * landing site.
   *
   * Deterministic for a given seed and parameter set, so impacts replay identically
   * on reload — otherwise save/load and branch comparison would not be reproducible.
   * Rebuilt whenever the meteor parameters change.
   *
   * Sites are drawn uniformly *on the sphere* (`asin` of a uniform draw) rather than
   * uniformly in latitude: a flat latitude draw would bunch impacts towards the poles
   * and leave the tropics under-bombarded, because a degree of latitude near the pole
   * covers far less area than one at the equator.
   */
  meteorPlan() {
    const p = this.params;
    const count = clamp(Math.round(p.meteorCount ?? 1), 1, 500);
    const start = Math.max(0, Math.round(p.meteorMonth ?? 0));
    const rawEnd = Math.round(p.meteorEndMonth ?? start);
    // a single meteor has no window to spread over
    const end = count > 1 ? Math.max(start, rawEnd) : start;
    const mass = Math.max(0, p.meteorMass ?? 0);
    const sigma = clamp(p.meteorMassSigma ?? 0, 0, 1);
    const sig = `${count}|${start}|${end}|${mass}|${sigma}`;
    if (this._meteorSig === sig && this._meteorPlan) return this._meteorPlan;

    const rng = new Rng((this.seed >>> 0) ^ (count * 2654435761) ^ (start * 40503) ^ end);
    const span = Math.max(0, end - start);
    const plan = [];
    for (let n = 0; n < count; n++) {
      // evenly spaced across the window plus a deterministic jitter, so a long
      // bombardment does not read as a metronome
      const base = count > 1 ? (span * n) / (count - 1) : 0;
      const jitter = span > 1 ? rng.range(-0.5, 0.5) * (span / count) : 0;
      const month = clamp(Math.round(start + base + jitter), start, end);
      // log-normal masses with the requested mean and *relative* standard deviation,
      // so "重量相对方差" stays a dimensionless spread around the mean
      const gauss = rng.gauss(0, 1);
      plan.push({
        month,
        mass: mass * Math.exp(sigma * gauss - sigma * sigma / 2),
        lat: Math.asin(clamp(rng.range(-1, 1), -1, 1)) * 180 / Math.PI,
        lon: rng.range(-180, 180),
      });
    }
    plan.sort((a, b) => a.month - b.month);
    this._meteorSig = sig;
    this._meteorPlan = plan;
    return plan;
  }

  /**
   * Decaying impactor-mass reservoir at a given month: each meteor's mass decays
   * from *its own* impact month, so a bombardment spread over years is modelled
   * correctly instead of all of the dust being pinned to the last impact.
   *
   * This returns *mass*, and the dust load is derived from it by `dustLoadForMass` —
   * deliberately, rather than summing per-meteor loads. That curve is logarithmic, so
   * summing it per meteor makes N small impacts far worse than one impactor of the
   * same total mass: four 1e15 kg impacts would each contribute 0.94 and saturate at
   * 3.0, where a single 4e15 kg impactor gives 1.13. Summing the mass first keeps the
   * documented single-impactor scale intact however the same total is split up — and
   * it is also what stops a modest shower from blacking out the sky and collapsing
   * the habitability index.
   */
  dustReservoir(month) {
    const list = this.impacts || [];
    if (!list.length) return 0;
    const tau = (this.impact && this.impact.decayYears) || 2.2;
    let sum = 0;
    for (const m of list) {
      const age = Math.max(0, (month - m.month) / 12);           // years
      sum += m.mass * Math.exp(-age / tau);
    }
    return sum;
  }

  /** Stratospheric dust load implied by the reservoir at a given month. */
  dustLoadAt(month) {
    if (!this.impacts || !this.impacts.length) return 0;
    return dustLoadForMass(this.dustReservoir(month));
  }

  /**
   * Fire the meteor shower as the clock passes each scheduled impact.
   *
   * Meteors land at *separate*, randomly drawn sites (this used to place every one of
   * them on a single site regardless of count), each with its own mass, blast footprint
   * and local fireball pulse, and they are spread across the configured time window.
   *
   * The shower is a *state* on the world (not a parameter) so it survives checkpoints
   * and branching: `impact.month` is when the last one landed, `load` is the dust it
   * injected, and `cells`/`heat` describe the local blast.
   */
  triggerImpacts(stepMonths = 1) {
    const p = this.params;
    if (!p.meteorEnabled) return null;
    const plan = this.meteorPlan();
    const now = this.time.month + stepMonths;
    if (!this.impacts) this.impacts = [];
    const g = this.grid;

    // everything scheduled at or before the end of this step that has not fired yet
    // (a plan whose window lies in the past simply catches up in one step)
    const firedNow = [];
    for (let n = this.impacts.length; n < plan.length; n++) {
      if (plan[n].month > now) break;                            // plan is sorted by month
      const m = plan[n];
      const heat = clamp(30 * Math.log10(1 + m.mass / 1e11), 0, 300);
      // Blast footprint: scales as the cube root of the mass (crater/energy scaling),
      // ~30 km for 1e12 kg, ~300 km for 1e15 kg (Chicxulub-class), ~3000 km for 1e18 kg.
      const blastKm = 30 * Math.cbrt(Math.max(0, m.mass) / 1e12);
      const radiusDeg = clamp(blastKm / 111, 0.4, 60);
      const j = clamp(Math.round((90 - m.lat) / 180 * g.NB), 0, g.NB - 1);
      const i = clamp(Math.round((m.lon + 180) / 360 * g.NL), 0, g.NL - 1);
      const kk = i + j * g.NL;
      // Specific impact energy: ½mv² with v ≈ 20 km/s. The *fireball* is a local
      // transient, so it is expressed as a bounded, monotone surface pulse rather
      // than as the raw energy dumped into one climate cell.
      g.T[kk] = clamp((g.T[kk] || 288) + heat, 70, 1400);
      const rec = { month: m.month, mass: m.mass, lat: m.lat, lon: m.lon, heat, blastKm, radiusDeg, cell: kk };
      this.impacts.push(rec);
      firedNow.push(rec);
    }
    if (!firedNow.length) return this.impact;

    const last = firedNow[firedNow.length - 1];
    const biggest = firedNow.reduce((a, b) => (b.blastKm > a.blastKm ? b : a), firedNow[0]);
    let total = 0;
    for (const m of this.impacts) total += m.mass;
    const reservoir = this.dustReservoir(now);
    const reservoirLoad = dustLoadForMass(reservoir);
    this.impactSite = { lat: last.lat, lon: last.lon };
    this.impact = {
      triggeredAt: Math.max(0, Math.round(p.meteorMonth ?? 0)),
      month: last.month,
      count: this.impacts.length,
      mean: p.meteorMass, sigma: p.meteorMassSigma,
      total, masses: this.impacts.map((m) => m.mass),
      reservoirMass: reservoir,
      load: reservoirLoad,
      heat: firedNow.reduce((a, b) => a + b.heat, 0),
      site: { lat: last.lat, lon: last.lon },
      decayYears: 2.2,
      // the animation ring uses the largest blast of this batch
      radiusDeg: biggest.radiusDeg,
      blastKm: biggest.blastKm,
      firedNow: firedNow.length,
      // every impact so far, so a shower can be drawn at all of its sites
      sites: this.impacts.map((m) => ({
        lat: m.lat, lon: m.lon, radiusDeg: m.radiusDeg, blastKm: m.blastKm, mass: m.mass, month: m.month,
      })),
    };
    emit('impact', this.impact);
    const window = this.impact.sites.length && p.meteorCount > 1
      ? `（第 ${Math.round(p.meteorMonth ?? 0)}–${Math.max(Math.round(p.meteorMonth ?? 0), Math.round(p.meteorEndMonth ?? 0))} 月）`
      : '';
    emit('toast', `陨石轰击${window}：本次 ${firedNow.length} 颗 / 累计 ${this.impacts.length} 颗，` +
      `总质量 ${total.toExponential(2)} kg，尘埃负荷 ${reservoirLoad.toFixed(2)}`);
    return this.impact;
  }

  updateAnomaly() {
    const g = this.grid;
    if (!this.anomalyBase) return;
    for (let k = 0; k < g.n; k++) {
      const t = g.tAnnual[k] || g.T[k];
      g.tAnomaly[k] = t - this.anomalyBase[k];
    }
  }

  setAnomalyBaseline() {
    const g = this.grid;
    this.anomalyBase = new Float32Array(g.n);
    for (let k = 0; k < g.n; k++) this.anomalyBase[k] = g.tAnnual[k] || g.T[k];
    for (let k = 0; k < g.n; k++) g.tAnomaly[k] = 0;
  }

  /* ---------------- sampling ---------------- */

  sampleSeries(regionScope = null) {
    const g = this.grid;
    const p = this.params;
    const values = {
      tGlobal: this.tGlobal,
      tAnnual: this.tGlobalAnnual ?? this.tGlobal,
      co2: p.co2,
      seaLevel: (this.seaLevelDelta || 0) + (p.seaLevel || 0),
      iceArea: (this.iceAreaFrac ?? iceAreaFraction(g)) * 100,
      energy: this.energyNet,
      biomass: this.biomass,
      precip: averageField(g, g.precip),
      albedo: this.albedoGlobal,
      olr: this.olrGlobal,
    };
    this.series.push(this.time.month, values);
    if (regionScope) {
      const r = regionScope;
      const reg = r.region || regionSeriesFields(this, r.lat, r.lon, r.radiusDeg ?? 4);
      const regional = {
        tGlobal: weightedAverage(g, g.T, reg),
        co2: p.co2,
        seaLevel: values.seaLevel,
        iceArea: weightedAverage(g, g.seaIce, reg) * 100,
        energy: weightedAverage(g, g.net, reg),
        biomass: weightedAverage(g, g.biomass, reg),
        precip: weightedAverage(g, g.precip, reg),
        albedo: weightedAverage(g, g.albedo, reg),
        olr: weightedAverage(g, g.olr, reg),
      };
      this.series.pushRegion(r.scope, { lat: r.lat, lon: r.lon, radiusDeg: r.radiusDeg ?? 4 }, regional);
    }
    return values;
  }

  metrics() {
    const g = this.grid;
    return {
      tGlobal: this.tGlobal,
      tGlobalC: this.tGlobal - 273.15,
      anomaly: this.tGlobal - 288,
      co2: this.params.co2,
      co2Eq: effectiveTau(this.params, this.tGlobal),
      seaLevel: (this.seaLevelDelta || 0) + (this.params.seaLevel || 0),
      iceArea: (this.iceAreaFrac ?? 0) * 100,
      iceVolumeEarth: this.iceVolumeEarth,
      energy: this.energyNet,
      absorbed: this.absorbedGlobal,
      olr: this.olrGlobal,
      albedo: this.albedoGlobal,
      biomass: this.biomass,
      precip: averageField(g, g.precip),
      oceanFraction: this.oceanFraction * 100,
      tau: this.tau,
      month: this.time.month,
    };
  }

  /* ---------------- layers ---------------- */

  layerData(key) { return computeLayer(this, key); }

  /**
   * `rangeOverride` / `rampChoice` are pushed in by the UI when the user edits
   * the colourbar from the legend, so the physics module never needs to know
   * about app state.
   */
  layerRange(key) {
    const data = this.layerData(key);
    return layerRange(key, data, this.rangeOverride ? this.rangeOverride(key) : null);
  }

  layerVector(key, lat, lon) { return layerVector(this, key, lat, lon); }

  baseTexture() { return computeBaseTexture(this); }
  invalidateBase() { this.baseDirty = true; }

  /* ---------------- probes ---------------- */

  probe(lat, lon, radiusDeg) { return probeAt(this, lat, lon, radiusDeg); }

  regionScopeFor(lat, lon, radiusDeg) {
    const scope = `r:${lat.toFixed(1)},${lon.toFixed(1)},${(radiusDeg || 4).toFixed(1)}`;
    return { scope, lat, lon, radiusDeg: radiusDeg || 4, region: regionSeriesFields(this, lat, lon, radiusDeg || 4) };
  }

  /* ---------------- persistence ---------------- */

  snapshot() {
    const g = this.grid;
    return {
      month: this.time.month,
      tGlobal: this.tGlobal,
      T: Float32Array.from(g.T),
      ice: Float32Array.from(g.ice),
      snow: Float32Array.from(g.snow),
      vegetation: Float32Array.from(g.vegetation),
      seaLevelDelta: this.seaLevelDelta,
      iceVolumeM3: g.iceVolumeM3,
      anomalyBase: this.anomalyBase ? Float32Array.from(this.anomalyBase) : null,
      impact: this.impact ? { ...this.impact } : null,
      impactSite: this.impactSite ? { ...this.impactSite } : null,
      // the per-meteor record is what the dust reservoir is derived from, so it has to
      // travel with the snapshot — otherwise reloading would resurrect every meteor
      impacts: this.impacts ? this.impacts.map((m) => ({ ...m })) : null,
    };
  }

  restore(snap) {
    if (!snap) return;
    const g = this.grid;
    // A *compact* scene (the localStorage slot format) deliberately keeps only a
    // few scalars, so every field has to be optional here.
    if (snap.T) g.T.set(snap.T);
    if (snap.ice) g.ice.set(snap.ice);
    if (snap.snow) g.snow.set(snap.snow);
    if (snap.vegetation) g.vegetation.set(snap.vegetation);
    this.time.month = snap.month;
    this.tGlobal = snap.tGlobal;
    this.seaLevelDelta = snap.seaLevelDelta ?? 0;
    this.iceVolumeM3 = snap.iceVolumeM3 ?? 0;
    this.anomalyBase = snap.anomalyBase ? Float32Array.from(snap.anomalyBase) : null;
    this.impact = snap.impact ? { ...snap.impact } : null;
    this.impactSite = snap.impactSite ? { ...snap.impactSite } : null;
    // `impacts` is optional so a compact scene still loads; without it the meteor
    // count restarts, which is why checkpoints always carry it.
    this.impacts = snap.impacts ? snap.impacts.map((m) => ({ ...m })) : (snap.impact ? [] : null);
    this.layerCache.clear();
    this.refreshFields();
    this.updateAnomaly();
  }

  checkpoint(force) {
    this.history.maybePush(this, force);
  }

  clone(opts = {}) {
    const w = Object.create(World.prototype);
    w.params = { ...this.params };
    w.name = opts.name || this.name;
    w.seed = this.seed;
    w.time = { ...this.time };
    w.stars = new Stars(this.stars.list.map((s) => new Star({ ...s })));
    w.terrain = {
      GX: this.terrain.GX, GY: this.terrain.GY,
      height: Float32Array.from(this.terrain.height),
      waterMask: this.terrain.waterMask ? Uint8Array.from(this.terrain.waterMask) : null,
      river: this.terrain.river ? Float32Array.from(this.terrain.river) : null,
      meta: this.terrain.meta ? { ...this.terrain.meta } : null,
      waterLevel: this.terrain.waterLevel,
      terrainEdit: this.terrain.terrainEdit ? { ...this.terrain.terrainEdit } : null,
    };
    w.grid = cloneGrid(this.grid);
    w.tGlobal = this.tGlobal;
    w.tau = this.tau;
    w.absorbedGlobal = this.absorbedGlobal;
    w.olrGlobal = this.olrGlobal;
    w.energyNet = this.energyNet;
    w.albedoGlobal = this.albedoGlobal;
    w.oceanFraction = this.oceanFraction;
    w.seaLevelDelta = this.seaLevelDelta;
    w.biomass = this.biomass;
    w.iceVolumeEarth = this.iceVolumeEarth;
    w.iceAreaFrac = this.iceAreaFrac;
    w.iceBaselineVolume = this.iceBaselineVolume;
    w.layerCache = new Map();
    w.frameId = 0;
    w.series = Series.fromJSON(this.series.toJSON());
    w.history = new CheckpointHistory();
    w.history.adopt(this.history, w);
    w.anomalyBase = this.anomalyBase ? Float32Array.from(this.anomalyBase) : null;
    w.seriesStart = this.seriesStart;
    w.impact = this.impact ? { ...this.impact, masses: this.impact.masses ? this.impact.masses.slice() : null } : null;
    w.impactSite = this.impactSite ? { ...this.impactSite } : null;
    w.impacts = this.impacts ? this.impacts.map((m) => ({ ...m })) : null;
    w.baseDirty = true;
    return w;
  }
}

function cloneGrid(g) {
  const out = makeGrid(g.NB, g.NL);
  for (const key of Object.keys(g)) {
    const v = g[key];
    if (v instanceof Float32Array) out[key] = Float32Array.from(v);
    else if (v instanceof Uint16Array) out[key] = Uint16Array.from(v);
    else if (v instanceof Float64Array) out[key] = Float64Array.from(v);
  }
  out.seasonMonths = g.seasonMonths;
  out.monthAccum = g.monthAccum;
  out.iceVolumeM3 = g.iceVolumeM3;
  return out;
}

/* ------------------------------------------------------------------ */
/* checkpoints                                                         */
/* ------------------------------------------------------------------ */

/**
 * Sparse snapshot ring used for timeline scrubbing and for resuming a branch.
 * Density is monthly for the first decade and thins out for long runs.
 */
export class CheckpointHistory {
  constructor() { this.items = []; }

  intervalFor(month) {
    if (month < 24) return 1;
    if (month < 120) return 3;
    if (month < 600) return 12;
    if (month < 2400) return 60;
    if (month < 12000) return 240;
    return 1200;
  }

  maybePush(world, force) {
    const month = world.time.month;
    const last = this.items[this.items.length - 1];
    if (!force && last && month - last.month < this.intervalFor(month)) return false;
    this.items.push(world.snapshot());
    if (this.items.length > MAX_CHECKPOINTS) {
      // drop every second old checkpoint to keep the ring bounded
      this.items = this.items.filter((_, i) => i % 2 === 0 || i >= this.items.length - 24);
    }
    return true;
  }

  nearest(month) {
    let best = null, bestD = Infinity;
    for (const it of this.items) {
      const d = Math.abs(it.month - month);
      if (d < bestD) { bestD = d; best = it; }
    }
    return best;
  }

  dump() {
    // Only a coarse subset is persisted, and each field is quantised to int16:
    // the full grid x 40 checkpoints would otherwise blow the localStorage
    // quota (a 360x180 terrain plus float checkpoints is tens of megabytes).
    const keep = [];
    const step = Math.max(1, Math.ceil(this.items.length / 24));
    for (let i = 0; i < this.items.length; i += step) keep.push(this.items[i]);
    const last = this.items[this.items.length - 1];
    if (last && keep[keep.length - 1] !== last) keep.push(last);
    const q = (arr, scale) => {
      const out = new Int16Array(arr.length);
      for (let i = 0; i < arr.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(arr[i] * scale)));
      return Array.from(out);
    };
    return keep.map((s) => ({
      month: Math.round(s.month * 100) / 100,
      tGlobal: Math.round(s.tGlobal * 100) / 100,
      seaLevelDelta: s.seaLevelDelta,
      tScale: 100,
      iScale: 1000,
      T: q(s.T, 100),
      ice: q(s.ice, 1000),
      snow: q(s.snow, 1000),
      vegetation: q(s.vegetation, 1000),
      anomalyBase: s.anomalyBase ? q(s.anomalyBase, 100) : null,
    }));
  }

  loadDump(arr, world) {
    this.items = (arr || []).map((s) => ({
      month: s.month,
      tGlobal: s.tGlobal,
      seaLevelDelta: s.seaLevelDelta,
      T: Float32Array.from(s.T, (v) => v / (s.tScale || 100)),
      ice: Float32Array.from(s.ice || [], (v) => v / (s.iScale || 1000)),
      snow: Float32Array.from(s.snow || [], (v) => v / (s.iScale || 1000)),
      vegetation: Float32Array.from(s.vegetation || [], (v) => v / (s.iScale || 1000)),
      anomalyBase: s.anomalyBase ? Float32Array.from(s.anomalyBase, (v) => v / (s.tScale || 100)) : null,
      iceVolumeM3: 0,
    }));
    return this;
  }

  /** Copy checkpoints from another history, re-basing them onto `world`. */
  adopt(other, world) {
    this.items = other.items.map((s) => ({ ...s }));
  }
}

/* ------------------------------------------------------------------ */
/* terrain helpers used by the editor / wizard                         */
/* ------------------------------------------------------------------ */

export function refreshRivers(world) {
  const r = computeRivers(world.terrain);
  world.terrain.river = r.intensity;
  return r;
}

export function applyTerrainScale(terrain, factor) {
  const H = terrain.height;
  for (let i = 0; i < H.length; i++) H[i] *= factor;
  for (let i = 0; i < H.length; i++) H[i] = clamp(H[i], -13000, 13000);
  return terrain;
}

/** Gentle smoothing that leaves plateaus intact but removes 1-cell spikes. */
export function smoothTerrainVisual(terrain, passes = 2) {
  const { GX, GY, height: H } = terrain;
  if (!terrain._smooth) terrain._smooth = new Float32Array(H.length);
  const tmp = terrain._smooth;
  for (let p = 0; p < passes; p++) {
    for (let j = 0; j < GY; j++) {
      for (let i = 0; i < GX; i++) {
        const k = i + j * GX;
        const e = (i + 1) % GX, w = (i - 1 + GX) % GX;
        const n = Math.max(0, j - 1), s = Math.min(GY - 1, j + 1);
        tmp[k] = H[k] * 0.4 + (H[e + j * GX] + H[w + j * GX] + H[i + n * GX] + H[i + s * GX]) * 0.15;
      }
    }
    H.set(tmp);
  }
  return terrain;
}

/** Re-exported so callers can keep importing terrain helpers from one place. */
export { updateWaterMask, terrainToObject, terrainFromObject } from './terrain.js';

/** Re-derive sea level so the requested ocean fraction is met. */
export function reshapeToOceanFraction(terrain, fraction) {
  applyOceanTarget(terrain, fraction);
  updateWaterMask(terrain);
  return terrain;
}

export { allocTerrain, dailyInsolation, SIGMA, BASE, GLOBAL_SCOPE, ALL_SERIES_KEYS, regionSeriesFields };
