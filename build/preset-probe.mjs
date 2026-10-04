/**
 * Quick single-preset probe:  node build/preset-probe.mjs <id> [cloud ...]
 * Prints the 25-year 12-month mean for one preset, optionally sweeping its cloud
 * cover, so a preset can be re-tuned without running the whole suite.
 */
import { World } from "../src/world/world.js";
import { defaults } from "../src/state/params.js";
import { appDefaultParams } from "../src/state/derive.js";
import { PRESETS } from "../src/state/presets.js";

const id = process.argv[2] || "archipelago";
const clouds = process.argv.slice(3).map(Number);
const preset = PRESETS.find((q) => q.id === id);
if (!preset) {
  console.log(`no preset "${id}"; available: ${PRESETS.map((q) => q.id).join(", ")}`);
  process.exit(1);
}

function run(over, years = 25) {
  const bag = { ...appDefaultParams(defaults), ...(preset.params || {}), ...over };
  const w = new World(bag, { seed: preset.seed });
  for (let n = 0; n < years * 12; n++) w.step(1);
  return w;
}

const list = clouds.length ? clouds : [null];
for (const c of list) {
  const w = run(c === null ? {} : { cloud: c });
  console.log(
    `cloud=${String(c === null ? preset.params.cloud : c).padStart(3)}  ` +
    `Tann=${w.tGlobalAnnual.toFixed(2)}K (${(w.tGlobalAnnual - 273.15).toFixed(2)}C)  ` +
    `alb=${w.albedoGlobal.toFixed(3)}  ice=${(w.iceAreaFrac * 100).toFixed(1)}%  ` +
    `rain=${w.metrics().precip.toFixed(1)}mm/mo`,
  );
}
