import { World } from "../src/world/world.js";
import { defaults } from "../src/state/params.js";
import { PRESETS } from "../src/state/presets.js";
import { gridDimsFor } from "../src/world/gridSizes.js";

const preset = PRESETS.find((q) => q.id === "snowball");
const years = Number(process.argv[2] ?? 40);

function spin(over) {
  const bag = { ...defaults(), ...(preset.params || {}), ...over };
  if (bag.cloud === defaults().cloud) bag.cloud = Math.min(96, 12 + bag.humidity * 0.72);
  const d = gridDimsFor(64800);
  const w = new World(bag, { seed: preset.seed, gridX: d.gx, gridY: d.gy });
  for (let n = 0; n < years * 12; n++) w.step(1);
  return w;
}

console.log(`snowball preset, ${years} yr.  baseline params: ${JSON.stringify(preset.params)}`);
for (const irr of [1180, 1120, 1060, 1000, 940, 880]) {
  const w = spin({ irradiance: irr });
  console.log(
    `  irradiance=${String(irr).padStart(4)} (${((irr / 1361) * 100).toFixed(1)}% of Earth)  ` +
    `Tann=${w.tGlobalAnnual.toFixed(2)}  inst=${w.tGlobal.toFixed(2)}  alb=${w.albedoGlobal.toFixed(3)}  ` +
    `ice=${(w.iceAreaFrac * 100).toFixed(1)}%  rain=${w.metrics().precip.toFixed(1)}`,
  );
}
console.log("\nwith co2 also lowered:");
for (const [irr, co2] of [[1180, 40], [1120, 90], [1120, 40], [1060, 90]]) {
  const w = spin({ irradiance: irr, co2 });
  console.log(
    `  irr=${String(irr).padStart(4)} co2=${String(co2).padStart(3)}  ` +
    `Tann=${w.tGlobalAnnual.toFixed(2)}  alb=${w.albedoGlobal.toFixed(3)}  ice=${(w.iceAreaFrac * 100).toFixed(1)}%`,
  );
}
