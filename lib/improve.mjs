// Claude Code の振る舞いについての改善要望を、新しい cmux ワークスペースの Claude Code に渡す。
//
// 要望の本文はシェルのコマンド文字列に入れない。本文はファイルに書き、
// cmux にはそのファイルを読むだけの固定のコマンドを渡す。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { CMUX_BIN } from './collect.mjs';

const HOME = os.homedir();
const DEFAULT_DIR = path.join(HOME, '.cache', 'cc-dashboard', 'improve');
const DEFAULT_CWD = path.join(HOME, '.claude');
const KEEP_MS = 10 * 60 * 1000;
const SWEEP_AFTER_MS = 60 * 60 * 1000;

// ファイル経由なので改行とタブは残す。それ以外の制御文字は落とす
export function sanitizeImprove(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, 4000);
}

export function buildImprovePrompt({ text, session }) {
  let prompt = `Claude Code の振る舞いについての改善要望です。

## 要望
${text}

## 進め方
- まず、この要望を満たすにはどこを直すべきかを判断してください。
- 候補は、グローバルの ~/.claude/CLAUDE.md、スキル、フック、~/.claude/settings.json、メモリ、作業中リポジトリの CLAUDE.md や .claude/ 以下の設定です。
- 直す先と変更内容を短く示してから直してください。
`;
  if (session) {
    prompt += `
## きっかけになったセッション
- タイトル: ${session.title}
- 作業ディレクトリ: ${session.cwd}
- 会話ログ: ${session.transcript ?? '見つかりませんでした'}
- 必要ならこの会話ログ（jsonl）を読んで、実際の振る舞いを確認してください。
`;
  }
  return prompt;
}

export function improveCommand(file) {
  if (file.includes("'")) throw new Error('unsafe path');
  return `claude "$(cat '${file}')"`;
}

function sweep(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const file = path.join(dir, name);
    try {
      if (Date.now() - fs.statSync(file).mtimeMs > SWEEP_AFTER_MS) fs.unlinkSync(file);
    } catch {}
  }
}

export async function launchImprove({ text, session, run, dir = DEFAULT_DIR }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  sweep(dir);
  const file = path.join(dir, `${crypto.randomBytes(16).toString('hex')}.md`);
  fs.writeFileSync(file, buildImprovePrompt({ text, session }), { mode: 0o600 });
  setTimeout(() => fs.rm(file, { force: true }, () => {}), KEEP_MS).unref();
  const cwd = session?.cwd ?? DEFAULT_CWD;
  const out = await run(CMUX_BIN, ['new-workspace', '--name', '改善要望', '--cwd', cwd, '--command', improveCommand(file)]);
  return out == null ? { ok: false, reason: 'cmux-failed' } : { ok: true };
}
