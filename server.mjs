#!/usr/bin/env node
// Claude Code セッションダッシュボード
//
//   node server.mjs            http://127.0.0.1:7878 で起動
//   PORT=7979 node server.mjs  ポートを変える
//
// 会話ログの中身を返すサーバーなので、127.0.0.1 にだけ bind し、
// Host ヘッダーも検査する (DNS リバインディング対策)。CORS ヘッダーは返さない。
// API はトークンを知っている人にだけ開く (lib/auth.mjs)。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Collector } from './lib/collect.mjs';
import { Analytics } from './lib/analytics.mjs';
import { GitHub } from './lib/github.mjs';
import { computePRs } from './lib/prs.mjs';
import { sanitizeImprove, launchImprove } from './lib/improve.mjs';
import { loadToken, isAuthorized } from './lib/auth.mjs';
import { execFile } from 'node:child_process';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 7878);
const POLL_MS = 1500;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const TOKEN = loadToken();

// コードと素材だけなので、認証なしで返す。データはすべて /api/ から取る
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/auth.js': ['auth.js', 'text/javascript; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/chime.js': ['chime.js', 'text/javascript; charset=utf-8'],
  '/insights.js': ['insights.js', 'text/javascript; charset=utf-8'],
  '/prs.js': ['prs.js', 'text/javascript; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/future.css': ['future.css', 'text/css; charset=utf-8'],
  '/themes.css': ['themes.css', 'text/css; charset=utf-8'],
  '/look.js': ['look.js', 'text/javascript; charset=utf-8'],
  '/fonts/chakra-petch-500.woff2': ['fonts/chakra-petch-500.woff2', 'font/woff2'],
  '/fonts/chakra-petch-600.woff2': ['fonts/chakra-petch-600.woff2', 'font/woff2'],
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

// 同一オリジン・独自ヘッダー・JSON の検査をかける書き込み系
const POST_ROUTES = new Set(['/api/focus', '/api/memo', '/api/exit', '/api/improve']);

function runCmux(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

const collector = new Collector();
const analytics = new Analytics();
const github = new GitHub();
const PR_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
let prCache = null; // { at, body }
let prBuilding = null;

// 会話ログに出てくる PR の URL から、対象にする GitHub の owner を決める
function ownersFrom(files) {
  const owners = new Set();
  for (const st of files.values()) for (const url of st.prs.keys()) {
    const m = url.match(/^https:\/\/github\.com\/([\w.-]+)\//);
    if (m) owners.add(m[1]);
  }
  return [...owners];
}

async function buildPRs() {
  const files = await analytics.files30();
  const owners = ownersFrom(files);
  const gh = await github.myPullRequests(owners, Date.now() - PR_WINDOW_MS);
  const result = computePRs({
    files,
    prs: gh.prs,
    login: gh.login,
    priceOf: (m) => analytics.priceOf(m),
    patchOf: (u) => github.patchOf(u),
  });
  result.error = gh.error ?? null;
  prCache = { at: Date.now(), body: JSON.stringify(result) };
  return prCache.body;
}
let latest = null;
let latestJson = '';
const clients = new Set();

async function tick() {
  try {
    const snap = await collector.snapshot();
    const { now, ...rest } = snap;
    const body = JSON.stringify(rest);
    latest = snap;
    if (body !== latestJson) {
      latestJson = body;
      const payload = `data: ${JSON.stringify(snap)}\n\n`;
      for (const res of clients) res.write(payload);
    }
  } catch (e) {
    console.error('[collect]', e);
  } finally {
    setTimeout(tick, POLL_MS);
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

// 改行は Enter として送信されてしまうので空白に畳む。制御文字は落とす
function sanitizeMemo(text) {
  return text
    .replace(/\r?\n+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 4000);
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > limit) {
        reject(new Error('too-large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const LOCKED_PAGE = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>Chan to Yare</title>
<h1>Chan to Yare is locked</h1>
<p>Open the dashboard with <code>npm run open</code> in the cc-dashboard folder.</p>
<p>In the Chan to Yare app, this page goes away once the server has created its token.</p>
`;

async function handle(req, res) {
  if (!ALLOWED_HOSTS.has(req.headers.host ?? '')) return send(res, 421, 'misdirected');
  let url;
  try {
    // "//" のようなパスは new URL が例外を投げる。逃がすとプロセスごと落ちる
    url = new URL(req.url, `http://${req.headers.host}`);
  } catch {
    return send(res, 400, 'bad request');
  }

  // トークンがない・古いときに public/auth.js が移ってくる画面
  if (req.method === 'GET' && url.pathname === '/locked') {
    return send(res, 200, LOCKED_PAGE, { 'Content-Type': 'text/html; charset=utf-8' });
  }
  if (url.pathname.startsWith('/api/') && !isAuthorized(req, url, TOKEN)) return send(res, 401, 'unauthorized');

  if (req.method === 'GET' && STATIC[url.pathname]) {
    const [file, type] = STATIC[url.pathname];
    fs.readFile(path.join(PUBLIC_DIR, file), (err, buf) => {
      if (err) return send(res, 404, 'not found');
      send(res, 200, buf, { 'Content-Type': type });
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/state') {
    if (!latest) latest = await collector.snapshot();
    return send(res, 200, JSON.stringify(latest), { 'Content-Type': 'application/json' });
  }

  if (req.method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    if (latest) res.write(`data: ${JSON.stringify(latest)}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/insights') {
    try {
      const result = await analytics.get();
      return send(res, 200, JSON.stringify(result), { 'Content-Type': 'application/json' });
    } catch (e) {
      console.error('[insights]', e);
      return send(res, 500, JSON.stringify({ error: 'insights-failed' }), { 'Content-Type': 'application/json' });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/prs') {
    try {
      const fresh = prCache && Date.now() - prCache.at < 60000;
      if (!fresh && !prBuilding) prBuilding = buildPRs().finally(() => (prBuilding = null));
      const body = prCache ? prCache.body : await prBuilding;
      return send(res, 200, body, { 'Content-Type': 'application/json' });
    } catch (e) {
      console.error('[prs]', e);
      return send(res, 500, JSON.stringify({ error: 'prs-failed' }), { 'Content-Type': 'application/json' });
    }
  }

  if (req.method === 'POST' && POST_ROUTES.has(url.pathname)) {
    // 他サイトからのフォーム送信を弾く: 同一オリジンかつ独自ヘッダー付き (プリフライト必須) の JSON だけ受ける
    const origin = req.headers.origin;
    if (origin && !ALLOWED_HOSTS.has(origin.replace(/^http:\/\//, ''))) return send(res, 403, 'forbidden');
    if (req.headers['x-cc-dashboard'] !== '1') return send(res, 403, 'forbidden');
    if (!String(req.headers['content-type']).startsWith('application/json')) return send(res, 415, 'json only');
    let body;
    try {
      body = JSON.parse(await readBody(req, 16384));
    } catch {
      return send(res, 400, 'bad request');
    }
    // null や配列が来ると body.text で例外になり、プロセスごと落ちる
    if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, 'bad request');
    const { sessionId } = body;
    const validId = typeof sessionId === 'string' && /^[0-9a-f-]{36}$/i.test(sessionId);
    // improve だけは sessionId を省ける (ヘッダーからの要望)
    if (!validId && !(url.pathname === '/api/improve' && sessionId == null)) return send(res, 400, 'bad request');

    let result;
    if (url.pathname === '/api/focus') {
      result = await collector.focus(sessionId);
    } else if (url.pathname === '/api/exit') {
      result = await collector.exitSession(sessionId);
    } else if (url.pathname === '/api/improve') {
      const text = typeof body.text === 'string' ? sanitizeImprove(body.text) : '';
      if (!text) return send(res, 400, 'bad request');
      // 立ち上げ先と会話ログのパスはサーバーが sessionId から引く。body の他の値は使わない
      let session;
      if (validId) {
        session = collector.sessionContext(sessionId);
        if (!session) return send(res, 409, JSON.stringify({ ok: false, reason: 'session-not-found' }), { 'Content-Type': 'application/json' });
      }
      try {
        result = await launchImprove({ text, session, run: runCmux });
      } catch (e) {
        // ~/.cache に書けないなど。例外を逃がすとサーバーが落ち、待ち中の Exit も巻き添えになる
        console.error('[improve]', e);
        result = { ok: false, reason: 'improve-failed' };
      }
    } else {
      const text = typeof body.text === 'string' ? sanitizeMemo(body.text) : '';
      if (!text) return send(res, 400, 'bad request');
      const prompt = body.mode === 'remember' ? `次のことを覚えておいてください（メモリに保存）: ${text}` : text;
      result = await collector.sendMemo(sessionId, prompt);
    }
    console.log(`[${url.pathname.slice(5)}] ${new Date().toISOString()} ${sessionId ?? '-'} ${result.ok ? 'ok' : result.reason}`);
    return send(res, result.ok ? 200 : 409, JSON.stringify(result), { 'Content-Type': 'application/json' });
  }

  send(res, 404, 'not found');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    // ハンドラの例外でサーバーを落とさない (待ち中の Exit やほかの画面を巻き添えにしない)
    console.error('[request]', req.method, e);
    if (!res.headersSent) send(res, 500, 'internal error');
    else res.destroy();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`cc-dashboard: http://${HOST}:${PORT} (open it with: npm run open)`);
  tick();
});
