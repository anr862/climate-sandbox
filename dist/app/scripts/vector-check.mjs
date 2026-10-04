/**
 * Vector-overlay direction check — node scripts/vector-check.mjs
 *
 * The wind / current arrows are drawn on a 2D overlay, and the one thing that is
 * easy to get wrong (and impossible to see in a unit test of the shader) is the
 * *sign convention*: an eastward wind must point right on the map, a northward
 * current must point up. This drives the real drawing code with a stub 2D context
 * and asserts the arrow headings, so the convention is verified without a browser.
 */
import { drawFlowField, flowOffset } from '../src/render/overlay2d.js';

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + JSON.stringify(detail) : ''}`);
}

/** Collect the arrows the renderer would draw. */
function capture(sample, project, screenToGeo, opts = {}) {
  const arrows = [];
  let current = null;
  const ctx = {
    strokeStyle: '', fillStyle: '', lineWidth: 0,
    beginPath() {}, moveTo(x, y) { current = { points: [[x, y]], fill: false }; },
    lineTo(x, y) { if (current) current.points.push([x, y]); },
    closePath() {},
    stroke() { if (current) arrows.push({ ...current, fill: false }); },
    fill() { if (current) arrows.push({ ...current, fill: true }); current = null; },
    ellipse() {}, arc() {}, save() {}, restore() {}, clearRect() {},
  };
  drawFlowField(ctx, {
    width: opts.width ?? 200, height: opts.height ?? 120, step: opts.step ?? 40,
    sample, project, screenToGeo,
    geoToOffset: (lat, lon, u, v) => flowOffset(lat, lon, u, v, 0.35),
    ramp: () => [200, 210, 220],
    range: { min: 0, max: opts.max ?? 10 },
    alpha: 1,
  });
  // the shaft is the first stroke; take its two endpoints
  const shafts = arrows.filter((a) => a.points.length === 2 && !a.fill);
  return shafts.map((a) => {
    const [[x0, y0], [x1, y1]] = a.points;
    return { dx: x1 - x0, dy: y1 - y0, len: Math.hypot(x1 - x0, y1 - y0) };
  });
}

/* --- flat map: identity projection, so screen axes match lon/lat ---------- */
const flatProject = (lat, lon) => ({ x: (lon + 180) / 360 * 200, y: (90 - lat) / 180 * 120, facing: true });
const flatGeo = (x) => ({ lat: 0, lon: x / 200 * 360 - 180 });

const east = capture(() => ({ u: 8, v: 0, speed: 8 }), flatProject, flatGeo);
check('eastward flow points right (+x)', east.length > 0 && east.every((a) => a.dx > 0 && Math.abs(a.dy) < 1e-6),
  { arrows: east.length, first: east[0] });

const north = capture(() => ({ u: 0, v: 8, speed: 8 }), flatProject, flatGeo);
check('northward flow points up (-y on screen)', north.length > 0 && north.every((a) => a.dy < 0 && Math.abs(a.dx) < 1e-6),
  { arrows: north.length, first: north[0] });

const west = capture(() => ({ u: -8, v: 0, speed: 8 }), flatProject, flatGeo);
check('westward flow points left (-x)', west.length > 0 && west.every((a) => a.dx < 0), { first: west[0] });

const south = capture(() => ({ u: 0, v: -8, speed: 8 }), flatProject, flatGeo);
check('southward flow points down (+y)', south.length > 0 && south.every((a) => a.dy > 0), { first: south[0] });

/* --- speed drives length ------------------------------------------------- */
const slow = capture(() => ({ u: 1, v: 0, speed: 1 }), flatProject, flatGeo, { max: 10 });
const fast = capture(() => ({ u: 10, v: 0, speed: 10 }), flatProject, flatGeo, { max: 10 });
check('arrow length grows with speed',
  slow.length && fast.length && fast[0].len > slow[0].len * 2,
  { slow: slow[0] && +slow[0].len.toFixed(2), fast: fast[0] && +fast[0].len.toFixed(2) });

/* --- calm cells draw nothing --------------------------------------------- */
const calm = capture(() => ({ u: 0, v: 0, speed: 0 }), flatProject, flatGeo);
check('a calm cell draws no arrow', calm.length === 0, { arrows: calm.length });

/* --- back-facing globe cells are skipped --------------------------------- */
const backHalf = capture(() => ({ u: 5, v: 0, speed: 5 }),
  (lat, lon) => ({ ...flatProject(lat, lon), facing: lon < 0 }), flatGeo);
check('arrows behind the limb are not drawn',
  backHalf.length > 0 && backHalf.length < 15, { drawn: backHalf.length });

/* --- longitude wrap at the antimeridian --------------------------------- */
const wrapped = flowOffset(0, 179.9, 10, 0, 1);
check('downstream offset wraps past the antimeridian', wrapped.lon > -180 && wrapped.lon < -169, wrapped);
check('downstream offset is clamped at the poles',
  flowOffset(89.9, 0, 0, 10, 1).lat <= 89.5, flowOffset(89.9, 0, 0, 10, 1));

/* --- meteor impact animation -------------------------------------------- */
{
  const { drawImpact } = await import('../src/render/overlay2d.js');
  const calls = { arcs: 0, ellipses: 0, fills: 0, strokes: 0, texts: 0, grads: 0 };
  const mkCtx = () => ({
    strokeStyle: '', fillStyle: '', lineWidth: 0, font: '',
    beginPath() {}, closePath() {},
    moveTo() {}, lineTo() {},
    arc() { calls.arcs++; },
    ellipse() { calls.ellipses++; },
    fill() { calls.fills++; },
    stroke() { calls.strokes++; },
    fillText() { calls.texts++; },
    setLineDash() {},
    createRadialGradient() { calls.grads++; return { addColorStop() {} }; },
  });
  const project = () => ({ x: 100, y: 60, facing: true });
  const sizeFor = () => 40;
  const ok = drawImpact(mkCtx(), { project, sizeFor, lat: 0, lon: 0, radiusDeg: 5, t: 0.2, dust: 1, label: 'test' });
  check('impact animation draws a flash, ring and footprint',
    ok && calls.arcs >= 3 && calls.ellipses >= 1 && calls.grads >= 1 && calls.texts === 1,
    calls);

  let earlyR = 0, lateR = 0;
  const ctxEarly = mkCtx();
  ctxEarly.ellipse = (x, y, rx) => { earlyR = rx; };
  drawImpact(ctxEarly, { project, sizeFor, lat: 0, lon: 0, radiusDeg: 5, t: 0.1, dust: 1 });
  const ctxLate = mkCtx();
  ctxLate.ellipse = (x, y, rx) => { lateR = rx; };
  drawImpact(ctxLate, { project, sizeFor, lat: 0, lon: 0, radiusDeg: 5, t: 1.8, dust: 1 });
  check('the shock ring expands with time', lateR > earlyR * 1.5,
    { at0_1s: +earlyR.toFixed(1), at1_8s: +lateR.toFixed(1) });

  const back = drawImpact(mkCtx(), {
    project: () => ({ x: 100, y: 60, facing: false }), sizeFor,
    lat: 0, lon: 0, radiusDeg: 5, t: 0.2, dust: 1,
  });
  check('the impact animation is skipped on the far side', back === false, { back });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall vector checks passed');
process.exit(failures ? 1 : 0);
