import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
const port = Number(process.env.ESM_PERFORMANCE_PORT || 5175);
const hash = (s) =>
  [...s].reduce(
    (n, c) => Math.imul(n ^ c.charCodeAt(0), 16777619) >>> 0,
    2166136261,
  );
const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === '__esm_perf__') {
      const [, profile, seed, id] = parts;
      if (
        parts.length !== 4 ||
        !['mixed', 'uniform', 'local'].includes(profile) ||
        !/^\d+$/.test(seed) ||
        !/^[\w-]+\.(js|html)$/.test(id)
      ) {
        res.writeHead(400).end('Invalid workload request');
        return;
      }
      const n = hash(`${seed}/${id}`);
      const delay =
        profile === 'local'
          ? 0
          : profile === 'uniform'
          ? 65
          : 20 + (n % 50) + (n % 7 === 0 ? 220 + (n % 100) : 0);
      const data =
        id === 'subapp.html'
          ? '<!doctype html><html><head></head><body><div id="performance-root"></div><script type="module" src="./entry.js"></script></body></html>'
          : await readFile(resolve(root, 'performance/fixtures', id));
      // Both modes use identical URLs, bytes and seeded delays. No preloads, no
      // artificial client sleeps, and no persistent cache across cold trials.
      if (delay) await new Promise((done) => setTimeout(done, delay));
      res.writeHead(200, {
        'Content-Type': mime[extname(id)],
        'Cache-Control': 'no-store',
        'Server-Timing': `fixture-delay;dur=${delay}`,
        'Timing-Allow-Origin': '*',
      });
      res.end(data);
      return;
    }
    const path = resolve(
      root,
      '.' +
        decodeURIComponent(
          url.pathname === '/' ? '/performance.html' : url.pathname,
        ),
    );
    if (!path.startsWith(root + sep)) {
      res.writeHead(403).end();
      return;
    }
    const data = await readFile(path);
    res.writeHead(200, {
      'Content-Type': mime[extname(path)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch (error) {
    res.writeHead(error.code === 'ENOENT' ? 404 : 500).end(String(error));
  }
}).listen(port, '127.0.0.1', () =>
  console.log(
    `ESM performance experiment: http://127.0.0.1:${port}/performance.html`,
  ),
);
