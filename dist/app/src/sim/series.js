/**
 * Time series store. Each branch owns one Series; a Series owns a global scope
 * (area-weighted planetary means) plus lazily created regional scopes so the
 * charts can follow a selected probe / region.
 */

export const GLOBAL_SCOPE = 'global';

export const SERIES_DEFS = [
  { key: 'tGlobal', label: '平均地表温度', unit: 'K', color: '#b8706a', dec: 2, tall: true },
  { key: 'tAnnual', label: '平均地表温度（12 月滑动平均）', unit: 'K', color: '#c9a878', dec: 2, tall: true },
  { key: 'co2', label: 'CO₂ 浓度', unit: 'ppm', color: '#8f97a6', dec: 1 },
  { key: 'seaLevel', label: '海平面', unit: 'm', color: '#6b8fae', dec: 2 },
  { key: 'iceArea', label: '冰盖面积', unit: '%', color: '#9fb4c4', dec: 2 },
  { key: 'energy', label: '能量收支（净）', unit: 'W/m²', color: '#a89a6e', dec: 3, tall: true },
  { key: 'biomass', label: '生物量（相对地球）', unit: '', color: '#7d9c76', dec: 3 },
  { key: 'precip', label: '平均降水', unit: 'mm/月', color: '#5f9ab0', dec: 2, secondary: true },
  { key: 'albedo', label: '行星反照率', unit: '', color: '#8f8f9c', dec: 4, secondary: true },
  { key: 'olr', label: '长波逸出 OLR', unit: 'W/m²', color: '#b08a63', dec: 2, secondary: true },
];

export const SERIES_KEYS = SERIES_DEFS.map((d) => d.key).filter((k) => k !== 'precip' && k !== 'albedo' && k !== 'olr');
export const ALL_SERIES_KEYS = SERIES_DEFS.map((d) => d.key);

export class Series {
  constructor(capacity = 20000) {
    this.capacity = capacity;
    this.months = [];
    this.scopes = new Map();
    this.ensure(GLOBAL_SCOPE);
  }

  ensure(scope) {
    let s = this.scopes.get(scope);
    if (!s) {
      s = { name: scope, label: scope === GLOBAL_SCOPE ? '全球平均' : scope, meta: null };
      for (const k of ALL_SERIES_KEYS) s[k] = [];
      this.scopes.set(scope, s);
    }
    return s;
  }

  /** Append a global sample; `values` maps series keys to numbers. */
  push(month, values) {
    if (this.months.length >= this.capacity) this.decimate();
    this.months.push(month);
    const g = this.ensure(GLOBAL_SCOPE);
    for (const k of ALL_SERIES_KEYS) g[k].push(num(values[k]));
    return this;
  }

  /**
   * Record a regional sample aligned with the most recent global sample.
   * The first time a region is seen, the previous samples are back-filled with
   * NaN so the array stays index-aligned with `months`.
   */
  pushRegion(scope, meta, values) {
    const s = this.ensure(scope);
    s.meta = meta;
    const n = this.months.length;
    for (const k of ALL_SERIES_KEYS) {
      const arr = s[k];
      while (arr.length < n - 1) arr.push(NaN);
      if (arr.length === n - 1) arr.push(num(values[k]));
      else arr[n - 1] = num(values[k]);
      if (arr.length > n) arr.length = n;
    }
    return this;
  }

  /** Halve the resolution, keeping every second sample (long runs stay cheap). */
  decimate() {
    const keep = [];
    for (let i = 0; i < this.months.length; i += 2) keep.push(i);
    const last = this.months.length - 1;
    if (keep[keep.length - 1] !== last) keep.push(last);
    this.months = keep.map((i) => this.months[i]);
    for (const s of this.scopes.values()) {
      for (const k of ALL_SERIES_KEYS) s[k] = keep.map((i) => s[k][i]);
    }
    this.stride = (this.stride || 1) * 2;
    return this;
  }

  length() { return this.months.length; }
  lastMonth() { return this.months.length ? this.months[this.months.length - 1] : 0; }

  /** Value of a series at a stored index, falling back to the nearest sample. */
  at(scope, key, index) {
    const s = this.scopes.get(scope) || this.scopes.get(GLOBAL_SCOPE);
    const arr = s[key];
    if (!arr || !arr.length) return NaN;
    const i = Math.max(0, Math.min(arr.length - 1, Math.round(index * (arr.length - 1) / Math.max(1, this.months.length - 1))));
    return arr[i];
  }

  indexForMonth(month) {
    const n = this.months.length;
    if (!n) return -1;
    if (month >= this.months[n - 1]) return n - 1;
    if (month <= this.months[0]) return 0;
    // binary search
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.months[mid] < month) lo = mid + 1; else hi = mid;
    }
    return Math.max(0, lo - (this.months[lo] > month && lo > 0 ? 1 : 0));
  }

  /** Min/max over the whole record for axis scaling. */
  range(scope, key) {
    const s = this.scopes.get(scope) || this.scopes.get(GLOBAL_SCOPE);
    const arr = s[key] || [];
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (!isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    if (hi - lo < 1e-9) { hi = lo + 1; }
    return { lo, hi };
  }

  sceneAt(index) {
    const g = this.scopes.get(GLOBAL_SCOPE);
    const out = { month: this.months[index] ?? 0 };
    for (const k of ALL_SERIES_KEYS) out[k] = g[k][index];
    return out;
  }

  toJSON() {
    const scopes = {};
    for (const [id, s] of this.scopes) {
      const o = { name: s.name, label: s.label, meta: s.meta };
      for (const k of ALL_SERIES_KEYS) {
        // 4 significant decimals keeps JSON small without visible loss
        o[k] = s[k].map((v) => (isFinite(v) ? Math.round(v * 1e4) / 1e4 : null));
      }
      scopes[id] = o;
    }
    return { stride: this.stride || 1, months: this.months.map((m) => Math.round(m * 100) / 100), scopes };
  }

  static fromJSON(j) {
    const s = new Series();
    if (!j) return s;
    s.stride = j.stride || 1;
    s.months = (j.months || []).slice();
    s.scopes.clear();
    for (const [id, o] of Object.entries(j.scopes || {})) {
      const sc = s.ensure(id);
      sc.label = o.label || id;
      sc.meta = o.meta || null;
      for (const k of ALL_SERIES_KEYS) {
        sc[k] = (o[k] || []).map((v) => (v === null || v === undefined ? NaN : v));
      }
    }
    if (!s.scopes.size) s.ensure(GLOBAL_SCOPE);
    return s;
  }
}

function num(v) { const n = Number(v); return isFinite(n) ? n : NaN; }
