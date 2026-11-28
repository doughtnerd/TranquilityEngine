// Tiny static server for the Chromium run: / -> spike dir, /models/* -> downloaded models, /repo/* -> worktree files.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { MODEL_DIR, ROOT } from './node-read.mjs';

const SPIKE = path.join(ROOT, 'spikes', 'lod-simplify');
const TYPES = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.json': 'application/json' };

export function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      let file;
      if (url.startsWith('/models/')) file = path.join(MODEL_DIR, url.slice(8));
      else if (url.startsWith('/repo/')) file = path.join(ROOT, url.slice(6));
      else file = path.join(SPIKE, url === '/' ? 'bench.html' : url.slice(1));
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    } catch { res.writeHead(404); res.end('not found'); }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}
