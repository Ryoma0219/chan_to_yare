#!/usr/bin/env node
// Serves the real UI with dummy data, for README screenshots.
//
//   node demo/server.mjs           http://127.0.0.1:7880
//   PORT=7881 node demo/server.mjs
//
// It reads no session logs and calls neither cmux nor GitHub. Write actions answer ok and do nothing.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fixtures from './fixtures.mjs';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 7880);
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, fixtures.state());
  if (req.method === 'GET' && url.pathname === '/api/insights') return json(res, 200, fixtures.insights());
  if (req.method === 'GET' && url.pathname === '/api/prs') return json(res, 200, fixtures.prs());
  if (req.method === 'GET' && url.pathname === '/api/ended') return json(res, 200, fixtures.ended(Date.now(), url.searchParams.get('q') ?? ''));
  if (req.method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    const push = () => res.write(`data: ${JSON.stringify(fixtures.state())}\n\n`);
    push();
    const timer = setInterval(push, 5000);
    req.on('close', () => clearInterval(timer));
    return;
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/')) return json(res, 200, { ok: true });

  if (req.method === 'GET') {
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return json(res, 404, { error: 'not found' });
    return fs.readFile(file, (err, buf) => {
      if (err) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
      res.end(buf);
    });
  }
  json(res, 404, { error: 'not found' });
});

server.listen(PORT, HOST, () => console.log(`demo: http://${HOST}:${PORT}`));
