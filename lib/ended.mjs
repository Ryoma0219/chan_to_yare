// 終わったセッションを探して、新しい cmux ワークスペースで開き直す (Ended ビューと PRs ビューの Resume / Hand off)。
//
// 一覧は Analytics が走査した 31 日分の会話ログ (本体ファイル) から作る。
// 検索はサーバー側で行い、依頼文の全文はブラウザに送らない。

import fs from 'node:fs';
import { describeCwd } from './collect.mjs';

const MATCH_CONTEXT = 60;
const FALLBACK_TITLE_LIMIT = 40;
const PR_NUMBER_RE = /\/pull\/(\d+)$/;

export function findSession(files, sessionId) {
  for (const st of files.values()) if (st.kind === 'main' && st.sessionId === sessionId) return st;
  return null;
}

// Hand off の立ち上げ先。作業していた cwd (worktree など) が残っていればそこ、なければ始めた cwd
export function handoffCwd(st, exists = fs.existsSync) {
  if (st.cwd && exists(st.cwd)) return st.cwd;
  if (st.startCwd && exists(st.startCwd)) return st.startCwd;
  return null;
}

function titleOf(st, repo) {
  if (st.title) return st.title;
  const head = (st.firstPrompt ?? '').replace(/\s+/g, ' ').trim().slice(0, FALLBACK_TITLE_LIMIT);
  return [repo, head].filter(Boolean).join(' · ') || 'Claude Code';
}

function prsOf(st, prInfo) {
  return [...st.prs.keys()].map((url) => {
    const info = prInfo(url);
    return { url, number: Number(url.match(PR_NUMBER_RE)?.[1]) || null, title: info?.title ?? null, state: info?.state ?? null };
  });
}

// 依頼文のうち、最初に検索語が当たったところの前後を切り出す
function matchOf(st, terms) {
  if (!terms.length) return null;
  for (let i = st.promptTexts.length - 1; i >= 0; i--) {
    const text = st.promptTexts[i];
    const lower = text.toLowerCase();
    for (const term of terms) {
      const at = lower.indexOf(term);
      if (at === -1) continue;
      const from = Math.max(0, at - MATCH_CONTEXT);
      const to = Math.min(text.length, at + term.length + MATCH_CONTEXT);
      const body = text.slice(from, to).replace(/\s+/g, ' ');
      return `${from > 0 ? '…' : ''}${body}${to < text.length ? '…' : ''}`;
    }
  }
  return null;
}

export function listEnded({ files, runningIds, prInfo, q = '', exists = fs.existsSync, limit = 100 }) {
  const terms = String(q).toLowerCase().split(/\s+/u).filter(Boolean);
  const rows = [];
  for (const st of files.values()) {
    if (st.kind !== 'main' || !st.promptTexts.length || runningIds.has(st.sessionId)) continue;
    const { repo, worktree } = describeCwd(st.cwd ?? st.startCwd);
    const prs = prsOf(st, prInfo);
    const title = titleOf(st, repo);
    if (terms.length) {
      const hay = [title, ...st.promptTexts, repo, worktree, st.branch, st.cwd, st.startCwd, ...prs.flatMap((p) => [p.url, p.number && `#${p.number}`, p.title])]
        .filter(Boolean)
        .join('\n')
        .toLowerCase();
      if (!terms.every((t) => hay.includes(t))) continue;
    }
    rows.push({ st, title, repo, worktree, prs });
  }
  rows.sort((a, b) => (b.st.lastTs ?? 0) - (a.st.lastTs ?? 0));
  return rows.slice(0, limit).map(({ st, title, repo, worktree, prs }) => ({
    id: st.sessionId,
    title,
    repo,
    worktree,
    branch: st.branch,
    cwd: st.cwd ?? st.startCwd,
    lastActivityAt: st.lastTs,
    firstPrompt: st.firstPrompt,
    lastPrompt: st.lastPrompt,
    lastReply: st.lastReply,
    contextTokens: st.contextTokens,
    prs,
    match: matchOf(st, terms),
    resumable: Boolean(st.startCwd && exists(st.startCwd)),
    handoffCwd: handoffCwd(st, exists),
  }));
}
