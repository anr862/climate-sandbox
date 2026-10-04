/**
 * Right data panel: live metric cards with sparklines, linked time-series
 * charts, probe read-out and the derived condition list.
 */

import { state } from '../state/state.js';
import { SERIES_DEFS, GLOBAL_SCOPE } from '../sim/series.js';
import { on, emit } from '../core/bus.js';
import { el } from './widgets.js';
import { drawSeries, drawSpark, niceRange, hexToRgba, nearestIndex } from '../render/charts.js';
import { tempFromK, tempUnit, tempDeltaFromK, fmtTime, fmtPressure } from '../core/units.js';
import { effectiveTau, BASE } from '../physics/climate.js';

const CARD_DEFS = [
  // Both temperatures are shown: the instantaneous one carries the seasonal
  // cycle (~4 K peak-to-peak globally), the 12-month mean is the steady state a
  // climate read-out should be judged by.
  { key: 'tGlobal', label: '平均地表温度', series: 'tGlobal', color: '#b8706a', kind: 'temp' },
  { key: 'tAnnual', label: '平均地表温度（12 月均值）', series: 'tAnnual', color: '#c9a878', kind: 'temp' },
  { key: 'co2', label: 'CO₂ 浓度', series: 'co2', color: '#8f97a6', kind: 'ppm' },
  { key: 'seaLevel', label: '海平面', series: 'seaLevel', color: '#6b8fae', kind: 'level' },
  { key: 'iceArea', label: '冰盖面积', series: 'iceArea', color: '#9fb4c4', kind: 'pct' },
  { key: 'energy', label: '能量收支（净）', series: 'energy', color: '#a89a6e', kind: 'flux' },
  { key: 'biomass', label: '生物量（相对地球）', series: 'biomass', color: '#7d9c76', kind: 'bio' },
];

export class DataPanel {
  constructor(opts) {
    this.host = opts.charts;
    this.metricGrid = opts.metricGrid;
    this.probeBody = opts.probeBody;
    this.probeCard = opts.probeCard;
    this.condList = opts.condList;
    this.scopeLabel = opts.scopeLabel;
    this.getWorld = opts.getWorld;
    this.cards = new Map();
    this.chartNodes = new Map();
    this.lastDraw = 0;
    this.dirty = true;
    this.build();
    on('sim:step', () => { this.dirty = true; });
    on('time:scrub', () => { this.dirty = true; });
    on('region:change', () => { this.dirty = true; });
    on('scene:apply', () => { this.dirty = true; this.draw(true); });
    on('state:meta', () => { this.dirty = true; });
    on('units:change', () => { this.dirty = true; this.draw(true); });
    on('probe:add', (probe) => this.showProbe(probe));
  }

  build() {
    /* metric cards */
    this.metricGrid.textContent = '';
    for (const def of CARD_DEFS) {
      const value = el('span', { class: 'm-value' });
      const sub = el('span', { class: 'm-sub' });
      const canvas = el('canvas', { class: 'm-spark' });
      const label = el('span', { text: def.label });
      const delta = el('span', { class: 'mono' });
      const card = el('div', { class: 'metric' }, [
        el('div', { class: 'm-label' }, [label, delta]),
        el('div', {}, [value, sub]),
        canvas,
      ]);
      this.metricGrid.append(card);
      this.cards.set(def.key, { card, value, sub, canvas, delta, def });
    }

    /* charts */
    this.host.textContent = '';
    for (const def of SERIES_DEFS) {
      if (def.secondary) continue;
      const canvas = el('canvas', { class: 'chart-canvas' });
      const val = el('span', { class: 'chart-val' });
      const title = el('span', { class: 'chart-title', text: def.label });
      const card = el('div', { class: 'chart-card' + (def.tall ? ' tall' : '') }, [
        el('div', { class: 'chart-head' }, [title, val]),
        canvas,
      ]);
      canvas.addEventListener('click', (e) => {
        const rect = canvas.getBoundingClientRect();
        const frac = (e.clientX - rect.left) / rect.width;
        const series = this.currentSeries();
        if (!series || !series.months.length) return;
        const month = series.months[0] + frac * (series.months[series.months.length - 1] - series.months[0]);
        emit('chart:seek', month);
      });
      this.host.append(card);
      this.chartNodes.set(def.key, { card, canvas, val, def });
    }
  }

  currentSeries() {
    const world = this.getWorld();
    return world ? world.series : null;
  }

  currentScope() {
    return state.ui.region ? scopeIdFor(state.ui.region) : GLOBAL_SCOPE;
  }

  /* ---------------- probe read-out ---------------- */

  showProbe(probe) {
    const world = this.getWorld();
    if (!world) return;
    const p = world.probe(probe.lat, probe.lon, probe.radiusDeg || 6);
    const sys = state.unitSystem;
    const rows = [
      ['坐标', `${Math.abs(probe.lat).toFixed(1)}°${probe.lat >= 0 ? 'N' : 'S'} ${Math.abs(probe.lon).toFixed(1)}°${probe.lon >= 0 ? 'E' : 'W'}`],
      ['区域半径', `${(probe.radiusDeg || 6).toFixed(0)}°`],
      ['地表温度', `${tempFromK(p.tempK, sys).toFixed(2)} ${tempUnit(sys)}`],
      ['地貌类型', p.biome.label],
      ['海陆', p.ocean ? `海洋（占比 ${(p.oceanFraction * 100).toFixed(0)}%）` : '陆地'],
      ['高程', `${Math.round(p.elevation).toLocaleString('en-US')} m`],
      ['月降水', `${p.precip.toFixed(1)} mm`],
      ['相对湿度', `${p.humidity.toFixed(0)} %`],
      ['植被覆盖', `${(p.vegetation * 100).toFixed(0)} %`],
      ['昼夜温差', `${p.diurnal.toFixed(1)} K`],
      ['有毒气体指数', p.toxicity.toFixed(2)],
      ['大气浊度', p.aerosol.toFixed(2)],
      ['宜居指数', p.habitability.toFixed(2)],
      ['吸收短波', `${p.absorbed.toFixed(0)} W/m²`],
    ];
    this.probeBody.innerHTML = '';
    const dl = el('dl', { class: 'kv' });
    for (const [k, v] of rows) {
      dl.append(el('dt', { text: k }), el('dd', { text: v }));
    }
    this.probeBody.append(dl);
    this.probeCard.classList.add('active');
    this.dirty = true;
  }

  clearProbe() {
    this.probeCard.classList.remove('active');
    this.probeBody.innerHTML = '<p class="muted tiny">在中央星球上点击任意位置，读取该点局部气候并联动曲线。</p>';
  }

  /* ---------------- draw ---------------- */

  draw(force) {
    const world = this.getWorld();
    if (!world) return;
    const now = performance.now();
    if (force) { this.lastDraw = now; this.dirty = false; }
    else {
      if (!this.dirty) return;
      if (now - this.lastDraw < 90) return;
      this.lastDraw = now;
      this.dirty = false;
    }

    const series = world.series;
    const scope = this.currentScope();
    const scopeObj = series.scopes.get(scope) || series.scopes.get(GLOBAL_SCOPE);
    const global = series.scopes.get(GLOBAL_SCOPE);
    const isRegion = scope !== GLOBAL_SCOPE;
    this.scopeLabel.textContent = isRegion && scopeObj.meta
      ? `${scopeObj.meta.lat.toFixed(1)}°, ${scopeObj.meta.lon.toFixed(1)}° · 半径 ${scopeObj.meta.radiusDeg}°`
      : '全球平均';

    const sys = state.unitSystem;
    const month = world.time.month;
    const idx = state.ui.scrubIndex >= 0 ? state.ui.scrubIndex : series.length() - 1;
    const shownMonth = state.ui.scrubIndex >= 0 ? series.months[idx] : month;

    /* metric cards */
    for (const [key, node] of this.cards) {
      const def = node.def;
      const arr = scopeObj[def.series] || global[def.series];
      const raw = arr && arr[idx] !== undefined ? arr[idx] : NaN;
      const base = global[def.series] && global[def.series][0];
      let text = '—', sub = '', deltaText = '', deltaClass = '';
      switch (def.kind) {
        case 'temp': {
          const t = tempFromK(raw, sys);
          text = isFinite(t) ? t.toFixed(2) : '—';
          sub = ` ${tempUnit(sys)}`;
          const d = tempDeltaFromK(raw - 288, sys);
          if (isFinite(d)) { deltaText = `${d >= 0 ? '+' : ''}${d.toFixed(2)}`; deltaClass = d >= 0 ? 'delta-up' : 'delta-down'; }
          break;
        }
        case 'ppm': text = isFinite(raw) ? raw.toFixed(0) : '—'; sub = ' ppm'; break;
        case 'level': text = isFinite(raw) ? raw.toFixed(1) : '—'; sub = ' m'; break;
        case 'pct': text = isFinite(raw) ? raw.toFixed(1) : '—'; sub = ' %'; break;
        case 'flux': {
          text = isFinite(raw) ? raw.toFixed(3) : '—'; sub = ' W/m²';
          const d = raw - base;
          if (isFinite(d)) { deltaText = `${d >= 0 ? '+' : ''}${d.toFixed(2)}`; deltaClass = d >= 0 ? 'delta-up' : 'delta-down'; }
          break;
        }
        case 'bio': text = isFinite(raw) ? raw.toFixed(3) : '—'; break;
        default: text = isFinite(raw) ? raw.toFixed(2) : '—';
      }
      node.value.textContent = text;
      node.value.append(el('small', { text: sub }));
      node.sub.textContent = isFinite(raw) ? `#${idx} · ${fmtTime(shownMonth)}` : '无数据';
      node.delta.textContent = deltaText;
      node.delta.className = 'mono ' + deltaClass;
      drawSpark(node.canvas, arr, def.color);
    }

    /* charts */
    for (const [key, node] of this.chartNodes) {
      const def = node.def;
      const gvals = (global[def.key] || []).map((v) => v);
      const rvals = isRegion ? (scopeObj[def.key] || []) : null;
      const primary = isRegion ? rvals : gvals;
      const ranges = [];
      for (const arr of [primary, isRegion ? gvals : null]) {
        if (!arr) continue;
        for (const v of arr) if (isFinite(v)) ranges.push(v);
      }
      const range = niceRange(Math.min(...ranges), Math.max(...ranges), 0.12);
      const seriesList = [];
      if (isRegion) {
        seriesList.push({ values: gvals, color: hexToRgba(def.color, 0.35), width: 1, dash: [3, 3] });
        seriesList.push({ values: rvals, color: def.color, width: 1.5, fill: hexToRgba(def.color, 0.14) });
      } else {
        seriesList.push({ values: gvals, color: def.color, width: 1.5, fill: hexToRgba(def.color, 0.14) });
      }
      const cur = primary && primary[idx];
      node.val.textContent = isFinite(cur) ? `${formatSeries(def, cur)} ${def.unit}`.trim() : '—';
      drawSeries(node.canvas, {
        series: seriesList,
        months: series.months,
        lo: range.lo,
        hi: range.hi,
        cursorMonth: state.ui.scrubIndex >= 0 ? series.months[idx] : null,
        markerMonth: series.months[idx],
        format: (v) => fmtNum(def, v),
        timeLabel: fmtTime(series.months[series.months.length - 1] || 0),
      });
    }

    /* condition list */
    this.drawConditions(world, series, idx);
  }

  drawConditions(world, series, idx) {
    const p = state.params;
    const m = world.metrics();
    const sys = state.unitSystem;
    const tau = effectiveTau(p, world.tGlobal);
    const gh = (1 - tau) * 100;
    const rows = [
      ['行星反照率', world.albedoGlobal.toFixed(4)],
      ['等效透射率 τ', tau.toFixed(4)],
      ['温室强度 (1−τ)', `${gh.toFixed(1)} %`],
      ['参考 τ（地球）', BASE.tauRef.toFixed(4)],
      ['吸收短波', `${world.absorbedGlobal.toFixed(2)} W/m²`],
      ['长波逸出 OLR', `${world.olrGlobal.toFixed(2)} W/m²`],
      ['净辐射收支（瞬时）', `${world.energyNet.toFixed(3)} W/m²`],
      ['海洋面积占比', `${(world.oceanFraction * 100).toFixed(2)} %`],
      ['陆冰体积', `${world.iceVolumeEarth.toFixed(2)} × 地球`],
      ['海冰体积', `${(world.seaIceVolumeEarth || 0).toFixed(2)} × 地球`],
      ['海平面变化', `${world.seaLevelDelta.toFixed(2)} m`],
      ['平均降水', `${m.precip.toFixed(2)} mm/月`],
      ['地表气压', fmtPressure(p.pressure)],
      ['干空气合计', `${(p.o2 + p.n2 + p.co2 / 1e4 + p.otherGas).toFixed(2)} %`],
      ['模拟步长', `${p.stepMonths} 月`],
      ['已模拟时长', fmtTime(world.time.month)],
      ['月份计数', `${world.time.month.toFixed(0)}`],
      ['采样点', `${series.length()}`],
    ];
    // closed-loop diagnostics: fields that are predicted by the model and then
    // feed back into the energy budget
    const g = world.grid;
    const cloudMean = averageOf(g.cloudCover) * 100;
    const dustMean = averageOf(g.aerosol);
    rows.splice(7, 0,
      ['云量（反馈）', `${cloudMean.toFixed(1)} %`],
      ['气溶胶浊度（反馈）', dustMean.toFixed(3)],
      ['风速均值', `${(world.windSpeedMean || 0).toFixed(2)} m/s`],
      ['洋流流速均值', `${(world.currentSpeedMean || 0).toFixed(3)} m/s`]);
    // habitability is a land index, so report it over land only
    {
      let habSum = 0, landW = 0, goodW = 0;
      for (let j = 0; j < g.NB; j++) {
        for (let i = 0; i < g.NL; i++) {
          const k = i + j * g.NL;
          if (g.ocean[k] > 0.5) continue;
          const w = g.areaFrac[j] / NLc(g);
          landW += w;
          habSum += g.habitability[k] * w;
          if (g.habitability[k] > 0.5) goodW += w;
        }
      }
      rows.splice(9, 0,
        ['陆地宜居度均值', landW > 0 ? (habSum / landW).toFixed(3) : '—'],
        ['宜居陆地占比', landW > 0 ? `${((goodW / landW) * 100).toFixed(1)} %` : '—']);
    }
    if (p.meteorEnabled) {
      const imp = world.impact;
      const total = (p.meteorMass || 0) * Math.max(1, p.meteorCount || 1);
      const diameter = 2 * Math.cbrt((3 * (p.meteorMass || 0)) / (4 * Math.PI * 3000)) / 1000;
      rows.push(['陨石计划', `${p.meteorCount} 颗 × ${fmtMass(p.meteorMass)} kg（±${(p.meteorMassSigma * 100).toFixed(0)}%）`]);
      rows.push(['等效直径', `${diameter < 1 ? (diameter * 1000).toFixed(0) + ' m' : diameter.toFixed(2) + ' km'}（密度 3000 kg/m³）`]);
      rows.push(['总质量', `${fmtMass(total)} kg`]);
      if (imp) {
        rows.push(['已发生撞击', fmtTime(imp.month)]);
        rows.push(['撞击点', `${Math.abs(imp.site.lat).toFixed(1)}°${imp.site.lat >= 0 ? 'N' : 'S'} ${Math.abs(imp.site.lon).toFixed(1)}°${imp.site.lon >= 0 ? 'E' : 'W'}`]);
        rows.push(['影响范围', `≈ ${Math.round(imp.blastKm ?? 0).toLocaleString('en-US')} km 半径`]);
        rows.push(['尘埃负荷（当前）', (world.impactDust || 0).toFixed(3)]);
        rows.push(['火球热脉冲', `${imp.heat.toFixed(1)} K`]);
      } else {
        rows.push(['撞击时间点', `${p.meteorMonth} 月（第 ${(p.meteorMonth / 12).toFixed(1)} 年）`]);
      }
    }
    this.condList.textContent = '';
    for (const [k, v] of rows) {
      this.condList.append(el('dt', { text: k }), el('dd', { text: v }));
    }
  }
}

export function scopeIdFor(region) {
  return `r:${region.lat.toFixed(1)},${region.lon.toFixed(1)},${(region.radiusDeg || 6).toFixed(1)}`;
}

function averageOf(arr) {
  if (!arr || !arr.length) return 0;
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s / arr.length;
}

/** Longitude count of the climate grid (used for land-only area weights). */
function NLc(grid) { return grid.NL || 1; }

function fmtMass(kg) {
  if (!isFinite(kg)) return '—';
  if (kg >= 1e12) return `${(kg / 1e12).toFixed(2)}e12`;
  if (kg >= 1e6) return `${(kg / 1e6).toFixed(1)}e6`;
  return kg.toExponential(2);
}

function formatSeries(def, v) {
  const d = def.dec ?? 2;
  if (Math.abs(v) >= 1e5) return v.toExponential(2);
  return v.toFixed(d);
}

function fmtNum(def, v) {
  const d = Math.max(0, (def.dec ?? 2) - 1);
  if (Math.abs(v) >= 1e5) return v.toExponential(1);
  return v.toFixed(d);
}
