// Parse-check the harness's module body and count assertions.
import { readFileSync } from 'node:fs';
const s = readFileSync('tests/harness.html', 'utf8');
const start = s.indexOf('<script type="module">');
const end = s.lastIndexOf('</script>');
if (start < 0 || end < 0) { console.log('no module script found'); process.exit(1); }
const body = s.slice(start + '<script type="module">'.length, end);
try {
  // AsyncFunction so top-level await inside the IIFE body is accepted
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  new AsyncFunction(body);
  console.log('harness module body parses OK');
} catch (e) {
  console.log('PARSE ERROR:', e.message);
  process.exit(1);
}
console.log('report( call sites:', (s.match(/report\(/g) || []).length);
