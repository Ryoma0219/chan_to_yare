// 稼働中の Claude Code セッションを集めて、画面に渡すスナップショットを作る。
//
// 情報源
//   ~/.claude/sessions/<pid>.json   Claude Code 自身が書く状態 (busy / shell / idle / waiting)
//   ~/.claude/projects/*/<sid>.jsonl 会話ログ (タイトル・最後の依頼と返答・ターンの時刻)
//   ps eww                          各プロセスの CMUX_SURFACE_ID (どの cmux タブか)
//   cmux tree --json                タブとワークスペースの名前

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { Transcript } from './transcript.mjs';

const HOME = os.homedir();
const SESSIONS_DIR = path.join(HOME, '.claude', 'sessions');
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
export const CMUX_BIN = process.env.CMUX_BIN || '/Applications/cmux.app/Contents/Resources/bin/cmux';

export const DORMANT_AFTER_MS = 12 * 60 * 60 * 1000;
const UUID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

function run(cmd, args, timeout = 3000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// 先頭に Claude Code / cmux フックが付ける状態記号 (✳ ◐ ● など) を外す
export function stripTitleGlyph(title) {
  if (!title) return title;
  return title.replace(/^(?:[^\p{L}\p{N}\s#]\s*)+/u, '').trim();
}

// cwd から「リポジトリ名」と「worktree 名」を取り出す
// git のルートまで遡ってリポジトリ名を決める (サブディレクトリで作業していても同じ名前になるように)
const repoRootCache = new Map();
function repoRoot(dir) {
  if (repoRootCache.has(dir)) return repoRootCache.get(dir);
  let cur = dir;
  let found = null;
  while (cur && cur !== HOME && cur !== path.dirname(cur)) {
    if (fs.existsSync(path.join(cur, '.git'))) {
      found = cur;
      break;
    }
    cur = path.dirname(cur);
  }
  repoRootCache.set(dir, found);
  return found;
}

export function describeCwd(cwd) {
  if (!cwd) return { repo: null, worktree: null };
  const wt = cwd.match(/^(.*?)\/\.claude\/worktrees\/([^/]+)/);
  if (wt) return { repo: path.basename(wt[1]), worktree: wt[2] };
  const root = repoRoot(cwd);
  if (root) return { repo: path.basename(root), worktree: null };
  const rel = cwd.startsWith(HOME) ? cwd.slice(HOME.length + 1) : cwd;
  const parts = rel.split('/').filter(Boolean);
  // git 管理外: ~/<置き場>/<プロジェクト>/... とみなし、2階層目を名前にする
  return { repo: parts[1] ?? parts[0] ?? '~', worktree: null };
}

export class Collector {
  constructor() {
    this.transcripts = new Map(); // sessionId -> Transcript
    this.fileBySession = new Map(); // sessionId -> path | null
    this.surfaceByPid = new Map(); // `${pid}:${startedAt}` -> surfaceId | null
    this.cmux = { surfaces: new Map(), fetchedAt: 0 };
  }

  #findTranscript(sessionId, cwd) {
    const cached = this.fileBySession.get(sessionId);
    if (cached && fs.existsSync(cached)) return cached;
    // cwd から推測できるディレクトリを先に見る
    const guess = cwd ? path.join(PROJECTS_DIR, cwd.replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`) : null;
    if (guess && fs.existsSync(guess)) {
      this.fileBySession.set(sessionId, guess);
      return guess;
    }
    let dirs = [];
    try {
      dirs = fs.readdirSync(PROJECTS_DIR);
    } catch {
      return null;
    }
    for (const d of dirs) {
      const p = path.join(PROJECTS_DIR, d, `${sessionId}.jsonl`);
      if (fs.existsSync(p)) {
        this.fileBySession.set(sessionId, p);
        return p;
      }
    }
    return null;
  }

  async #resolveSurfaces(records) {
    const missing = records.filter((r) => !this.surfaceByPid.has(`${r.pid}:${r.startedAt}`));
    if (!missing.length) return;
    const out = await run('ps', ['eww', '-o', 'pid=,command=', '-p', missing.map((r) => r.pid).join(',')]);
    if (out == null) return;
    const found = new Map();
    for (const line of out.split('\n')) {
      const pid = line.match(/^\s*(\d+)\s/)?.[1];
      if (!pid) continue;
      // 環境変数のうち CMUX_SURFACE_ID だけを取り出す。それ以外は保持しない
      const sf = line.match(/\bCMUX_SURFACE_ID=([0-9A-Fa-f-]{36})\b/)?.[1] ?? null;
      found.set(Number(pid), sf);
    }
    for (const r of missing) {
      if (found.has(r.pid)) this.surfaceByPid.set(`${r.pid}:${r.startedAt}`, found.get(r.pid));
    }
  }

  async #refreshCmux() {
    if (Date.now() - this.cmux.fetchedAt < 4000) return;
    this.cmux.fetchedAt = Date.now();
    if (!fs.existsSync(CMUX_BIN)) return;
    const out = await run(CMUX_BIN, ['--id-format', 'both', 'tree', '--all', '--json']);
    if (out == null) return;
    let tree;
    try {
      tree = JSON.parse(out);
    } catch {
      return;
    }
    const surfaces = new Map();
    for (const win of tree.windows ?? []) {
      for (const ws of win.workspaces ?? []) {
        for (const pane of ws.panes ?? []) {
          for (const sf of pane.surfaces ?? []) {
            if (!sf.id) continue;
            surfaces.set(sf.id.toUpperCase(), {
              id: sf.id,
              title: sf.title ?? null,
              workspaceId: ws.id ?? null,
              workspaceTitle: ws.title ?? null,
              selected: Boolean(sf.selected && ws.selected),
            });
          }
        }
      }
    }
    this.cmux.surfaces = surfaces;
  }

  surfaceFor(surfaceId) {
    if (!surfaceId || !UUID_RE.test(surfaceId)) return null;
    return this.cmux.surfaces.get(surfaceId.toUpperCase()) ?? null;
  }

  async snapshot() {
    const now = Date.now();
    let files = [];
    try {
      files = fs.readdirSync(SESSIONS_DIR).filter((f) => /^\d+\.json$/.test(f));
    } catch {
      return { now, sessions: [], error: 'sessions-unreadable' };
    }

    const records = files
      .map((f) => readJson(path.join(SESSIONS_DIR, f)))
      .filter((r) => r && r.pid && r.sessionId && r.kind === 'interactive' && isAlive(r.pid));

    await Promise.all([this.#resolveSurfaces(records), this.#refreshCmux()]);

    const liveSessionIds = new Set();
    const sessions = records.map((r) => {
      liveSessionIds.add(r.sessionId);
      const file = this.#findTranscript(r.sessionId, r.cwd);
      let t = this.transcripts.get(r.sessionId);
      if (file && (!t || t.file !== file)) {
        t = new Transcript(file);
        this.transcripts.set(r.sessionId, t);
      }
      t?.update();
      const s = t?.state;

      const surfaceId = this.surfaceByPid.get(`${r.pid}:${r.startedAt}`) ?? null;
      const surface = this.surfaceFor(surfaceId);
      const cwd = s?.cwd ?? r.cwd;
      const { repo, worktree } = describeCwd(cwd);

      // 最後に動きがあった時刻。サブエージェントは別ファイルに書くので、その更新も見る
      let lastActivityAt = s?.lastActivityAt ?? null;
      if (file) {
        const subDir = file.replace(/\.jsonl$/, '/subagents');
        try {
          for (const f of fs.readdirSync(subDir)) {
            const m = fs.statSync(path.join(subDir, f)).mtimeMs;
            if (m > (lastActivityAt ?? 0)) lastActivityAt = m;
          }
        } catch {}
      }

      const turnOpen = s?.lastPromptAt && (!s.lastTurnEndAt || s.lastPromptAt > s.lastTurnEndAt);
      const idleSince = Math.max(s?.lastTurnEndAt ?? 0, s?.lastReplyAt ?? 0) || r.statusUpdatedAt || r.startedAt;

      let state;
      let since;
      switch (r.status) {
        case 'waiting':
          state = 'ask';
          since = r.statusUpdatedAt ?? now;
          break;
        case 'busy':
        case 'shell':
          state = 'work';
          since = (turnOpen ? s.lastPromptAt : null) ?? r.statusUpdatedAt ?? now;
          break;
        default:
          if (!s?.lastPromptAt && !s?.lastReplyAt) {
            state = 'fresh';
            since = r.startedAt;
          } else {
            state = now - idleSince > DORMANT_AFTER_MS ? 'dormant' : 'reply';
            since = idleSince;
          }
      }


      const turns = (s?.turns ?? []).map((x) => [x.start, x.end]);
      if (state === 'work' && turnOpen) turns.push([s.lastPromptAt, null]);

      return {
        id: r.sessionId,
        pid: r.pid,
        name: r.name ?? null,
        state,
        rawStatus: r.status ?? null,
        waitingFor: r.waitingFor ?? null,
        since,
        lastActivityAt: state === 'work' ? lastActivityAt : null,
        pendingTool: state === 'work' || state === 'ask' ? (s?.pendingTool ?? null) : null,
        title: s?.aiTitle || stripTitleGlyph(surface?.title) || repo || 'Claude Code',
        repo,
        worktree,
        branch: s?.branch ?? null,
        cwd,
        prs: s ? [...s.prs.values()].slice(-3) : [],
        lastPrompt: s?.lastPrompt ?? null,
        lastPromptAt: s?.lastPromptAt ?? null,
        lastReply: s?.lastReply ?? null,
        lastReplyAt: s?.lastReplyAt ?? null,
        turns,
        costUSD: s?.costUSD ?? null,
        tab: surface
          ? { surfaceId: surface.id, title: stripTitleGlyph(surface.title), workspace: surface.workspaceTitle }
          : null,
      };
    });

    // 終了したセッションのキャッシュを捨てる
    for (const id of this.transcripts.keys()) {
      if (!liveSessionIds.has(id)) this.transcripts.delete(id);
    }

    return { now, sessions, cmux: this.cmux.surfaces.size > 0 };
  }

  async #locate(sessionId) {
    await this.#refreshCmux();
    const record = this.#liveRecord(sessionId);
    if (!record) return { reason: 'session-not-found' };
    const surface = this.surfaceFor(this.surfaceByPid.get(`${record.pid}:${record.startedAt}`));
    if (!surface) return { reason: 'tab-not-found', record };
    return { record, surface };
  }

  // テキストをそのセッションへの依頼として送る。
  // cmux send は \n を Enter と解釈するので使わず、バッファ経由で貼り付けてから Enter を押す。
  async sendMemo(sessionId, text) {
    const { record, surface, reason } = await this.#locate(sessionId);
    if (!surface) return { ok: false, reason };
    // 許可ダイアログに文字を打つと選択肢を選んでしまうので、確認待ちのセッションには送らない
    if (record.status === 'waiting') return { ok: false, reason: 'session-waiting' };
    return this.#paste(surface, text);
  }

  #workspaceArgs(surface) {
    return surface.workspaceId && UUID_RE.test(surface.workspaceId) ? ['--workspace', surface.workspaceId] : [];
  }

  async #paste(surface, text) {
    const ws = this.#workspaceArgs(surface);
    const buffer = `ccd-${process.pid}-${Date.now().toString(36)}`;
    if ((await run(CMUX_BIN, ['set-buffer', '--name', buffer, '--', text])) == null) return { ok: false, reason: 'cmux-failed' };
    if ((await run(CMUX_BIN, ['paste-buffer', '--name', buffer, ...ws, '--surface', surface.id])) == null) {
      return { ok: false, reason: 'cmux-failed' };
    }
    await new Promise((r) => setTimeout(r, 250));
    const out = await run(CMUX_BIN, ['send-key', ...ws, '--surface', surface.id, 'enter']);
    return out == null ? { ok: false, reason: 'cmux-failed' } : { ok: true };
  }

  // /exit を送り、プロセスが終わったのを確かめてからタブを閉じる。
  // 作業中に送ると /exit がキューに入り、ターンの終わりに勝手に終了するので断る
  async exitSession(sessionId) {
    const { record, surface, reason } = await this.#locate(sessionId);
    if (!surface) return { ok: false, reason };
    if (record.status === 'waiting') return { ok: false, reason: 'session-waiting' };
    if (record.status === 'busy' || record.status === 'shell') return { ok: false, reason: 'session-busy' };
    const sent = await this.#paste(surface, '/exit');
    if (!sent.ok) return sent;
    const deadline = Date.now() + 5000;
    while (isAlive(record.pid)) {
      if (Date.now() > deadline) return { ok: false, reason: 'exit-timeout' };
      await new Promise((r) => setTimeout(r, 200));
    }
    const out = await run(CMUX_BIN, ['close-surface', '--surface', surface.id, ...this.#workspaceArgs(surface)]);
    return out == null ? { ok: false, reason: 'cmux-failed' } : { ok: true };
  }

  // 改善要望に添える、そのセッションの文脈。値はすべてサーバー側で引く
  sessionContext(sessionId) {
    const record = this.#liveRecord(sessionId);
    if (!record) return null;
    const transcript = this.#findTranscript(sessionId, record.cwd);
    const s = this.transcripts.get(sessionId)?.state;
    const cwd = s?.cwd ?? record.cwd;
    const surface = this.surfaceFor(this.surfaceByPid.get(`${record.pid}:${record.startedAt}`));
    const title = s?.aiTitle || stripTitleGlyph(surface?.title) || describeCwd(cwd).repo || 'Claude Code';
    return { title, cwd, transcript };
  }

  #liveRecord(sessionId) {
    let files = [];
    try {
      files = fs.readdirSync(SESSIONS_DIR).filter((f) => /^\d+\.json$/.test(f));
    } catch {
      return null;
    }
    return files.map((f) => readJson(path.join(SESSIONS_DIR, f))).find((r) => r?.sessionId === sessionId && isAlive(r.pid)) ?? null;
  }

  async focus(sessionId) {
    const { surface, reason } = await this.#locate(sessionId);
    if (!surface) return { ok: false, reason };
    if (surface.workspaceId && UUID_RE.test(surface.workspaceId)) {
      await run(CMUX_BIN, ['select-workspace', '--workspace', surface.workspaceId]);
    }
    const args = ['focus-panel', '--panel', surface.id];
    if (surface.workspaceId && UUID_RE.test(surface.workspaceId)) args.push('--workspace', surface.workspaceId);
    const out = await run(CMUX_BIN, args);
    await run('open', ['-a', 'cmux']);
    return out == null ? { ok: false, reason: 'cmux-failed' } : { ok: true };
  }
}
