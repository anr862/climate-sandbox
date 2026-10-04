/**
 * Simulation clock: play/pause, speed presets, history scrubbing and the
 * "what if" branch helpers. The clock owns no physics — it drives a World.
 */

import { state } from '../state/state.js';
import { emit, on } from '../core/bus.js';
import { fmtTime, fmtDuration } from '../core/units.js';

export const SPEEDS = [0.25, 1, 5, 25];

export class Clock {
  constructor(opts = {}) {
    this.getWorld = opts.getWorld;
    this.speeds = SPEEDS;
    this.playing = false;
    this.speed = 1;                 // sim years per real second
    this.accumulator = 0;
    this.lastTick = 0;
    this.scrubIndex = -1;
    this.onStep = opts.onStep || (() => {});
    this.raf = null;
    this.lastMonthAdvanced = 0;
  }

  setPlaying(play) {
    this.playing = !!play;
    if (this.playing) this.lastTick = performance.now();
    emit('sim:playing', this.playing);
  }

  toggle() { this.setPlaying(!this.playing); }

  setSpeed(yearsPerSecond) {
    this.speed = Math.max(0.01, Math.min(200, yearsPerSecond));
    emit('sim:playing', this.playing);
  }

  /**
   * Fractional months to advance this frame.
   * `dtMs` is real elapsed time; the mapping is years-per-second of sim time.
   */
  monthsForFrame(dtMs) {
    return (dtMs / 1000) * this.speed * 12;
  }

  /**
   * Advance the world, splitting the advance into whole-month steps (the
   * documented minimum step) so the series always samples at month resolution.
   */
  advance(world, months) {
    // Step one month at a time so the time series keeps month resolution even
    // when the user picks a coarser *sampling* step, but batch the very
    // expensive visual texture rebuilds to the end of the call. A cap on the
    // total months per frame keeps the UI responsive at high speeds.
    const chunk = Math.max(1, Math.round(state.params.stepMonths || 1));
    const maxMonths = Math.max(chunk * 4, Math.min(months, 96));
    let remaining = Math.min(months, maxMonths);
    let stepped = 0;
    while (remaining > 0) {
      const take = Math.min(chunk, remaining);
      for (let m = 0; m < take; m++) world.step(1, state.ui.regionScope || null);
      remaining -= take;
      stepped += take;
    }
    if (stepped > 0) {
      world.refreshFields();
      world.sampleSeries(state.ui.regionScope || null);
      world.checkpoint(false);
      this.postStep(world, stepped);
    }
    return stepped;
  }

  postStep(world, step) {
    this.lastMonthAdvanced = world.time.month;
    // parameter -> derived couplings that must track the simulation
    const total = state.params.totalMonths;
    if (total > 0 && world.time.month >= total && state.params.autoStop && this.playing) {
      this.setPlaying(false);
      emit('sim:complete', { month: world.time.month });
      emit('toast', `模拟已达到设定总时长 ${fmtDuration(total)}，已自动暂停`);
    }
    emit('sim:step', { month: world.time.month, step });
  }

  postStepOnce(world, step) { this.postStep(world, step); }

  /** Move the world back/forward to a checkpoint near `month` (history replay). */
  seek(world, month) {
    const target = Math.max(0, month);
    if (Math.abs(target - world.time.month) < 0.5) return;
    const point = world.history.nearest(target);
    if (!point) {
      emit('toast', '超出已记录的历史范围（可从分支或存档重新开始）');
      return;
    }
    world.restore(point);
    // replay forward to the requested month from the nearest checkpoint
    let guard = 20000;
    while (world.time.month < target - 0.5 && guard-- > 0) {
      const step = Math.min(Math.max(1, state.params.stepMonths || 1), target - world.time.month);
      world.step(step);
    }
    emit('sim:reset', world);
    emit('sim:step', { month: world.time.month, step: 0 });
  }

  setScrub(index) {
    this.scrubIndex = index;
    state.ui.scrubIndex = index;
    emit('time:scrub', { index });
  }

  clearScrub() {
    this.scrubIndex = -1;
    state.ui.scrubIndex = -1;
    emit('time:scrub', { index: -1 });
  }

  statusLabel(world) {
    const total = state.params.totalMonths;
    const rate = this.playing ? `${this.speed}× (${(this.speed * 12).toFixed(0)} 月/秒)` : '暂停';
    const span = total > 0 ? ` / 共 ${fmtDuration(total)}` : ' / 不限时长';
    return `${fmtTime(world.time.month)} · ${rate}${span}`;
  }
}

/** Remember the current scrub state so the top bar can render it. */
export function attachClockBus(clock) {
  on('chart:seek', ({ month }) => {
    const world = clock.getWorld();
    if (!world) return;
    const idx = world.series.indexForMonth(month);
    if (idx < 0) return;
    clock.setScrub(idx);
  });
}

export { fmtTime, fmtDuration };
