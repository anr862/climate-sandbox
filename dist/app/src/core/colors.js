/**
 * Muted scientific colour ramps + data-layer registry.
 * Every ramp is deliberately desaturated so superimposed layers stay readable
 * on a dark UI (no neon, no bloom).
 */

export function hx(h) {
  const s = h.replace('#', '');
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}
export function toHex(c) {
  const f = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return '#' + f(c[0]) + f(c[1]) + f(c[2]);
}
export function rgba(c, a = 1) { return `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`; }

/** Blend two RGB triples. */
export function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * Blend two RGB triples by scalar channels. Use this when one side is a bare
 * channel value (e.g. `shelf[0]`) rather than a colour triple — passing a number
 * to `mix` yields NaN.
 */
export function mix3(a0, a1, a2, b, t) {
  return [a0 + (b[0] - a0) * t, a1 + (b[1] - a1) * t, a2 + (b[2] - a2) * t];
}
export function lighten(hex, t) { return toHex(mix(hx(hex), [255, 255, 255], t)); }
export function darken(hex, t) { return toHex(mix(hx(hex), [0, 0, 0], t)); }

/** Build a sampler over stops [[pos, '#hex'], ...] (pos ascending 0..1). */
export function ramp(stops) {
  const sc = stops.map(([p, c]) => [p, hx(c)]);
  return function (t) {
    if (!isFinite(t)) t = 0;
    if (t <= sc[0][0]) return sc[0][1];
    if (t >= sc[sc.length - 1][0]) return sc[sc.length - 1][1];
    for (let i = 0; i < sc.length - 1; i++) {
      const [p0, c0] = sc[i], [p1, c1] = sc[i + 1];
      if (t >= p0 && t <= p1) return mix(c0, c1, (t - p0) / (p1 - p0 || 1));
    }
    return sc[sc.length - 1][1];
  };
}

/** Rasterise a ramp into a Uint8Array of size w*3 (for WebGL colormap textures). */
export function rampLut(fn, w = 256) {
  const out = new Uint8Array(w * 3);
  for (let i = 0; i < w; i++) {
    const c = fn(i / (w - 1));
    out[i * 3] = c[0] | 0; out[i * 3 + 1] = c[1] | 0; out[i * 3 + 2] = c[2] | 0;
  }
  return out;
}

export function cssGradient(fn, w = 24) {
  const parts = [];
  for (let i = 0; i < w; i++) {
    const t = i / (w - 1);
    parts.push(`${rgba(fn(t))} ${(t * 100).toFixed(1)}%`);
  }
  return `linear-gradient(90deg, ${parts.join(',')})`;
}

/* --------------------------------------------------------------------------
   Alternative colour ramps — all equally muted, offered in the legend editor so
   the user can pick the colourbar that reads best for the current layer
   -------------------------------------------------------------------------- */
export const ALT_RAMPS = {
  slate: {
    id: 'slate', label: '冷灰',
    fn: ramp([[0, '#242b33'], [0.3, '#39505f'], [0.6, '#5b7f90'], [1, '#9db6c2']]),
  },
  ember: {
    id: 'ember', label: '暖褐',
    fn: ramp([[0, '#2b2622'], [0.3, '#5c4634'], [0.6, '#96704a'], [1, '#c9a878']]),
  },
  moss: {
    id: 'moss', label: '苔绿',
    fn: ramp([[0, '#232a26'], [0.3, '#3d5340'], [0.6, '#6b8557'], [1, '#a8bd86']]),
  },
  mono: {
    id: 'mono', label: '灰阶',
    fn: ramp([[0, '#1b1f24'], [0.5, '#5c646c'], [1, '#c3c9cf']]),
  },
  duel: {
    id: 'duel', label: '冷暖对比',
    fn: ramp([[0, '#3d5f8c'], [0.5, '#6f747a'], [1, '#a8544f']]),
  },
  spectrum: {
    id: 'spectrum', label: '青→黄',
    fn: ramp([[0, '#20303c'], [0.35, '#3f7286'], [0.7, '#8a9a70'], [1, '#d0b878']]),
  },
  dusk: {
    id: 'dusk', label: '暮紫',
    fn: ramp([[0, '#26222f'], [0.3, '#4a4166'], [0.62, '#7d6a92'], [1, '#bfa8c4']]),
  },
  clay: {
    id: 'clay', label: '陶土',
    fn: ramp([[0, '#2a2422'], [0.28, '#5d4038'], [0.58, '#966a52'], [1, '#d3ac8a']]),
  },
  ice: {
    id: 'ice', label: '冰蓝',
    fn: ramp([[0, '#181f28'], [0.3, '#2c4a60'], [0.62, '#55809b'], [1, '#a9cade']]),
  },
  lime: {
    id: 'lime', label: '黄绿',
    fn: ramp([[0, '#1f2418'], [0.3, '#4a5a2c'], [0.62, '#8a9a4a'], [1, '#d6d488']]),
  },
};

const DIV_ALT_IDS = ['duel', 'slate', 'ember', 'dusk', 'clay', 'mono', 'ice', 'moss', 'lime'];
const SEQ_ALT_IDS = ['slate', 'spectrum', 'moss', 'ice', 'clay', 'dusk', 'lime', 'ember', 'mono'];

/**
 * Build a sampler from explicit stops: `[{ pos, color }]` with `pos` in 0..1.
 * `mode` is `continuous` (linear interpolation between stops) or `stepped`
 * (each stop's colour holds until the next one).
 */
export function rampFromStops(stops, mode = 'continuous') {
  const list = (stops || [])
    .filter((s) => s && isFinite(s.pos))
    .map((s) => ({ pos: clamp01(s.pos), color: hx(String(s.color || '#808080')) }))
    .sort((a, b) => a.pos - b.pos);
  if (!list.length) return ramp([[0, '#20262e'], [1, '#9db0c0']]);
  if (list.length === 1) return () => list[0].color;
  if (mode === 'stepped') {
    return function (t) {
      const x = clamp01(isFinite(t) ? t : 0);
      let c = list[0].color;
      for (const s of list) { if (x >= s.pos) c = s.color; else break; }
      return c;
    };
  }
  return ramp(list.map((s) => [s.pos, toHex(s.color)]));
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

/** Every colourbar the user may choose for a layer: 默认 + 9 alternatives = 10. */
export function rampChoices(layerKey) {
  const L = LAYERS[layerKey];
  if (!L || !L.ramp) return [];
  const ids = L.kind === 'div' ? DIV_ALT_IDS : SEQ_ALT_IDS;
  return [{ id: 'default', label: '默认', fn: L.ramp }]
    .concat(ids.map((id) => ALT_RAMPS[id]).filter(Boolean));
}

/**
 * Resolve the ramp actually used for a layer.
 * `custom` (from the colourbar editor) wins over the preset choice.
 */
export function rampFor(layerKey, choiceId, custom) {
  if (custom && custom.stops && custom.stops.length) {
    return rampFromStops(custom.stops, custom.mode);
  }
  const choices = rampChoices(layerKey);
  if (!choices.length) return null;
  const hit = choices.find((c) => c.id === choiceId);
  return (hit || choices[0]).fn;
}

/* --------------------------------------------------------------------------
   Ramps (muted)
   -------------------------------------------------------------------------- */
const R = {
  temp: ramp([[0, '#3f4f78'], [0.14, '#4b6a94'], [0.3, '#5d8aa0'], [0.44, '#7ba38e'],
    [0.56, '#c0b47e'], [0.7, '#c08a63'], [0.84, '#b26a5f'], [1, '#8c4b56']]),
  precip: ramp([[0, '#22262b'], [0.1, '#3b4a52'], [0.3, '#40667a'], [0.55, '#4d7f97'],
    [0.78, '#5f9ab0'], [1, '#7fb6c9']]),
  oxygen: ramp([[0, '#4d4a44'], [0.2, '#5f5b4e'], [0.45, '#7c7a5e'], [0.7, '#9aa684'], [1, '#bcd0ac']]),
  humidity: ramp([[0, '#4a4238'], [0.25, '#6a6a56'], [0.5, '#5c7f80'], [0.75, '#4f7fa8'], [1, '#6b9fd0']]),
  vegetation: ramp([[0, '#4a4536'], [0.18, '#5a5738'], [0.4, '#5b6b3e'], [0.65, '#68855c'], [1, '#7fa87a']]),
  habitability: ramp([[0, '#5c3a38'], [0.22, '#8a6244'], [0.45, '#9a9459'], [0.7, '#7fa06a'], [1, '#6fa287']]),
  toxicity: ramp([[0, '#3a4149'], [0.2, '#5a5548'], [0.45, '#8a7346'], [0.72, '#a86a4e'], [1, '#8c4a4a']]),
  aerosol: ramp([[0, '#3a4048'], [0.3, '#5e5a52'], [0.6, '#8a8171'], [1, '#b0a693']]),
  diurnal: ramp([[0, '#3d5573'], [0.25, '#4f7387'], [0.5, '#7f8a75'], [0.75, '#b08a5f'], [1, '#b06a52']]),
  seasonal: ramp([[0, '#3b4b6b'], [0.25, '#546a86'], [0.5, '#8b8c7d'], [0.75, '#b38a5c'], [1, '#a85f4d']]),
  anomaly: ramp([[0, '#3f5f84'], [0.35, '#5d7f9c'], [0.5, '#767f86'], [0.65, '#b07a5e'], [1, '#a04f4b']]),
  seaIce: ramp([[0, '#1d2733'], [1, '#b6c6d4']]),
  wind: ramp([[0, '#2b3440'], [0.25, '#3f5f7a'], [0.5, '#5f8fa8'], [0.75, '#9aa88f'], [1, '#cbb072']]),
  current: ramp([[0, '#1f2a33'], [0.25, '#2f5568'], [0.5, '#3f7f8f'], [0.75, '#5fa8a8'], [1, '#9fd0c0']]),
};

/* --------------------------------------------------------------------------
   Data layer registry — drives the globe overlay, the layer strip and legends

   `min`/`max` are the *default* colourbar range. Every layer's range (and its
   colourbar) can be changed by the user from the legend editor; `autoRange`
   marks the layers that start out auto-scaled instead.
   -------------------------------------------------------------------------- */
export const LAYERS = {
  none: { key: 'none', label: '无叠加', unit: '', min: 0, max: 1, kind: 'none' },

  temperature: {
    key: 'temperature', label: '温度', unit: '°C', min: -30, max: 40, kind: 'div',
    ramp: R.temp, dec: 1, fixedRange: true, legend: '-30 °C … +40 °C',
  },
  oxygen: {
    key: 'oxygen', label: '氧浓度', unit: '%', min: 0, max: 40, kind: 'seq',
    ramp: R.oxygen, dec: 2, fixedRange: true, legend: '0 % … 40 % 体积占比',
  },
  humidity: {
    key: 'humidity', label: '湿度', unit: '%', min: 0, max: 100, kind: 'seq',
    ramp: R.humidity, dec: 0, fixedRange: true, legend: '相对湿度 0 % … 100 %',
  },
  vegetation: {
    key: 'vegetation', label: '植被覆盖率', unit: '%', min: 0, max: 100, kind: 'seq',
    ramp: R.vegetation, dec: 0, fixedRange: true, legend: '覆盖度 0 % … 100 %',
  },
  habitability: {
    key: 'habitability', label: '宜居度', unit: '', min: 0, max: 1, kind: 'seq',
    ramp: R.habitability, dec: 2, fixedRange: true,
    legend: '人类宜居指数（仅陆地）0 … 1：温度 / 湿度 / 降水 / 植被 / 氧 / 气溶胶 / 毒性 / 河流；海洋为 0',
  },
  toxicity: {
    key: 'toxicity', label: '毒性 / 危险气体', unit: '', min: 0, max: 1, kind: 'seq',
    ramp: R.toxicity, dec: 2, fixedRange: true, legend: '危险指数 0 … 1（SO₂ / Cl₂ / CH₄ / NH₃ 加权）',
  },
  aerosol: {
    key: 'aerosol', label: '气溶胶 / 尘埃', unit: '', min: 0, max: 1, kind: 'seq',
    ramp: R.aerosol, dec: 2, fixedRange: true, legend: '大气浊度 0 … 1',
  },
  cloud: {
    key: 'cloud', label: '云量', unit: '%', min: 0, max: 100, kind: 'seq',
    ramp: R.aerosol, dec: 0, fixedRange: true, legend: '云覆盖 0 … 100 %',
  },
  diurnal: {
    key: 'diurnal', label: '昼夜温差', unit: 'K', min: 0, max: 50, kind: 'seq',
    ramp: R.diurnal, dec: 1, fixedRange: true, legend: '日温差 0 … 50 K',
  },
  seasonal: {
    key: 'seasonal', label: '季节温差', unit: 'K', min: 0, max: 100, kind: 'seq',
    ramp: R.seasonal, dec: 1, fixedRange: true, legend: '最暖月 − 最冷月 0 … 100 K（参考：地球约 5–60 K）',
  },
  precipitation: {
    key: 'precipitation', label: '降水', unit: 'mm/月', min: 0, max: 500, kind: 'seq',
    ramp: R.precip, dec: 0, fixedRange: true, legend: '0 … 500 mm/月',
  },
  precipSeason: {
    key: 'precipSeason', label: '季节降水量', unit: 'mm/年', min: 0, max: 1500, kind: 'seq',
    ramp: R.precip, dec: 0, fixedRange: true, legend: '湿月 − 干月，折算年量 0 … 1500 mm/年',
  },
  rivers: {
    key: 'rivers', label: '河流', unit: '', min: 0, max: 1, kind: 'seq',
    ramp: R.precip, dec: 2, fixedRange: true, legend: '径流量 0 … 1（细→粗）',
  },
  windSpeed: {
    key: 'windSpeed', label: '风场', unit: 'm/s', min: 0, max: 50, kind: 'seq',
    ramp: R.wind, dec: 1, fixedRange: true, vector: 'wind',
    legend: '近地面风速 0 … 50 m/s，箭头方向 = 风向（信风 / 西风 / 极地东风）',
  },
  currentSpeed: {
    key: 'currentSpeed', label: '洋流', unit: 'm/s', min: 0, max: 2.5, kind: 'seq',
    ramp: R.current, dec: 2, fixedRange: true, vector: 'current',
    legend: '表层洋流 0 … 2.5 m/s，箭头方向 = 流向（西边界流最快）',
  },
  seaIce: {
    key: 'seaIce', label: '海冰', unit: '%', min: 0, max: 100, kind: 'seq',
    ramp: R.seaIce, dec: 0, fixedRange: true, legend: '海冰密集度 0 … 100 %',
  },
  anomaly: {
    key: 'anomaly', label: '温度距平', unit: 'K', min: -12, max: 12, kind: 'div',
    ramp: R.anomaly, dec: 2, fixedRange: true, legend: '相对基准期 −12 … +12 K',
  },
};

/** Layer strip order shown under the globe. */
export const LAYER_ORDER = [
  'temperature', 'precipitation', 'precipSeason', 'humidity', 'vegetation',
  'oxygen', 'habitability', 'toxicity', 'aerosol', 'cloud', 'diurnal', 'seasonal',
  'windSpeed', 'currentSpeed', 'rivers', 'seaIce',
];

export const CHART_SERIES = [
  { key: 'tGlobal', label: '平均地表温度', unit: 'K', color: '#b8706a', dec: 2, tall: true },
  { key: 'tAnnual', label: '平均地表温度（12 月滑动平均）', unit: 'K', color: '#c9a878', dec: 2, tall: true },
  { key: 'co2', label: 'CO₂ 浓度', unit: 'ppm', color: '#8f97a6', dec: 1 },
  { key: 'seaLevel', label: '海平面', unit: 'm', color: '#6b8fae', dec: 1 },
  { key: 'iceArea', label: '冰盖面积', unit: '%', color: '#9fb4c4', dec: 1 },
  { key: 'energy', label: '能量收支（净）', unit: 'W/m²', color: '#a89a6e', dec: 3, tall: true },
  { key: 'biomass', label: '生物量（相对地球）', unit: '', color: '#7d9c76', dec: 3 },
];
