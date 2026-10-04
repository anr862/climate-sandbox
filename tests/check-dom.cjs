/**
 * Static DOM contract check — node tests/check-dom.cjs
 *
 * The browser harness is the authoritative integration test, but it needs a real
 * browser. This catches the failure mode that is by far the most common after an
 * HTML/JS edit: JavaScript asking for an element id that the markup no longer
 * has (a renamed or removed control), which otherwise shows up as a runtime
 * "Cannot read properties of null" only when a user opens that panel.
 *
 * Ids are collected from:
 *   - index.html            `id="..."`
 *   - any src/**\/*.js      `$('id')`, `getElementById('id')`, `querySelector('#id')`
 *   - ids created at runtime (`el('div', { id: 'x' })`, `setAttribute('id'...)`)
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const htmlIds = new Set();
for (const m of html.matchAll(/\bid="([^"]+)"/g)) htmlIds.add(m[1]);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const files = walk(path.join(root, 'src'));
const runtimeIds = new Set();
const wanted = new Map();          // id -> first file that asks for it

const note = (id, file) => { if (!wanted.has(id)) wanted.set(id, path.relative(root, file)); };

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  for (const m of text.matchAll(/getElementById\(\s*['"]([A-Za-z0-9_-]+)['"]\s*\)/g)) note(m[1], file);
  for (const m of text.matchAll(/querySelector(?:All)?\(\s*(['"])#([A-Za-z0-9_-]+)\1\s*\)/g)) note(m[2], file);
  for (const m of text.matchAll(/(?:^|[^\w$.])[$q]\(\s*['"]([A-Za-z0-9_-]+)['"]\s*\)/g)) note(m[1], file);
  // ids the code creates itself
  for (const m of text.matchAll(/\bid:\s*['"]([A-Za-z0-9_-]+)['"]/g)) runtimeIds.add(m[1]);
  for (const m of text.matchAll(/\{'id':\s*['"]([A-Za-z0-9_-]+)['"]/g)) runtimeIds.add(m[1]);
  for (const m of text.matchAll(/setAttribute\(\s*['"]id['"]\s*,\s*['"]([A-Za-z0-9_-]+)['"]/g)) runtimeIds.add(m[1]);
}

const missing = [];
for (const [id, file] of wanted) {
  if (htmlIds.has(id) || runtimeIds.has(id)) continue;
  missing.push({ id, file });
}

const unused = [];
for (const id of htmlIds) if (!wanted.has(id)) unused.push(id);

console.log(`index.html ids           : ${htmlIds.size}`);
console.log(`ids referenced from js   : ${wanted.size}`);
console.log(`ids created at runtime   : ${runtimeIds.size}`);
if (missing.length) {
  console.log('\nMISSING (js asks for an id that does not exist):');
  for (const m of missing) console.log(`  #${m.id}  <- ${m.file}`);
} else {
  console.log('\nDOM contract ok: every referenced id exists.');
}
if (unused.length) console.log(`\nnote: ${unused.length} markup ids are not referenced by id-selector: ${unused.join(', ')}`);

process.exit(missing.length ? 1 : 0);
