// サーバーを別ポートで立ち上げて、壊れたリクエストで落ちないことと、認証が効くことを確かめる。
// cmux に対しては読み取り (tree) しか起きないリクエストだけを送る
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 17000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccd-server-')), 'cfg', 'token');
let child;
let token;

before(async () => {
  child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), CC_DASHBOARD_TOKEN_FILE: TOKEN_FILE },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${BASE}/favicon.svg`);
      token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('server did not start');
});

after(() => child?.kill());

const alive = async () => {
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(child.exitCode, null);
  assert.equal((await fetch(`${BASE}/favicon.svg`)).status, 200);
};

const post = (p, body, headers = { 'X-CC-Token': token }) =>
  fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CC-Dashboard': '1', ...headers },
    body,
  });

// fetch はパスを正規化するので、生のリクエスト行を送る
function raw(target) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: target, headers: { Host: `127.0.0.1:${PORT}` } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
}

test('token file is private', () => {
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(TOKEN_FILE).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(TOKEN_FILE)).mode & 0o777, 0o700);
});

test('a malformed path does not crash the server', async () => {
  assert.equal(await raw('//'), 400);
  await alive();
});

test('null body is rejected and the server stays up', async () => {
  const res = await post('/api/improve', 'null');
  assert.equal(res.status, 400);
  await alive();
});

test('non-object body is rejected', async () => {
  for (const p of ['/api/improve', '/api/exit']) {
    assert.equal((await post(p, '"x"')).status, 400);
    assert.equal((await post(p, '[1]')).status, 400);
  }
  assert.equal(child.exitCode, null);
});

test('without the token, the API is closed', async () => {
  assert.equal((await fetch(`${BASE}/`)).status, 200);
  for (const p of ['/api/state', '/api/events', '/api/insights', '/api/prs']) {
    assert.equal((await fetch(`${BASE}${p}`)).status, 401, p);
  }
  for (const p of ['/api/improve', '/api/memo', '/api/exit', '/api/focus']) {
    assert.equal((await post(p, '{"text":"x"}', {})).status, 401, p);
    assert.equal((await post(p, '{"text":"x"}', { 'X-CC-Token': '0'.repeat(64) })).status, 401, p);
  }
  // 静的なコードと素材は開いたまま (Mac アプリのヘルスチェックが使う)
  assert.equal((await fetch(`${BASE}/app.js`)).status, 200);
  assert.equal((await fetch(`${BASE}/auth.js`)).status, 200);
});

test('the token header opens the API, and no cookie is ever set', async () => {
  const res = await fetch(`${BASE}/api/state`, { headers: { 'X-CC-Token': token } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('set-cookie'), null);
  const body = await res.text();
  assert.ok(!body.includes(token));
  assert.ok(!(await (await fetch(`${BASE}/`)).text()).includes(token));
});

test('the query token works for /api/events only', async () => {
  assert.equal((await fetch(`${BASE}/api/state?t=${token}`)).status, 401);
  assert.equal((await fetch(`${BASE}/api/events?t=${'0'.repeat(64)}`)).status, 401);
  const ac = new AbortController();
  const res = await fetch(`${BASE}/api/events?t=${token}`, { signal: ac.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  ac.abort();
});

test('the locked page is open', async () => {
  assert.equal((await fetch(`${BASE}/locked`)).status, 200);
});
