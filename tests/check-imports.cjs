/** Static import/export cross-check (run: node tests/check-imports.cjs). */
const fs = require('fs');
const path = require('path');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = walk('src');
const exportsMap = {};
for (const f of files) {
  const t = fs.readFileSync(f, 'utf8');
  const names = new Set();
  for (const m of t.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  for (const m of t.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const s = part.trim();
      if (!s) continue;
      const as = s.split(/\s+as\s+/);
      names.add((as[1] || as[0]).trim());
    }
  }
  exportsMap[path.resolve(f)] = names;
}

let problems = 0;
for (const f of files) {
  const t = fs.readFileSync(f, 'utf8');
  const re = /import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(t))) {
    const spec = m[2];
    if (!spec.startsWith('.')) continue;
    const target = path.resolve(path.dirname(f), spec);
    const names = exportsMap[target];
    if (!names) { console.log('MISSING MODULE', f, '->', spec); problems++; continue; }
    for (const n of m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean)) {
      if (!names.has(n)) { console.log('MISSING EXPORT', path.relative('.', f), 'imports', n, 'from', spec); problems++; }
    }
  }
}
console.log('import problems:', problems);
process.exitCode = problems ? 1 : 0;
