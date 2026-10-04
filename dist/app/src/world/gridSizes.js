/**
 * Terrain / climate grid resolutions.
 *
 * Kept in its own module so both the world builder and the UI can import it
 * without pulling in the physics layer.
 *
 * The terrain grid is always 2:1 (equirectangular), so a requested *total cell
 * count* maps to width = 2·height. The climate solver runs on a coarser grid
 * derived from the terrain resolution, capped because its cost is O(NB·NL) per
 * sub-step and it is re-run 2-24 times per simulated month.
 */

export const GRID_PRESETS = [
  { gx: 180, gy: 90, label: '180 × 90 · 低精度（1.6 万格）' },
  { gx: 360, gy: 180, label: '360 × 180 · 标准（6.5 万格）' },
  { gx: 540, gy: 270, label: '540 × 270 · 高精度（14.6 万格）' },
  { gx: 720, gy: 360, label: '720 × 360 · 精细（25.9 万格）' },
  { gx: 1080, gy: 540, label: '1080 × 540 · 超精细（58.3 万格）' },
  { gx: 1440, gy: 720, label: '1440 × 720 · 极限（103.7 万格）' },
];

export const GRID_MIN = 16200;      // 180 × 90
export const GRID_MAX = 1036800;    // 1440 × 720
export const GRID_STEP = 900;

/** Total cell count -> 2:1 grid dimensions, snapped to even numbers. */
export function gridDimsFor(count) {
  const target = Math.max(2, Number(count) || GRID_MIN);
  let gy = Math.max(2, Math.round(Math.sqrt(target / 2)));
  // keep the aspect exactly 2:1 and both dimensions even (nicer for binning)
  if (gy % 2) gy += 1;
  const gx = gy * 2;
  return { gx, gy, count: gx * gy };
}

/** Climate solver resolution for a terrain resolution. */
export function climateSizeFor(gx, gy) {
  const nb = Math.max(24, Math.min(96, Math.round(gy / 3.75)));
  const nl = Math.max(48, Math.min(192, Math.round(gx / 3.75)));
  return { NB: nb, NL: nl };
}

export function nearestPreset(count) {
  let best = GRID_PRESETS[1], bestD = Infinity;
  for (const p of GRID_PRESETS) {
    const d = Math.abs(p.gx * p.gy - count);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

/** Rough cost hint shown in the pickers. */
export function gridCostHint(count) {
  if (count <= 40000) return '很快：地形与气候都会即时更新。';
  if (count <= 90000) return '默认档：交互流畅，推荐日常使用。';
  if (count <= 300000) return '较高：绘制笔刷与气候图层会有轻微延迟。';
  if (count <= 600000) return '很高：绘制时预览会自动降采样以保持响应。';
  return '极限：生成需要数秒，绘制与图层刷新会明显变慢。';
}
