import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadToken, isAuthorized } from '../lib/auth.mjs';

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ccd-auth-')), 'cfg', 'token');
const mode = (p) => fs.statSync(p).mode & 0o777;

test('creates a private token and reuses it', () => {
  const f = file();
  const t = loadToken(f);
  assert.match(t, /^[0-9a-f]{64}$/);
  assert.equal(mode(f), 0o600);
  assert.equal(mode(path.dirname(f)), 0o700);
  assert.equal(loadToken(f), t);
});

test('tightens loose permissions', () => {
  const f = file();
  const t = loadToken(f);
  fs.chmodSync(f, 0o644);
  fs.chmodSync(path.dirname(f), 0o755);
  assert.equal(loadToken(f), t);
  assert.equal(mode(f), 0o600);
  assert.equal(mode(path.dirname(f)), 0o700);
});

test('replaces a broken token', () => {
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, 'short');
  const t = loadToken(f);
  assert.match(t, /^[0-9a-f]{64}$/);
  assert.equal(mode(f), 0o600);
});

test('isAuthorized accepts the header, and the query for /api/events only', () => {
  const t = 'a'.repeat(64);
  const check = (headers, target, method = 'GET') =>
    isAuthorized({ method, headers }, new URL(target, 'http://127.0.0.1'), t);
  assert.ok(check({ 'x-cc-token': t }, '/api/state'));
  assert.ok(check({ 'x-cc-token': t }, '/api/memo', 'POST'));
  assert.ok(check({}, `/api/events?t=${t}`));
  assert.ok(!check({}, `/api/state?t=${t}`));
  assert.ok(!check({}, `/api/events?t=${t}`, 'POST'));
  assert.ok(!check({}, '/api/state'));
  assert.ok(!check({ 'x-cc-token': 'b'.repeat(64) }, '/api/state'));
  assert.ok(!check({ 'x-cc-token': t.slice(1) }, '/api/state'));
  assert.ok(!check({ 'x-cc-token': '' }, '/api/state'));
  assert.ok(!check({ cookie: `ccd_token=${t}` }, '/api/state'));
});
