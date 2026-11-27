// Claude Code の会話ログ (~/.claude/projects/*/<sessionId>.jsonl) を差分で読み、
// ダッシュボードに必要な要約だけを保持する。
//
// ログは数十MBになることがあるため、初回は末尾 INITIAL_TAIL_BYTES だけ読み、
// 以降は前回の読み終わり位置から追記分だけを読む。

import fs from 'node:fs';

const INITIAL_TAIL_BYTES = 4 * 1024 * 1024;
const INITIAL_SCAN_LIMIT_BYTES = 32 * 1024 * 1024;
const TURN_RETENTION_MS = 26 * 60 * 60 * 1000;
const TEXT_LIMIT = 1200;

// 人間の入力として扱わない、Claude Code が差し込む user エントリの書き出し
const NON_HUMAN_PREFIXES = [
  '<local-command',
  '<command-',
  '<system-reminder',
  '<task-notification',
  '<agent-message',
  '<channel',
  'Another Claude session sent a message',
  '<bash-',
  '<user-prompt-submit-hook',
  'Caveat:',
  '[Request interrupted',
];

// 会話ログの pr-link の URL はそのままリンクになるので、GitHub の PR の形だけを通す
const PR_URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/;
export function isPrUrl(url) {
  return typeof url === 'string' && PR_URL_RE.test(url);
}

function clip(text) {
  const t = text.replace(/\r/g, '').trim();
  return t.length > TEXT_LIMIT ? `${t.slice(0, TEXT_LIMIT)}…` : t;
}

export function humanPromptText(entry) {
  if (entry.type !== 'user' || entry.isMeta || entry.isSidechain) return null;
  if (entry.toolUseResult != null) return null;
  const c = entry.message?.content;
  let text = null;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    if (c.some((p) => p?.type === 'tool_result')) return null;
    text = c
      .filter((p) => p?.type === 'text')
      .map((p) => p.text)
      .join('\n');
  }
  if (!text) return null;
  const head = text.trimStart();
  if (NON_HUMAN_PREFIXES.some((p) => head.startsWith(p))) return null;
  return text;
}

function assistantText(entry) {
  if (entry.type !== 'assistant' || entry.isSidechain) return null;
  const c = entry.message?.content;
  if (!Array.isArray(c)) return null;
  const text = c
    .filter((p) => p?.type === 'text' && p.text)
    .map((p) => p.text)
    .join('\n');
  return text || null;
}

function pendingToolName(entry) {
  if (entry.type !== 'assistant' || entry.isSidechain) return null;
  const c = entry.message?.content;
  if (!Array.isArray(c)) return null;
  const tools = c.filter((p) => p?.type === 'tool_use');
  return tools.length ? tools[tools.length - 1].name : null;
}

export class Transcript {
  constructor(file) {
    this.file = file;
    this.offset = 0;
    this.remainder = '';
    this.state = {
      aiTitle: null,
      lastPrompt: null,
      lastPromptAt: null,
      lastReply: null,
      lastReplyAt: null,
      lastActivityAt: null,
      lastTurnEndAt: null,
      pendingTool: null,
      branch: null,
      cwd: null,
      prs: new Map(),
      turns: [],
      costUSD: null,
    };
  }

  // 追記分を読む。変化があれば true を返す。
  update() {
    let stat;
    try {
      stat = fs.statSync(this.file);
    } catch {
      return false;
    }
    if (stat.size < this.offset) {
      // 切り詰められた (通常は起きない)。最初から読み直す
      this.offset = 0;
      this.remainder = '';
    }
    if (stat.size === this.offset) return false;

    let start = this.offset;
    if (start === 0 && stat.size > INITIAL_TAIL_BYTES) start = this.#initialStart(stat.size);
    const skipFirstLine = start > 0 && this.offset === 0;
    const length = stat.size - start;
    const buf = Buffer.alloc(length);
    const fd = fs.openSync(this.file, 'r');
    try {
      fs.readSync(fd, buf, 0, length, start);
    } finally {
      fs.closeSync(fd);
    }
    this.offset = stat.size;

    let chunk = this.remainder + buf.toString('utf8');
    if (skipFirstLine) chunk = chunk.slice(chunk.indexOf('\n') + 1);
    const lines = chunk.split('\n');
    this.remainder = lines.pop() ?? '';
    for (const line of lines) {
      if (!line) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      this.#apply(entry);
    }
    this.#pruneTurns();
    return true;
  }

  // 初回の読み始め位置。末尾から4MBずつ遡り、人間の依頼が1件見つかったところで止める
  // (スクリーンショットなどでログが膨らむと、最後の依頼が末尾4MBに入らないことがある)
  #initialStart(size) {
    const fd = fs.openSync(this.file, 'r');
    try {
      let start = size;
      while (start > 0 && size - start < INITIAL_SCAN_LIMIT_BYTES) {
        const from = Math.max(0, start - INITIAL_TAIL_BYTES);
        const buf = Buffer.alloc(start - from);
        fs.readSync(fd, buf, 0, buf.length, from);
        start = from;
        for (const line of buf.toString('utf8').split('\n')) {
          if (!line.includes('"type":"user"')) continue;
          try {
            if (humanPromptText(JSON.parse(line)) != null) return start;
          } catch {}
        }
      }
      return start;
    } finally {
      fs.closeSync(fd);
    }
  }

  #apply(e) {
    const s = this.state;
    const ts = e.timestamp ? Date.parse(e.timestamp) : null;

    switch (e.type) {
      case 'ai-title':
        if (e.aiTitle) s.aiTitle = e.aiTitle;
        return;
      case 'pr-link':
        if (isPrUrl(e.prUrl)) s.prs.set(e.prUrl, { number: e.prNumber, url: e.prUrl, repo: e.prRepository });
        return;
      case 'cost-state':
        if (typeof e.totalCostUSD === 'number') s.costUSD = e.totalCostUSD;
        return;
      default:
        break;
    }

    if (e.isSidechain) return;
    if (e.gitBranch) s.branch = e.gitBranch;
    if (e.cwd) s.cwd = e.cwd;

    if (e.type === 'system' && e.subtype === 'turn_duration' && ts) {
      const start = ts - (e.durationMs ?? 0);
      s.turns.push({ start, end: ts });
      s.lastTurnEndAt = ts;
      s.pendingTool = null;
      return;
    }

    if (e.type !== 'user' && e.type !== 'assistant') return;
    if (ts && !e.isMeta) s.lastActivityAt = Math.max(s.lastActivityAt ?? 0, ts);

    const prompt = humanPromptText(e);
    if (prompt != null) {
      s.lastPrompt = clip(prompt);
      s.lastPromptAt = ts;
      s.pendingTool = null;
      return;
    }

    if (e.type === 'user') {
      // tool_result が返ってきた = 直前のツール呼び出しは終わった
      s.pendingTool = null;
      return;
    }

    const tool = pendingToolName(e);
    if (tool) s.pendingTool = tool;
    const reply = assistantText(e);
    if (reply) {
      s.lastReply = clip(reply);
      s.lastReplyAt = ts;
    }
  }

  #pruneTurns() {
    const cutoff = Date.now() - TURN_RETENTION_MS;
    const turns = this.state.turns;
    let i = 0;
    while (i < turns.length && turns[i].end < cutoff) i++;
    if (i) turns.splice(0, i);
  }
}
