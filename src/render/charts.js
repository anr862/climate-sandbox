/**
 * Canvas 2D chart primitives. No charting dependency: each chart is a small
 * "sparkline with axes" that the data panel stacks vertically, plus a scrub
 * marker and region-vs-global comparison.
 */

export const GRID = '#1b232c';
export const AXIS = '#2a3644';
export const LABEL = '#7c8b9c';
export const LABEL_DIM = '#5b6875';

export function fitCanvas(canvas) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(2, Math.floor(canvas.clientWidth * dpr));
  const h = Math.max(2, Math.floor(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: canvas.clientWidth, h: canvas.clientHeight };
}

export function niceRange(lo, hi, pad = 0.08) {
  if (!isFinite(lo) || !isFinite(hi)) return { lo: 0, hi: 1 };
  if (hi - lo < 1e-9) { hi = lo + Math.max(1e-6, Math.abs(lo) * 0.02 + 1e-6); }
  const span = hi - lo;
  return { lo: lo - span * pad, hi: hi + span * pad };
}

/**
 * Draw a series chart.
 * @param {HTMLCanvasElement} canvas
 * @param {object} o { series: [{values, color, width, dash}], months, lo, hi, cursorIndex,
 *                     markerIndex, format, yTicks }
 */
export function drawSeries(canvas, o) {
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);

  const padL = 4, padR = 4, padT = 5, padB = 12;
  const plotW = Math.max(1, w - padL - padR);
  const plotH = Math.max(1, h - padT - padB);
  const { lo, hi } = o;
  const n = o.months.length;
  const monthLo = n ? o.months[0] : 0;
  const monthHi = n ? o.months[n - 1] : 1;
  const spanM = Math.max(1e-6, monthHi - monthLo);

  const xOf = (m) => padL + (m - monthLo) / spanM * plotW;
  const yOf = (v) => padT + plotH - (v - lo) / Math.max(1e-9, hi - lo) * plotH;

  // horizontal reference lines
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  for (let k = 0; k <= 2; k++) {
    const y = Math.round(padT + (plotH * k) / 2) + 0.5;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
  }

  // x tick marks every ~5 subdivisions
  const ticks = 4;
  ctx.strokeStyle = '#151c24';
  for (let k = 1; k < ticks; k++) {
    const x = Math.round(padL + (plotW * k) / ticks) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.stroke();
  }

  // series
  for (const s of o.series) {
    const vals = s.values;
    if (!vals || !vals.length) continue;
    ctx.beginPath();
    ctx.lineWidth = s.width || 1.4;
    ctx.strokeStyle = s.color;
    if (s.dash) ctx.setLineDash(s.dash); else ctx.setLineDash([]);
    ctx.lineJoin = 'round';
    let started = false;
    const step = Math.max(1, Math.floor(n / 900));
    for (let i = 0; i < n; i += step) {
      const v = vals[i];
      if (!isFinite(v)) { started = false; continue; }
      const x = xOf(o.months[i]);
      const y = yOf(v);
      if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // area fill for the first (primary) series
    if (s.fill) {
      ctx.save();
      ctx.lineTo(xOf(o.months[n - 1]), padT + plotH);
      ctx.lineTo(xOf(o.months[0]), padT + plotH);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
      grad.addColorStop(0, s.fill);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.restore();
    }
  }

  // scrub cursor
  if (o.cursorMonth !== undefined && o.cursorMonth !== null && n) {
    const x = Math.round(xOf(o.cursorMonth)) + 0.5;
    ctx.strokeStyle = '#93a7bb';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // marker (current value dot)
  if (o.markerMonth !== undefined && o.markerMonth !== null && o.series[0]) {
    const vals = o.series[0].values;
    const idx = nearestIndex(o.months, o.markerMonth);
    if (idx >= 0 && isFinite(vals[idx])) {
      ctx.fillStyle = o.series[0].color;
      ctx.beginPath();
      ctx.arc(xOf(o.months[idx]), yOf(vals[idx]), 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // axis labels
  ctx.fillStyle = LABEL_DIM;
  ctx.font = '9px ui-monospace, monospace';
  ctx.textBaseline = 'top';
  if (o.format) {
    ctx.textAlign = 'left';
    ctx.fillText(o.format(hi), padL, 0);
    ctx.textAlign = 'left';
    ctx.fillText(o.format(lo), padL, padT + plotH + 1);
  }
  if (o.timeLabel) {
    ctx.textAlign = 'right';
    ctx.fillText(o.timeLabel, w - padR, padT + plotH + 1);
  }
}

export function nearestIndex(months, target) {
  const n = months.length;
  if (!n) return -1;
  if (target <= months[0]) return 0;
  if (target >= months[n - 1]) return n - 1;
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (months[mid] < target) lo = mid + 1; else hi = mid;
  }
  return months[lo] - target > target - months[lo - 1] ? lo - 1 : lo;
}

/** Tiny sparkline used inside metric cards. */
export function drawSpark(canvas, values, color) {
  const { ctx, w, h } = fitCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  if (!values || values.length < 2) return;
  let lo = Infinity, hi = -Infinity;
  const step = Math.max(1, Math.floor(values.length / 160));
  for (let i = 0; i < values.length; i += step) {
    const v = values[i];
    if (!isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!isFinite(lo)) return;
  if (hi - lo < 1e-9) { hi = lo + 1e-6; }
  const xOf = (i) => (i / (values.length - 1)) * (w - 2) + 1;
  const yOf = (v) => h - 2 - ((v - lo) / (hi - lo)) * (h - 4);
  ctx.beginPath();
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = color;
  let started = false;
  for (let i = 0; i < values.length; i += step) {
    const v = values[i];
    if (!isFinite(v)) { started = false; continue; }
    if (!started) { ctx.moveTo(xOf(i), yOf(v)); started = true; } else ctx.lineTo(xOf(i), yOf(v));
  }
  ctx.stroke();
  ctx.lineTo(xOf(values.length - 1), h);
  ctx.lineTo(xOf(0), h);
  ctx.closePath();
  ctx.fillStyle = hexToRgba(color, 0.10);
  ctx.fill();
}

export function hexToRgba(hex, a) {
  const s = hex.replace('#', '');
  const r = parseInt(s.slice(0, 2), 16);
  const g = parseInt(s.slice(2, 4), 16);
  const b = parseInt(s.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
