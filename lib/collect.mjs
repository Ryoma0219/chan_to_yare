// 稼働中の Claude Code セッションを集めて、画面に渡すスナップショットを作る。
//
// 情報源
//   ~/.claude/sessions/<pid>.json   Claude Code 自身が書く状態 (busy / shell / idle / waiting)
//   ~/.claude/projects/*/<sid>.jsonl 会話ログ (タイトル・最後の依頼と返答・ターンの時刻)
//   ps eww                          各プロセスの端末の識別子 (CMUX_SURFACE_ID、TMUX_PANE など。lib/terminals/)
//   端末の CLI                       タブとワークスペースの名前 (cmux tree、tmux list-panes)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { Transcript } from './transcript.mjs';
import { BACKENDS, envKeys, readEnvs, identify, identifyAll, sameTty, chooseLauncher, readConfig, appForTermProgram } from './terminals/index.mjs';

const HOME = os.homedir();
const SESSIONS_DIR = path.join(HOME, '.claude', 'sessions');
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');

export const DORMANT_AFTER_MS = 12 * 60 * 60 * 1000;
const TABS_TTL_MS = 4000;

function defaultRun(cmd, args, timeout = 3000) {
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
  constructor({ run = defaultRun, backends = BACKENDS } = {}) {
    this.run = run;
    this.backends = backends;
    this.transcripts = new Map(); // sessionId -> Transcript
    this.fileBySession = new Map(); // sessionId -> path | null
    this.refsByPid = new Map(); // `${pid}:${startedAt}` -> [{ backend, key, tty }] (優先順の候補)
    this.tabs = { byBackend: new Map(), fetchedAt: 0 }; // backend id -> Map(key -> tab)
    this.candidates = []; // 動いているセッションの候補すべて (タブの一覧を取る対象)
    this.liveRefs = []; // タブと突き合わせて決まったもの (新しいタブを開く端末を選ぶのに使う)
  }

  #backend(id) {
    return this.backends.find((b) => b.id === id) ?? null;
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

  async #resolveRefs(records) {
    const missing = records.filter((r) => !this.refsByPid.has(`${r.pid}:${r.startedAt}`));
    if (!missing.length) return;
    const envs = await readEnvs(this.run, missing.map((r) => r.pid), envKeys(this.backends));
    if (envs == null) return;
    for (const r of missing) {
      const found = envs.get(r.pid);
      if (found) this.refsByPid.set(`${r.pid}:${r.startedAt}`, identifyAll(found.env, found.tty, this.backends));
    }
  }

  // 失敗した端末は前回の一覧を残す
  async #refreshTabs(force = false) {
    if (!force && Date.now() - this.tabs.fetchedAt < TABS_TTL_MS) return;
    this.tabs.fetchedAt = Date.now();
    await Promise.all(
      this.backends.map(async (b) => {
        if (!b.available()) return;
        const keys = this.candidates.filter((r) => r.backend === b.id).map((r) => r.key);
        const tabs = await b.listTabs(this.run, keys);
        if (tabs) this.tabs.byBackend.set(b.id, tabs);
      }),
    );
  }

  // 端末に渡すのは、いまの一覧に実在するタブだけ
  #tabFor(ref) {
    if (!ref) return null;
    const backend = this.#backend(ref.backend);
    const tab = this.tabs.byBackend.get(ref.backend)?.get(ref.key);
    return backend && tab && sameTty(ref, tab) ? { backend, tab, ref } : null;
  }

  // 候補のうち、一覧に実在して tty も合う最初のもの
  #found(record) {
    for (const ref of this.refsByPid.get(`${record.pid}:${record.startedAt}`) ?? []) {
      const found = this.#tabFor(ref);
      if (found) return found;
    }
    return null;
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

    await this.#resolveRefs(records);
    this.candidates = records.flatMap((r) => this.refsByPid.get(`${r.pid}:${r.startedAt}`) ?? []);
    await this.#refreshTabs();
    this.liveRefs = records.map((r) => this.#found(r)?.ref).filter(Boolean);

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

      const found = this.#found(r);
      const surface = found?.tab ?? null;
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
        tab: found
          ? {
              terminal: found.backend.id,
              label: found.backend.label,
              title: stripTitleGlyph(surface.title),
              workspace: surface.group,
              can: { focus: found.backend.can.focus, send: found.backend.can.send },
            }
          : null,
      };
    });

    // 終了したセッションのキャッシュを捨てる
    for (const id of this.transcripts.keys()) {
      if (!liveSessionIds.has(id)) this.transcripts.delete(id);
    }

    const terminals = this.backends.filter((b) => b.available()).map((b) => ({ id: b.id, label: b.label }));
    return { now, sessions, terminals };
  }

  // Resume / Hand off / Improve Claude を開く端末 (lib/terminals/index.mjs の chooseLauncher)
  launcher(config = readConfig()) {
    return chooseLauncher({ config, refs: this.liveRefs, backends: this.backends });
  }

  async #locate(sessionId, need) {
    await this.#refreshTabs();
    const record = this.#liveRecord(sessionId);
    if (!record) return { reason: 'session-not-found' };
    const found = this.#found(record);
    if (!found) return { reason: 'tab-not-found', record };
    if (!found.backend.can[need]) return { reason: 'not-supported', record };
    return { record, ...found };
  }

  // テキストをそのセッションへの依頼として送る。改行で送信しない形で貼ってから Enter を押す
  async sendMemo(sessionId, text) {
    const { record, backend, tab, reason } = await this.#locate(sessionId, 'send');
    if (!tab) return { ok: false, reason };
    // 許可ダイアログに文字を打つと選択肢を選んでしまうので、確認待ちのセッションには送らない
    if (record.status === 'waiting') return { ok: false, reason: 'session-waiting' };
    return this.#paste(backend, tab, text, record);
  }

  // 作業中のセッションに送ると、貼り付けから Enter までの間に許可ダイアログが出ることがある。
  // そのまま Enter を押すと既定の選択肢 (多くは許可) を確定してしまうので、
  // 貼り付けの直前と Enter の直前に、状態を読み直して確認待ちなら止める
  #nowWaiting(record) {
    if (!record) return false;
    return readJson(path.join(SESSIONS_DIR, `${record.pid}.json`))?.status === 'waiting';
  }

  async #paste(backend, tab, text, record = null) {
    if (this.#nowWaiting(record)) return { ok: false, reason: 'session-waiting' };
    if (!(await backend.paste(this.run, tab, text))) return { ok: false, reason: 'terminal-failed' };
    await new Promise((r) => setTimeout(r, 250));
    if (this.#nowWaiting(record)) return { ok: false, reason: 'session-waiting-after-paste' };
    return (await backend.pressEnter(this.run, tab)) ? { ok: true } : { ok: false, reason: 'terminal-failed' };
  }

  // /exit を送り、プロセスが終わったのを確かめる。タブは閉じない
  // (2026-11-27、CLI から close-workspace した直後に cmux 本体が落ち、全セッションが消えた)。
  // 作業中に送ると /exit がキューに入り、ターンの終わりに勝手に終了するので断る
  async exitSession(sessionId) {
    const { record, backend, tab, reason } = await this.#locate(sessionId, 'send');
    if (!tab) return { ok: false, reason };
    if (record.status === 'waiting') return { ok: false, reason: 'session-waiting' };
    if (record.status === 'busy' || record.status === 'shell') return { ok: false, reason: 'session-busy' };
    const sent = await this.#paste(backend, tab, '/exit');
    if (!sent.ok) return sent;
    const deadline = Date.now() + 5000;
    while (isAlive(record.pid)) {
      if (Date.now() > deadline) return { ok: false, reason: 'exit-timeout' };
      await new Promise((r) => setTimeout(r, 200));
    }
    return { ok: true };
  }

  // 改善要望に添える、そのセッションの文脈。値はすべてサーバー側で引く
  sessionContext(sessionId) {
    const record = this.#liveRecord(sessionId);
    if (!record) return null;
    const transcript = this.#findTranscript(sessionId, record.cwd);
    const s = this.transcripts.get(sessionId)?.state;
    const cwd = s?.cwd ?? record.cwd;
    const surface = this.#found(record)?.tab;
    const title = s?.aiTitle || stripTitleGlyph(surface?.title) || describeCwd(cwd).repo || 'Claude Code';
    return { title, cwd, transcript };
  }

  // いま動いているセッションの ID。種類 (interactive / sdk) を問わない (二重 resume を防ぐため)
  runningIds() {
    let files = [];
    try {
      files = fs.readdirSync(SESSIONS_DIR).filter((f) => /^\d+\.json$/.test(f));
    } catch {
      return new Set();
    }
    const ids = new Set();
    for (const f of files) {
      const r = readJson(path.join(SESSIONS_DIR, f));
      if (r?.sessionId && r.pid && isAlive(r.pid)) ids.add(r.sessionId);
    }
    return ids;
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
    const { backend, tab, reason } = await this.#locate(sessionId, 'focus');
    if (!tab) return { ok: false, reason };
    const res = await backend.focus(this.run, tab);
    const ok = res === true || res?.ok === true;
    if (ok && res?.hostPid) await this.#focusHost(res.hostPid, backend.id);
    return ok ? { ok: true } : { ok: false, reason: 'terminal-failed' };
  }

  // tmux のクライアントがいる端末を前に出す。cmux のタブならそこへ移り、
  // そうでなければ TERM_PROGRAM から分かる端末アプリを開く
  async #focusHost(pid, innerId) {
    const outer = this.backends.filter((b) => b.id !== innerId && b.available());
    const envs = await readEnvs(this.run, [pid], [...envKeys(outer), 'TERM_PROGRAM']);
    const env = envs?.get(pid)?.env;
    if (!env) return;
    const ref = identify(env, outer);
    if (ref) {
      await this.#refreshTabs(true);
      const found = this.#tabFor(ref);
      if (found?.backend.can.focus) {
        await found.backend.focus(this.run, found.tab);
        return;
      }
    }
    const app = appForTermProgram(env.TERM_PROGRAM);
    if (app) await this.run('open', ['-a', app]);
  }
}
