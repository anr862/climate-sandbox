/**
 * Minimal event bus. Keeps the globe / charts / panels decoupled.
 *
 * Events in use:
 *   'planet:new'      (planet)            a brand new planet was created
 *   'planet:terrain'  (planet)            heightfield changed, textures need rebuild
 *   'state:param'     ({key,value})       a parameter changed
 *   'state:meta'      ()                  lock / unit / preset metadata changed
 *   'sim:step'        (snapshot)          one or more months advanced
 *   'sim:reset'       (planet)            simulation clock was reset
 *   'sim:playing'     (bool)
 *   'time:scrub'      ({index, snap})     user is reviewing history
 *   'region:change'   (region|null)
 *   'layer:change'    ({overlay,base})
 *   'undo:change'     ({canUndo,canRedo})
 *   'branch:change'   (branches)
 *   'legend:change'   ({key})             colourbar ramp / range edited
 *   'impact'          (impact)            a meteor shower just landed
 *   'toast'           (message)
 */

const map = new Map();

export function on(evt, fn) {
  if (!map.has(evt)) map.set(evt, new Set());
  map.get(evt).add(fn);
  return () => off(evt, fn);
}

export function off(evt, fn) {
  const set = map.get(evt);
  if (set) set.delete(fn);
}

export function emit(evt, payload) {
  const set = map.get(evt);
  if (!set) return;
  for (const fn of Array.from(set)) {
    try { fn(payload); } catch (err) { console.error(`[bus] handler for "${evt}" failed`, err); }
  }
}
