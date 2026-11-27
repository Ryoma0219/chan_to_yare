// 直近7日間の会話ログを集計する。
//
// ~/.claude/projects/*/<sid>.jsonl (本体) と <sid>/subagents/*.jsonl (サブエージェント) を読む。
// 初回は各ファイルを先頭から読み、以降は前回の位置から追記分だけを読む。
// JSON.parse するのは集計に使う行だけにして、ツール結果の大きな行は正規表現で必要な値だけ拾う。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { humanPromptText, isPrUrl } from './transcript.mjs';
import { describeCwd } from './collect.mjs';

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_MS = 31 * DAY_MS; // PR 分析で30日分を使う (7日の集計は from で絞る)
const WAIT_CAP_MS = 12 * 60 * 60 * 1000;
// 時間帯グラフでは1回の待ちを3時間で打ち切る (放置したまま帰った夜が全部「待ち」で埋まらないように)
const PROFILE_WAIT_CAP_MS = 3 * 60 * 60 * 1000;
const SLOT_MS = 15 * 60 * 1000;
const SLOTS = DAY_MS / SLOT_MS;
const CHUNK = 8 * 1024 * 1024;
const MAX_PARSE_LINE = 4 * 1024 * 1024;
const RESCAN_MS = 30 * 1000;

// 入力1トークンを1としたときの重み。cost-state の実績から単価を逆算するのにも使う
const WEIGHT = { input: 1, output: 5, cacheRead: 0.1, cache5m: 1.25, cache1h: 2 };
const FALLBACK_INPUT_PRICE = 3; // $/MTok。実績のないモデル用の控えめな値

const REPLY_BUCKETS = [
  { label: '< 1m', max: 60e3 },
  { label: '1–5m', max: 5 * 60e3 },
  { label: '5–15m', max: 15 * 60e3 },
  { label: '15–60m', max: 60 * 60e3 },
  { label: '1–4h', max: 4 * 60 * 60e3 },
  { label: '4h+', max: Infinity },
];

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const PERMISSION_RE = /"permissionDecision":\{"decision":"(\w+)","source":"(\w+)"/;
const TIMESTAMP_RE = /"timestamp":"([^"]+)"/;
const DECLINED = "doesn't want to proceed with this tool use";

function newFile(file, kind, sessionId) {
  return {
    file,
    kind,
    sessionId,
    offset: 0,
    remainder: '',
    mtimeMs: 0,
    cwd: null,
    lastTs: null,
    pendingWait: null,
    turns: [],
    waits: [],
    prompts: [],
    prs: new Map(),
    hasPR: false, // このセッションのブランチに PR があったか (期間で消さない)
    title: null,
    edits: [], // [ts, file_path] Edit/Write で触ったファイル
    usage: new Map(), // message.id -> [ts, model, weightedTokensByType]
    toolIds: new Set(),
    tools: [],
    skills: [],
    subagents: [],
    perms: [],
    interrupts: [],
  };
}

function tsOf(e) {
  return e.timestamp ? Date.parse(e.timestamp) : null;
}

function applyLine(st, line) {
  if (line.length > MAX_PARSE_LINE && !line.includes('"tool_use_id"')) return;

  // ツール結果: 大きいので parse せずに承認の種類だけ拾う
  if (line.includes('"type":"user"') && line.includes('"tool_use_id"')) {
    const ts = Date.parse(line.match(TIMESTAMP_RE)?.[1] ?? '');
    if (!ts) return;
    st.lastTs = ts;
    const pd = line.match(PERMISSION_RE);
    if (pd) {
      const [, decision, source] = pd;
      const kind = decision === 'reject' ? 'blocked' : source.startsWith('user') ? 'you' : 'auto';
      st.perms.push([ts, kind]);
    } else if (line.includes(DECLINED)) {
      st.perms.push([ts, 'declined']);
    }
    return;
  }

  let e;
  try {
    e = JSON.parse(line);
  } catch {
    return;
  }
  const ts = tsOf(e);
  if (ts) st.lastTs = ts;

  switch (e.type) {
    case 'pr-link':
      if (e.prUrl) st.hasPR = true;
      // 初めて PR が見えた時刻を残す (PR ごとの按分に使う)
      if (isPrUrl(e.prUrl) && ts && !st.prs.has(e.prUrl)) st.prs.set(e.prUrl, ts);
      return;
    case 'ai-title':
      if (e.aiTitle) st.title = e.aiTitle;
      return;
    case 'system':
      if (e.subtype === 'turn_duration' && ts && !e.isSidechain && st.kind === 'main') {
        st.turns.push([ts - (e.durationMs ?? 0), ts]);
        st.pendingWait = ts;
      }
      return;
    case 'user': {
      if (e.isSidechain) return;
      if (e.cwd) st.cwd = e.cwd;
      if (st.kind !== 'main' || !ts) return;
      const text = humanPromptText(e);
      if (text != null) {
        st.prompts.push(ts);
        if (st.pendingWait && ts > st.pendingWait) st.waits.push([st.pendingWait, ts]);
        st.pendingWait = null;
        return;
      }
      const c = e.message?.content;
      const raw = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((p) => p?.type === 'text')?.text ?? '') : '';
      if (raw.startsWith('[Request interrupted by user')) st.interrupts.push(ts);
      return;
    }
    case 'assistant': {
      if (e.cwd && !e.isSidechain) st.cwd = e.cwd;
      const msg = e.message;
      if (!msg || !ts) return;
      const u = msg.usage;
      if (msg.id && u && msg.model && msg.model !== '<synthetic>') {
        const c5 = u.cache_creation?.ephemeral_5m_input_tokens;
        const c1 = u.cache_creation?.ephemeral_1h_input_tokens;
        // 種類ごとの重みを掛けた合計だけを持つ (メモリを抑える)
        const w =
          (u.input_tokens ?? 0) * WEIGHT.input +
          (u.output_tokens ?? 0) * WEIGHT.output +
          (u.cache_read_input_tokens ?? 0) * WEIGHT.cacheRead +
          (c5 ?? (c1 == null ? (u.cache_creation_input_tokens ?? 0) : 0)) * WEIGHT.cache5m +
          (c1 ?? 0) * WEIGHT.cache1h;
        st.usage.set(msg.id, [ts, msg.model, w, u.output_tokens ?? 0]);
      }
      if (Array.isArray(msg.content)) {
        for (const p of msg.content) {
          if (p?.type !== 'tool_use' || !p.name || st.toolIds.has(p.id)) continue;
          st.toolIds.add(p.id);
          st.tools.push([ts, p.name]);
          if (p.name === 'Skill' && p.input?.skill) st.skills.push([ts, String(p.input.skill)]);
          if ((p.name === 'Agent' || p.name === 'Task') && st.kind === 'main') st.subagents.push(ts);
          if (EDIT_TOOLS.has(p.name) && typeof p.input?.file_path === 'string') st.edits.push([ts, p.input.file_path]);
        }
      }
      return;
    }
    default:
      return;
  }
}

function prune(st, cutoff) {
  const keep = (arr, at = (x) => x[0]) => {
    let i = 0;
    while (i < arr.length && at(arr[i]) < cutoff) i++;
    if (i) arr.splice(0, i);
  };
  keep(st.turns, (x) => x[1]);
  keep(st.waits, (x) => x[1]);
  keep(st.prompts, (x) => x);
  keep(st.tools);
  keep(st.skills);
  keep(st.subagents, (x) => x);
  keep(st.perms);
  keep(st.interrupts, (x) => x);
  keep(st.edits);
  for (const [id, v] of st.usage) if (v[0] < cutoff) st.usage.delete(id);
  for (const [url, t] of st.prs) if (t < cutoff) st.prs.delete(url);
  if (st.toolIds.size > 20000) st.toolIds.clear();
}

async function readAppended(st, size) {
  const fh = await fs.promises.open(st.file, 'r');
  try {
    while (st.offset < size) {
      const len = Math.min(CHUNK, size - st.offset);
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, st.offset);
      if (!bytesRead) break;
      st.offset += bytesRead;
      const lines = (st.remainder + buf.toString('utf8', 0, bytesRead)).split('\n');
      st.remainder = lines.pop() ?? '';
      for (const line of lines) if (line) applyLine(st, line);
      await new Promise((r) => setImmediate(r));
    }
  } finally {
    await fh.close();
  }
}

function listFiles(since) {
  const out = [];
  let projects = [];
  try {
    projects = fs.readdirSync(PROJECTS_DIR);
  } catch {
    return out;
  }
  for (const p of projects) {
    const dir = path.join(PROJECTS_DIR, p);
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.isFile() && ent.name.endsWith('.jsonl')) {
        const file = path.join(dir, ent.name);
        const stat = fs.statSync(file, { throwIfNoEntry: false });
        if (stat && stat.mtimeMs >= since) out.push({ file, stat, kind: 'main', sessionId: ent.name.slice(0, -6) });
      } else if (ent.isDirectory()) {
        const sub = path.join(dir, ent.name, 'subagents');
        let subs = [];
        try {
          subs = fs.readdirSync(sub);
        } catch {
          continue;
        }
        for (const f of subs) {
          if (!f.endsWith('.jsonl')) continue;
          const file = path.join(sub, f);
          const stat = fs.statSync(file, { throwIfNoEntry: false });
          if (stat && stat.mtimeMs >= since) out.push({ file, stat, kind: 'sub', sessionId: ent.name });
        }
      }
    }
  }
  return out;
}

// cost-state の実績から、モデルごとの入力単価 ($/token) を逆算する
async function calibratePrices(files) {
  const totals = new Map();
  const seen = new Set();
  for (const { file } of files) {
    let text;
    try {
      text = await fs.promises.readFile(file, 'utf8');
    } catch {
      continue;
    }
    let idx = text.indexOf('"type":"cost-state"');
    while (idx !== -1) {
      const start = text.lastIndexOf('\n', idx) + 1;
      const end = text.indexOf('\n', idx);
      try {
        const o = JSON.parse(text.slice(start, end === -1 ? undefined : end));
        const key = `${o.sessionId}:${o.startTime}:${o.totalCostUSD}`;
        if (!seen.has(key)) {
          seen.add(key);
          for (const [model, v] of Object.entries(o.modelUsage ?? {})) {
            if (!v.costUSD) continue;
            const w =
              v.inputTokens * WEIGHT.input +
              v.outputTokens * WEIGHT.output +
              v.cacheReadInputTokens * WEIGHT.cacheRead +
              (v.cacheCreationEphemeral5mInputTokens ?? 0) * WEIGHT.cache5m +
              (v.cacheCreationEphemeral1hInputTokens ?? 0) * WEIGHT.cache1h;
            const t = totals.get(model) ?? { cost: 0, w: 0 };
            t.cost += v.costUSD;
            t.w += w;
            totals.set(model, t);
          }
        }
      } catch {}
      idx = text.indexOf('"type":"cost-state"', end === -1 ? text.length : end);
    }
  }
  const prices = new Map();
  for (const [model, t] of totals) if (t.w > 0) prices.set(model, t.cost / t.w);
  return prices;
}

function localDayStart(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dayKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

export class Analytics {
  constructor() {
    this.files = new Map();
    this.prices = new Map();
    this.pricedAt = 0;
    this.scannedAt = 0;
    this.scanning = null;
    this.result = null;
  }

  async #scan() {
    const now = Date.now();
    const since = now - KEEP_MS;
    const found = listFiles(since);
    const live = new Set();
    for (const { file, stat, kind, sessionId } of found) {
      live.add(file);
      let st = this.files.get(file);
      if (!st || stat.size < st.offset) {
        st = newFile(file, kind, sessionId);
        this.files.set(file, st);
      }
      if (stat.size > st.offset) await readAppended(st, stat.size);
      prune(st, since);
    }
    for (const f of this.files.keys()) if (!live.has(f)) this.files.delete(f);
    if (now - this.pricedAt > 30 * 60 * 1000 || !this.prices.size) {
      this.prices = await calibratePrices(found);
      this.pricedAt = now;
    }
    this.result = this.#aggregate(Date.now());
    this.scannedAt = Date.now();
  }

  // PR 分析用: 走査が済んだファイル状態を返す
  async files30() {
    await this.get();
    if (this.scanning) await this.scanning;
    return this.files;
  }

  async get() {
    if (this.result && Date.now() - this.scannedAt < RESCAN_MS) return this.result;
    if (!this.scanning) {
      this.scanning = this.#scan().finally(() => {
        this.scanning = null;
      });
    }
    if (this.result) return this.result; // 古い結果を返し、裏で更新する
    await this.scanning;
    return this.result;
  }

  priceOf(model) {
    return this.#price(model);
  }

  #price(model) {
    if (this.prices.has(model)) return this.prices.get(model);
    for (const [m, p] of this.prices) if (model.startsWith(m.replace(/-\d+(-\d+)?$/, ''))) return p;
    return FALLBACK_INPUT_PRICE / 1e6;
  }

  #aggregate(now) {
    const from = localDayStart(now) - 6 * DAY_MS;
    const dayStarts = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(from);
      d.setDate(d.getDate() + i);
      return d.getTime();
    });
    const dayIndex = (t) => {
      for (let i = 6; i >= 0; i--) if (t >= dayStarts[i]) return i;
      return -1;
    };
    const days = dayStarts.map((t) => ({
      key: dayKey(t),
      start: t,
      claudeMs: 0,
      costUSD: 0,
      prompts: 0,
      prs: 0,
      replyMedianMs: null,
      working: new Array(SLOTS).fill(0),
      waiting: new Array(SLOTS).fill(0),
    }));

    const addProfile = (key, a, b) => {
      a = Math.max(a, from);
      b = Math.min(b, now);
      while (a < b) {
        const di = dayIndex(a);
        if (di < 0) break;
        const dayEnd = di < 6 ? dayStarts[di + 1] : dayStarts[6] + DAY_MS;
        const slot = Math.floor((a - dayStarts[di]) / SLOT_MS);
        const slotEnd = Math.min(dayStarts[di] + (slot + 1) * SLOT_MS, dayEnd);
        const end = Math.min(b, slotEnd);
        if (slot >= 0 && slot < SLOTS) days[di][key][slot] += (end - a) / SLOT_MS;
        a = end;
      }
    };
    const addPerDay = (field, a, b) => {
      a = Math.max(a, from);
      b = Math.min(b, now);
      while (a < b) {
        const di = dayIndex(a);
        const dayEnd = di < 6 ? dayStarts[di + 1] : Infinity;
        const end = Math.min(b, dayEnd);
        days[di][field] += end - a;
        a = end;
      }
    };

    const repos = new Map();
    const repoOf = (name) => {
      let r = repos.get(name);
      if (!r) {
        r = { repo: name, claudeMs: 0, sessions: 0, prompts: 0, prs: 0, costUSD: 0 };
        repos.set(name, r);
      }
      return r;
    };

    const mainCwd = new Map();
    for (const st of this.files.values()) if (st.kind === 'main' && st.cwd) mainCwd.set(st.sessionId, st.cwd);

    const replies = [];
    const repliesByDay = days.map(() => []);
    const tools = new Map();
    const skills = new Map();
    const models = new Map();
    const perms = { auto: 0, you: 0, blocked: 0, declined: 0 };
    let interrupts = 0;
    let subagents = 0;
    let sessions = 0;
    let prompts = 0;
    let prs = 0;
    // セッション単位の集計。サブエージェントのファイルは親セッションに足す
    const perSession = new Map();
    const sessionOf = (id) => {
      let x = perSession.get(id);
      if (!x) {
        x = { active: false, hasPR: false, claudeMs: 0, prompts: 0, costUSD: 0, replies: [] };
        perSession.set(id, x);
      }
      return x;
    };

    for (const st of this.files.values()) {
      const ss = sessionOf(st.sessionId);
      if (st.kind === 'main' && st.hasPR) ss.hasPR = true;
      const cwd = st.kind === 'main' ? st.cwd : (mainCwd.get(st.sessionId) ?? st.cwd);
      const repoName = describeCwd(cwd).repo ?? 'unknown';
      const r = repoOf(repoName);
      let active = false;

      for (const [a, b] of st.turns) {
        if (b < from) continue;
        active = true;
        const ms = Math.min(b, now) - Math.max(a, from);
        r.claudeMs += ms;
        ss.claudeMs += ms;
        addPerDay('claudeMs', a, b);
        addProfile('working', a, b);
      }
      const waits = st.waits.slice();
      if (st.pendingWait) waits.push([st.pendingWait, null]);
      for (const [a, b] of waits) {
        const end = Math.min(b ?? now, a + WAIT_CAP_MS);
        if (end < from) continue;
        addProfile('waiting', a, Math.min(end, a + PROFILE_WAIT_CAP_MS));
        if (b != null && b >= from) {
          replies.push(b - a);
          ss.replies.push(b - a);
          repliesByDay[dayIndex(b)]?.push(b - a);
        }
      }
      for (const t of st.prompts) {
        if (t < from) continue;
        active = true;
        prompts++;
        r.prompts++;
        ss.prompts++;
        days[dayIndex(t)].prompts++;
      }
      for (const t of st.prs.values()) {
        if (t < from) continue;
        prs++;
        r.prs++;
        days[dayIndex(t)].prs++;
      }
      for (const [t, model, w, out] of st.usage.values()) {
        if (t < from) continue;
        const usd = w * this.#price(model);
        r.costUSD += usd;
        ss.costUSD += usd;
        days[dayIndex(t)].costUSD += usd;
        const m = models.get(model) ?? { model, costUSD: 0, outputTokens: 0 };
        m.costUSD += usd;
        m.outputTokens += out;
        models.set(model, m);
      }
      for (const [t, name] of st.tools) if (t >= from) tools.set(name, (tools.get(name) ?? 0) + 1);
      for (const [t, name] of st.skills) if (t >= from) skills.set(name, (skills.get(name) ?? 0) + 1);
      for (const [t, kind] of st.perms) if (t >= from) perms[kind]++;
      for (const t of st.interrupts) if (t >= from) interrupts++;
      for (const t of st.subagents) if (t >= from) subagents++;
      if (active && st.kind === 'main') {
        ss.active = true;
        sessions++;
        r.sessions++;
      }
    }

    // PR に紐づいたセッションとそれ以外
    const groups = [
      { key: 'pr', sessions: 0, claudeMs: 0, prompts: 0, costUSD: 0, per: { claudeMs: [], prompts: [], costUSD: [] }, replies: [] },
      { key: 'none', sessions: 0, claudeMs: 0, prompts: 0, costUSD: 0, per: { claudeMs: [], prompts: [], costUSD: [] }, replies: [] },
    ];
    for (const x of perSession.values()) {
      if (!x.active) continue;
      const g = groups[x.hasPR ? 0 : 1];
      g.sessions++;
      for (const k of ['claudeMs', 'prompts', 'costUSD']) {
        g[k] += x[k];
        g.per[k].push(x[k]);
      }
      g.replies.push(...x.replies);
    }
    const prSplit = groups.map((g) => {
      const med = (list) => quantile(list.slice().sort((a, b) => a - b), 0.5);
      return {
        key: g.key,
        sessions: g.sessions,
        claudeMs: g.claudeMs,
        prompts: g.prompts,
        costUSD: g.costUSD,
        medianClaudeMs: med(g.per.claudeMs),
        medianPrompts: med(g.per.prompts),
        medianCostUSD: med(g.per.costUSD),
        replyMedianMs: med(g.replies),
      };
    });

    replies.sort((a, b) => a - b);
    repliesByDay.forEach((list, i) => {
      list.sort((a, b) => a - b);
      days[i].replyMedianMs = quantile(list, 0.5);
    });
    const buckets = REPLY_BUCKETS.map((b) => ({ label: b.label, count: 0 }));
    for (const ms of replies) buckets[REPLY_BUCKETS.findIndex((b) => ms < b.max)].count++;

    const top = (map, n) =>
      [...map.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, n);

    const round = (x) => Math.round(x * 1000) / 1000;
    const repoList = [...repos.values()]
      .filter((r) => r.claudeMs > 0 || r.prompts > 0 || r.costUSD > 0.005)
      .sort((a, b) => b.claudeMs - a.claudeMs || b.costUSD - a.costUSD);

    return {
      generatedAt: now,
      from,
      to: now,
      totals: {
        claudeMs: days.reduce((s, d) => s + d.claudeMs, 0),
        sessions,
        prompts,
        prs,
        costUSD: days.reduce((s, d) => s + d.costUSD, 0),
        replyMedianMs: quantile(replies, 0.5),
        replyP75Ms: quantile(replies, 0.75),
        replies: replies.length,
      },
      days: days.map((d) => ({
        ...d,
        working: d.working.map(round),
        waiting: d.waiting.map(round),
      })),
      replyBuckets: buckets,
      repos: repoList,
      prSplit,
      models: [...models.values()].sort((a, b) => b.costUSD - a.costUSD),
      tools: top(tools, 12),
      skills: top(skills, 10),
      perms,
      interrupts,
      subagents,
      slotMinutes: SLOT_MS / 60000,
      waitCapHours: PROFILE_WAIT_CAP_MS / 3600000,
    };
  }
}
