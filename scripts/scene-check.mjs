/**
 * Scene round-trip + slot-size check. Run: node scripts/scene-check.mjs
 *
 * NOTE: all imports use "./x.js" style consistently — mixing "./x.js" and
 * "../x.js" would instantiate two copies of state.js and silently break the
 * wiring this script relies on.
 */
import { World } from '../src/world/world.js';
import { defaults } from '../src/state/params.js';
import { serializeScene, serializeSceneCompact, state } from '../src/state/state.js';
import { terrainToObject, terrainFromObject } from '../src/world/terrain.js';

const world = new World({ ...defaults() }, { seed: 20240 });
for (let i = 0; i < 240; i++) world.step(1);

// wire the world into the state module exactly the way main.js does
state.world = world;
state.params = world.params;

console.log('--- terrain object ---');
const terr = terrainToObject(world.terrain);
const terrJson = JSON.stringify(terr);
console.log('terrain JSON', (terrJson.length / 1024).toFixed(0), 'kB');
const back = terrainFromObject(JSON.parse(terrJson));
let maxErr = 0;
for (let i = 0; i < world.terrain.height.length; i++) {
  maxErr = Math.max(maxErr, Math.abs(back.height[i] - world.terrain.height[i]));
}
console.log('height round-trip max error', maxErr.toFixed(3), 'm');

console.log('\n--- scene ---');
const scene = serializeScene();
const json = JSON.stringify(scene);
console.log('full scene JSON', (json.length / 1024).toFixed(0), 'kB');
console.log('  terrain    ', (JSON.stringify(scene.terrain).length / 1024).toFixed(0), 'kB');
console.log('  series     ', (JSON.stringify(scene.series).length / 1024).toFixed(0), 'kB');
console.log('  checkpoints', (JSON.stringify(scene.checkpoints).length / 1024).toFixed(0), 'kB');
console.log('  checkpoints kept:', scene.checkpoints.length);

const compact = serializeSceneCompact();
const compactJson = JSON.stringify(compact);
console.log('compact scene JSON (slot payload)', (compactJson.length / 1024).toFixed(0), 'kB');
console.log('  fits a typical 5 MB localStorage quota:', compactJson.length < 4.5e6);

const terrain2 = compact.terrain ? terrainFromObject(compact.terrain) : null;
const w2 = new World({ ...defaults(), ...compact.params }, { name: compact.name, seed: compact.seed, terrain: terrain2 });
let maxErr2 = 0;
for (let i = 0; i < world.terrain.height.length; i++) {
  maxErr2 = Math.max(maxErr2, Math.abs(w2.terrain.height[i] - world.terrain.height[i]));
}
console.log('restored world height error', maxErr2.toFixed(3), 'm; T =', w2.tGlobal.toFixed(2), 'K');
console.log('OK');
