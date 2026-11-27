import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newFile, applyLine } from '../lib/analytics.mjs';

const ts = (m) => new Date(Date.UTC(2026, 10, 27, 0, m)).toISOString();
const user = (m, text, extra = {}) =>
  JSON.stringify({ type: 'user', timestamp: ts(m), cwd: '/r', gitBranch: 'b1', message: { role: 'user', content: text }, ...extra });
const asst = (m, text, usage, extra = {}) =>
  JSON.stringify({ type: 'assistant', timestamp: ts(m), cwd: '/r', message: { id: `m${m}`, model: 'claude-x', content: [{ type: 'text', text }], usage }, ...extra });
const feed = (lines) => {
  const st = newFile('/x.jsonl', 'main', 's');
  for (const l of lines) applyLine(st, l);
  return st;
};

test('keeps start cwd, last cwd and branch', () => {
  const st = feed([user(0, 'a'), user(1, 'b', { cwd: '/r/.claude/worktrees/w', gitBranch: 'b2' })]);
  assert.equal(st.startCwd, '/r');
  assert.equal(st.cwd, '/r/.claude/worktrees/w');
  assert.equal(st.branch, 'b2');
});

test('keeps prompt texts, first and last prompt', () => {
  const st = feed([user(0, 'first'), user(1, 'x'.repeat(600)), user(2, 'last')]);
  assert.deepEqual(st.promptTexts.map((t) => t.length), [5, 500, 4]);
  assert.equal(st.firstPrompt, 'first');
  assert.equal(st.lastPrompt, 'last');
});

test('first and last prompt are capped at 300 characters', () => {
  const st = feed([user(0, 'y'.repeat(400))]);
  assert.equal(st.firstPrompt.length, 300);
  assert.equal(st.lastPrompt.length, 300);
});

test('caps prompt texts at 200', () => {
  const st = feed(Array.from({ length: 205 }, (_, i) => user(i % 60, `p${i}`)));
  assert.equal(st.promptTexts.length, 200);
  assert.equal(st.promptTexts[0], 'p5');
});

test('context tokens and last reply come from the last main assistant message', () => {
  const st = feed([
    asst(0, 'r1', { input_tokens: 1, cache_read_input_tokens: 10, cache_creation_input_tokens: 100, output_tokens: 5 }),
    asst(1, 'side', { input_tokens: 9, cache_read_input_tokens: 9, cache_creation_input_tokens: 9 }, { isSidechain: true }),
  ]);
  assert.equal(st.contextTokens, 111);
  assert.equal(st.lastReply, 'r1');
});

test('sidechain user lines do not move start cwd or add prompts', () => {
  const st = feed([user(0, 'side', { isSidechain: true, cwd: '/other' }), user(1, 'main')]);
  assert.equal(st.startCwd, '/r');
  assert.deepEqual(st.promptTexts, ['main']);
});

test('subagent files do not collect prompt texts', () => {
  const st = newFile('/x.jsonl', 'sub', 's');
  applyLine(st, user(0, 'a'));
  assert.deepEqual(st.promptTexts, []);
  assert.equal(st.startCwd, null);
});
