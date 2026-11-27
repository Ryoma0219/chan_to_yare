// サーバーを別ポートで立ち上げて、壊れたリクエストで落ちないことを確かめる。
// cmux に対しては読み取り (tree) しか起きないリクエストだけを送る
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 17000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
let child;

before(async () => {
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${BASE}/`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('server did not start');
});

after(() => child?.kill());

const post = (p, body) =>
  fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CC-Dashboard': '1' },
    body,
  });

test('null body is rejected and the server stays up', async () => {
  const res = await post('/api/improve', 'null');
  assert.equal(res.status, 400);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(child.exitCode, null);
  assert.equal((await fetch(`${BASE}/`)).status, 200);
});

test('non-object body is rejected', async () => {
  for (const p of ['/api/improve', '/api/exit']) {
    assert.equal((await post(p, '"x"')).status, 400);
    assert.equal((await post(p, '[1]')).status, 400);
  }
  assert.equal(child.exitCode, null);
});
