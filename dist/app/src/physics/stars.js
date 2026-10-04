/**
 * Stellar irradiation.
 *
 * The current release simulates a single star. Multi-star support is a
 * reserved interface: a World owns a list of `Star` objects and asks the list
 * for the total flux at a given point / time. Adding a second star therefore
 * only requires filling in `Stars.fluxAt` — no other module has to change.
 */

export const EARTH_TSI = 1361; // W/m^2

export class Star {
  constructor(cfg = {}) {
    this.apply(cfg);
  }
  apply(cfg) {
    this.id = cfg.id ?? 'star-1';
    this.label = cfg.label ?? '主星';
    this.irradiance = num(cfg.irradiance, 1361);     // W/m^2 at the planet's orbit
    this.tempK = num(cfg.tempK, 5772);               // effective temperature
    this.radiusKm = num(cfg.radiusKm, 696340);
    this.orbitAU = num(cfg.orbitAU, 1);              // orbital radius of the source
    this.phase = num(cfg.phase, 0);                  // orbital phase (deg) — multi-star
    this.spectralWeight = num(cfg.spectralWeight, 1); // albedo weighting
    return this;
  }
  /** Fractional flux relative to Earth's present value. */
  get relative() { return this.irradiance / EARTH_TSI; }
}

export class Stars {
  constructor(list = []) { this.list = list; }
  static single(cfg) { return new Stars([new Star(cfg)]); }
  get count() { return this.list.length; }
  get primary() { return this.list[0]; }

  /** Total top-of-atmosphere flux. `t` is the simulation clock in months. */
  fluxAt(t = 0) {
    let total = 0;
    for (const s of this.list) {
      // reserved: each star may carry its own modulation (eclipses, phases)
      total += s.irradiance * (s.modulation ? s.modulation(t) : 1);
    }
    return total;
  }

  /** Weighted spectral hardness, fed into the surface albedo model. */
  spectralWeight() {
    let w = 0, f = 0;
    for (const s of this.list) { w += s.spectralWeight * s.irradiance; f += s.irradiance; }
    return f > 0 ? w / f : 1;
  }

  toJSON() { return this.list.map((s) => ({ ...s })); }
}

function num(v, d) { const n = Number(v); return isFinite(n) ? n : d; }
