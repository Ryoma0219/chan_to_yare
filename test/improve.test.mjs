import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sanitizeImprove, buildImprovePrompt, improveCommand, launchImprove } from '../lib/improve.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ccd-improve-'));

// launchImprove に渡す run の代わり。受けた引数を記録して、決めた値を返す
function recorder(result = '') {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push({ cmd, args });
    return result;
  };
  return { calls, run };
}
const flag = (args, name) => args[args.indexOf(name) + 1];

test('sanitizeImprove keeps newlines and drops control chars', () => {
  assert.equal(sanitizeImprove(' a\r\nb\u0007c '), 'a\nb c');
});

test('sanitizeImprove caps length', () => {
  assert.equal(sanitizeImprove('x'.repeat(5000)).length, 4000);
});

test('prompt without session', () => {
  const p = buildImprovePrompt({ text: 'X' });
  assert.ok(p.includes('## 要望\nX'));
  assert.ok(!p.includes('きっかけになったセッション'));
});

test('prompt with session', () => {
  const p = buildImprovePrompt({ text: 'X', session: { title: 'T', cwd: '/w', transcript: '/l.jsonl' } });
  assert.ok(p.includes('- タイトル: T'));
  assert.ok(p.includes('- 作業ディレクトリ: /w'));
  assert.ok(p.includes('- 会話ログ: /l.jsonl'));
});

test('prompt with session but no transcript', () => {
  const p = buildImprovePrompt({ text: 'X', session: { title: 'T', cwd: '/w', transcript: null } });
  assert.ok(p.includes('- 会話ログ: 見つかりませんでした'));
});

test('command never contains user text', async () => {
  const dir = tmp();
  const text = "it's $(rm -rf ~) `x`\nnext";
  const { calls, run } = recorder();
  const result = await launchImprove({ text, run, dir });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  const command = flag(calls[0].args, '--command');
  assert.match(command, /^claude "\$\(cat '[^']+\.md'\)"$/);
  for (const part of ["it's", '$(rm', '`x`', 'next']) assert.ok(!command.includes(part), part);
  const file = command.match(/cat '([^']+)'/)[1];
  assert.equal(path.dirname(file), dir);
  assert.equal(fs.readFileSync(file, 'utf8'), buildImprovePrompt({ text }));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('cwd defaults to ~/.claude', async () => {
  const { calls, run } = recorder();
  await launchImprove({ text: 'x', run, dir: tmp() });
  assert.equal(flag(calls[0].args, '--cwd'), path.join(os.homedir(), '.claude'));
  assert.equal(calls[0].args[0], 'new-workspace');
});

test('context comes from collector only', async () => {
  const { calls, run } = recorder();
  await launchImprove({ text: 'x', session: { title: 'T', cwd: '/from/server', transcript: null }, run, dir: tmp() });
  assert.equal(flag(calls[0].args, '--cwd'), '/from/server');
});

test('cmux failure', async () => {
  const { run } = recorder(null);
  assert.deepEqual(await launchImprove({ text: 'x', run, dir: tmp() }), { ok: false, reason: 'cmux-failed' });
});

test('improveCommand rejects quote in path', () => {
  assert.throws(() => improveCommand("/a'b.md"));
});

test('old prompt files are swept on launch', async () => {
  const dir = tmp();
  const old = path.join(dir, 'old.md');
  fs.writeFileSync(old, 'x');
  const hourAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(old, hourAgo, hourAgo);
  const { run } = recorder();
  await launchImprove({ text: 'x', run, dir });
  assert.ok(!fs.existsSync(old));
});
