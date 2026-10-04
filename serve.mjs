/**
 * Zero-dependency static file server for the climate simulator.
 *
 *   node serve.mjs            # http://127.0.0.1:8787
 *   node serve.mjs 9000       # custom port
 *
 * ES modules need a real HTTP origin (file:// blocks module imports), so use
 * this instead of double-clicking index.html.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.argv[2] || 8787);
const HOST = process.argv[3] || '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    // Test harness result sink (used by tests/harness.html)
    if (req.method === 'POST' && req.url === '/__result') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks).toString('utf8');
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(ROOT, 'tests', 'last-report.json'), body, 'utf8');
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      console.log('[harness] report written (' + body.length + ' bytes)');
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host}`);
    let pathname = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    if (pathname === '' || pathname.endsWith('/')) pathname += 'index.html';
    const target = normalize(join(ROOT, pathname));
    if (!target.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const info = await stat(target).catch(() => null);
    if (!info || !info.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 not found: ' + pathname);
      return;
    }
    const body = await readFile(target);
    res.writeHead(200, {
      'content-type': TYPES[extname(target).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
      'content-length': body.length,
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('500 ' + err.message);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Planetary Climate Simulator serving ${ROOT}`);
  console.log(`  ->  http://${HOST}:${PORT}/`);
});
