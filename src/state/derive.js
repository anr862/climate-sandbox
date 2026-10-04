/**
 * The "auto derive" parameter rules, as one pure function.
 *
 * These rules were previously inlined in state.js's applyAutoRules(), and every
 * offline check script re-implemented them by hand. That duplication caused a real
 * and expensive bug: the scripts mirrored the *cloud* rule
 * (`cloud = 12 + humidity·0.72`) but fed it `defaults().humidity` (68) instead of the
 * humidity the water-vapour rule derives (78), so they calibrated the whole climate
 * against cloud cover 60.96 while the app really ran at 68.16. Node said "steady at
 * 288 K"; the browser slid into a snowball in 30 years.
 *
 * Keeping the rules here means the app and the checks cannot drift apart again:
 * scripts call `deriveAuto(defaults(), { tGlobal, oceanFraction })` and get exactly
 * what the app will use.
 */

/** Clausius–Clapeyron scaling reference: %RH at BASE.tRef with full ocean supply. */
export const HUMIDITY_REF = 78;
export const OCEAN_SUPPLY_REF = 70.8;
export const T_REF = 288;
export const CC_SCALE_K = 14;
export const CLOUD_BASE = 12;
export const CLOUD_PER_HUMIDITY = 0.72;

const round = (v, d) => {
  const f = Math.pow(10, d);
  return Math.round(v * f) / f;
};

/**
 * Apply the constraint rules in place and return the same object.
 *
 * @param {object} p        parameter bag (mutated)
 * @param {object} ctx      { tGlobal, oceanFraction, clamp } — `clamp(key, value)`
 *                          is optional and mirrors params.js coerce(); when omitted
 *                          only the rules' own min/max caps apply.
 * @param {function} locked (key) => true to skip the rule that owns `key`
 */
export function deriveAuto(p, ctx = {}, locked = () => false) {
  const clamp = typeof ctx.clamp === 'function' ? ctx.clamp : null;
  const put = (key, value) => {
    if (clamp) p[key] = clamp(key, value);
    else p[key] = value;
  };

  // 1) radius -> surface gravity (constant density assumption for rocky worlds)
  if (!locked('gravity')) {
    put('gravity', round(9.807 * (p.planeRadiusKm / 6371), 2));
  }
  // 2) dry-air composition sums to ~100 %
  if (!locked('n2')) {
    const others = p.o2 + p.co2 / 1e4 + p.otherGas;
    put('n2', round(Math.max(0, 100 - others), 2));
  }
  // 3) water vapour tracks temperature, ocean supply and pressure
  if (!locked('humidity') && ctx.tGlobal) {
    const sat = Math.exp((ctx.tGlobal - T_REF) / CC_SCALE_K) * HUMIDITY_REF;
    const supply = 0.25 + 0.75 * Math.min(1, (ctx.oceanFraction ?? OCEAN_SUPPLY_REF) / OCEAN_SUPPLY_REF);
    put('humidity', round(Math.min(100, sat * supply), 1));
  }
  // 4) cloud cover follows humidity
  if (!locked('cloud')) {
    put('cloud', round(Math.min(96, CLOUD_BASE + p.humidity * CLOUD_PER_HUMIDITY), 1));
  }
  return p;
}

/**
 * The parameter bag the app actually boots with, for use by offline checks and
 * calibration scripts. Mirrors `defaults()` + applyAutoRules at the initial derived
 * state (tGlobal 288 K, oceanFraction 70.8 %).
 */
export function appDefaultParams(defaultsFn, ctx = {}) {
  const p = defaultsFn();
  deriveAuto(p, { tGlobal: T_REF, oceanFraction: OCEAN_SUPPLY_REF, ...ctx });
  return p;
}
