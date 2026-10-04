/** Fast meteor state test: no long integrations. */
import { World } from '../src/world/world.js';
import { defaults } from '../src/state/params.js';
import { appDefaultParams } from '../src/state/derive.js';

const bag = appDefaultParams(defaults);
Object.assign(bag, {
  meteorEnabled: true, meteorMonth: 12, meteorEndMonth: 12,
  meteorMass: 1e15, meteorCount: 5, meteorMassSigma: 0.4,
});
const world = new World(bag, { seed: 20240 });
for (let i = 0; i < 14; i++) world.step(1);
console.log('after impact : impacts', world.impacts.length, 'dust', world.impactDust.toFixed(3),
  'load', world.impact.load.toFixed(3));
console.log('sites        :', world.impact.sites.map((s) => `${s.lat.toFixed(1)},${s.lon.toFixed(1)}`).join(' '));

const snap = world.snapshot();
const w2 = new World(bag, { seed: 20240 });
w2.restore(snap);
console.log('restored     : impacts', w2.impacts.length, 'dust', w2.impactDust.toFixed(3),
  'month', Math.round(w2.time.month));
for (let i = 0; i < 3; i++) w2.step(1);
console.log('+3 months    : impacts', w2.impacts.length, '(must stay 5)');
const w3 = world.clone();
console.log('clone        : impacts', w3.impacts ? w3.impacts.length : 'null');

const loadAtImpact = snap.impact.load;
const massAtImpact = world.dustReservoir(world.time.month);
for (let i = 0; i < 24; i++) world.step(1);
const massAfter = world.dustReservoir(world.time.month);
const retained = massAfter / Math.max(1e-9, massAtImpact);
console.log('+2 years     : mass', massAtImpact.toExponential(2), '->', massAfter.toExponential(2),
  'retained', retained.toFixed(3), '(exp(-2/2.2) = 0.403 expected)');
console.log('               dust load', loadAtImpact.toFixed(3), '->', world.impactDust.toFixed(3));
