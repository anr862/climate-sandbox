/**
 * View-preset check — node scripts/view-check.mjs
 *
 * "赤道 / 北极 / 南极" must put the equator region / the north pole point / the
 * south pole point in the *centre of the screen*. The projection is pure maths on
 * `rot` + the MVP matrix, so it can be verified here without WebGL: a stub object
 * with GlobeView's prototype gives us the real `project()`.
 */
import { GlobeView } from '../src/render/globe.js';

const W = 800, H = 400;
function stub(aspect = W / H) {
  const g = Object.create(GlobeView.prototype);
  g.ok = true;
  g.rot = { yaw: 0, pitch: 0, dist: 3.0 };
  g.aspect = aspect;
  g.canvas = { getBoundingClientRect: () => ({ width: W, height: H, left: 0, top: 0 }) };
  return g;
}

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + JSON.stringify(detail) : ''}`);
}
const off = (p) => ({ dx: +(p.x - W / 2).toFixed(2), dy: +(p.y - H / 2).toFixed(2) });
const dist = (p) => Math.hypot(p.x - W / 2, p.y - H / 2);

for (const lon of [0, 30, 90, -120, 179]) {
  const g = stub();
  g.setViewPreset('equator', lon);
  const centre = g.project(0, lon);
  const north = g.project(40, lon);
  const south = g.project(-40, lon);
  check(`equator preset centres the equator at ${lon}°E`, !!centre && dist(centre) < 2.0, centre && off(centre));
  check(`  …and keeps north up at ${lon}°E`, north.y < centre.y && south.y > centre.y,
    { north: +north.y.toFixed(1), centre: +centre.y.toFixed(1), south: +south.y.toFixed(1) });
}

for (const lon of [0, 90, -60]) {
  const g = stub();
  g.setViewPreset('northPole', lon);
  const p = g.project(90, lon);
  check(`northPole preset centres the pole (lon ${lon})`, !!p && dist(p) < 2.0, p && off(p));
  check(`  …and the pole faces the camera (lon ${lon})`, !!p && p.facing !== false, { facing: p && p.facing });

  const g2 = stub();
  g2.setViewPreset('southPole', lon);
  const p2 = g2.project(-90, lon);
  check(`southPole preset centres the pole (lon ${lon})`, !!p2 && dist(p2) < 2.0, p2 && off(p2));
}

// the pole view must show the whole hemisphere, not a sliver at the screen edge
{
  const g = stub();
  g.setViewPreset('northPole', 0);
  const a = g.project(45, 0), b = g.project(45, 90), c = g.project(45, 180);
  const onScreen = [a, b, c].filter((p) => p && p.x > 0 && p.x < W && p.y > 0 && p.y < H).length;
  check('polar view keeps a mid-latitude ring on screen', onScreen === 3, { onScreen });
}

// a portrait viewport must still centre the presets
{
  const g = stub(0.75);
  g.setViewPreset('equator', 0);
  check('equator preset centres on a portrait viewport', dist(g.project(0, 0)) < 2.0, off(g.project(0, 0)));
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall view-preset checks passed');
process.exit(failures ? 1 : 0);
