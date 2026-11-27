import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newFile } from '../lib/analytics.mjs';
import { listEnded, findSession, handoffCwd } from '../lib/ended.mjs';
import { describeCwd } from '../lib/collect.mjs';

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// 走査済みの本体ファイル状態を手で組み立てる
function mk({ n, title = null, startCwd = '/h/repo', cwd = startCwd, prompts = ['hello'], lastTs = n * 1000, branch = 'main', prs = [] }) {
  const st = newFile(`/p/${ID(n)}.jsonl`, 'main', ID(n));
  Object.assign(st, { title, startCwd, cwd, branch, lastTs, promptTexts: prompts, firstPrompt: prompts[0] ?? null, lastPrompt: prompts.at(-1) ?? null });
  for (const u of prs) st.prs.set(u, 1);
  return st;
}
const filesOf = (...sts) => new Map(sts.map((s) => [s.file, s]));
const everything = () => true;
const noPr = () => null;
const ids = (rows) => rows.map((r) => r.id);

test('excludes running sessions and sessions with no prompts', () => {
  const files = filesOf(mk({ n: 1 }), mk({ n: 2 }), mk({ n: 3, prompts: [] }));
  const sub = newFile('/p/sub.jsonl', 'sub', ID(4));
  files.set(sub.file, sub);
  const rows = listEnded({ files, runningIds: new Set([ID(2)]), prInfo: noPr, exists: everything });
  assert.deepEqual(ids(rows), [ID(1)]);
});

test('sorts by last activity, newest first, and caps at limit', () => {
  const files = filesOf(mk({ n: 1 }), mk({ n: 3 }), mk({ n: 2 }));
  const rows = listEnded({ files, runningIds: new Set(), prInfo: noPr, exists: everything, limit: 2 });
  assert.deepEqual(ids(rows), [ID(3), ID(2)]);
  assert.equal(rows[0].lastActivityAt, 3000);
});

const searchSet = () =>
  filesOf(
    mk({ n: 1, title: 'Add auth', prompts: ['use a token please'] }),
    mk({ n: 2, title: 'Add auth', prompts: ['nothing here'] }),
    mk({ n: 3, title: 'Other', prompts: ['token only'] }),
  );

test('AND search over title, prompts, repo, branch, cwd and PRs', () => {
  const rows = listEnded({ files: searchSet(), runningIds: new Set(), prInfo: noPr, exists: everything, q: 'auth token' });
  assert.deepEqual(ids(rows), [ID(1)]);
  const byBranch = listEnded({ files: filesOf(mk({ n: 1, branch: 'Ryoma0219/x' }), mk({ n: 2 })), runningIds: new Set(), prInfo: noPr, exists: everything, q: 'ryoma0219/x' });
  assert.deepEqual(ids(byBranch), [ID(1)]);
  const byRepo = listEnded({ files: filesOf(mk({ n: 1, startCwd: '/h/other' }), mk({ n: 2 })), runningIds: new Set(), prInfo: noPr, exists: everything, q: 'other' });
  assert.deepEqual(ids(byRepo), [ID(1)]);
});

test('search is case-insensitive and splits on full-width spaces', () => {
  const rows = listEnded({ files: searchSet(), runningIds: new Set(), prInfo: noPr, exists: everything, q: 'Auth　TOKEN' });
  assert.deepEqual(ids(rows), [ID(1)]);
  const ja = listEnded({ files: filesOf(mk({ n: 1, prompts: ['認証のトークンを直す'] }), mk({ n: 2, prompts: ['認証だけ'] })), runningIds: new Set(), prInfo: noPr, exists: everything, q: '認証　トークン' });
  assert.deepEqual(ids(ja), [ID(1)]);
});

test('finds a session by PR number and PR title', () => {
  const url = 'https://github.com/o/r/pull/42';
  const files = filesOf(mk({ n: 1, prs: [url] }), mk({ n: 2 }));
  const prInfo = (u) => (u === url ? { title: 'Fix the checkout flow', state: 'MERGED' } : null);
  assert.deepEqual(ids(listEnded({ files, runningIds: new Set(), prInfo, exists: everything, q: '#42' })), [ID(1)]);
  assert.deepEqual(ids(listEnded({ files, runningIds: new Set(), prInfo, exists: everything, q: 'checkout' })), [ID(1)]);
  const [row] = listEnded({ files, runningIds: new Set(), prInfo, exists: everything, q: '#42' });
  assert.deepEqual(row.prs, [{ url, number: 42, title: 'Fix the checkout flow', state: 'MERGED' }]);
});

test('match shows the hit inside a prompt', () => {
  const long = `${'a'.repeat(100)} the needle is here ${'b'.repeat(100)}`;
  const files = filesOf(mk({ n: 1, title: 'needle title', prompts: [long] }), mk({ n: 2, title: 'needle only in title' }));
  const rows = listEnded({ files, runningIds: new Set(), prInfo: noPr, exists: everything, q: 'needle' });
  const hit = rows.find((r) => r.id === ID(1));
  assert.match(hit.match, /needle/);
  assert.ok(hit.match.startsWith('…') && hit.match.endsWith('…'));
  assert.ok(hit.match.length <= 6 + 120 + 2);
  assert.equal(rows.find((r) => r.id === ID(2)).match, null);
});

test('falls back to repo and first prompt when there is no ai-title', () => {
  const [row] = listEnded({ files: filesOf(mk({ n: 1, startCwd: '/h/w/myrepo', prompts: ['x'.repeat(60)] })), runningIds: new Set(), prInfo: noPr, exists: everything });
  assert.equal(row.title, `${describeCwd('/h/w/myrepo').repo} · ${'x'.repeat(40)}`);
});

test('resumable and handoffCwd follow which folders still exist', () => {
  const st = mk({ n: 1, startCwd: '/h/repo', cwd: '/h/repo/.claude/worktrees/w' });
  const only = (...paths) => (p) => paths.includes(p);
  const [gone] = listEnded({ files: filesOf(st), runningIds: new Set(), prInfo: noPr, exists: only('/h/repo') });
  assert.equal(gone.resumable, true);
  assert.equal(gone.handoffCwd, '/h/repo');
  assert.equal(gone.worktree, 'w');
  assert.equal(handoffCwd(st, only('/h/repo', '/h/repo/.claude/worktrees/w')), '/h/repo/.claude/worktrees/w');
  const [none] = listEnded({ files: filesOf(st), runningIds: new Set(), prInfo: noPr, exists: only() });
  assert.equal(none.resumable, false);
  assert.equal(none.handoffCwd, null);
});

test('findSession returns the main file state only', () => {
  const st = mk({ n: 1 });
  const sub = newFile('/p/sub.jsonl', 'sub', ID(1));
  const files = new Map([[sub.file, sub], [st.file, st]]);
  assert.equal(findSession(files, ID(1)), st);
  assert.equal(findSession(files, ID(9)), null);
});
