'use strict';

const WINDOW_MS = 3 * 60 * 60 * 1000;
const STALL_MS = 3 * 60 * 1000;
const SVG_NS = 'http://www.w3.org/2000/svg';

const $ = (id) => document.getElementById(id);
const els = {
  board: $('board'),
  tally: $('tally'),
  axis: $('axis'),
  link: $('link-state'),
  sound: $('sound-btn'),
  notify: $('notify-btn'),
  nothing: $('nothing'),
  lanes: {
    you: { list: $('rows-you'), empty: $('empty-you'), section: $('lane-you') },
    claude: { list: $('rows-claude'), empty: $('empty-claude'), section: $('lane-claude') },
    shelf: { list: $('rows-shelf'), section: $('lane-shelf'), count: $('count-shelf') },
  },
  tpl: $('row-tpl'),
};

const rows = new Map(); // sessionId -> { el, refs }
const lastStates = new Map(); // sessionId -> state
const openIds = new Set();
let snapshot = null;
let firstRender = true;

/* ------------------------------------------------------------
   Preferences (per viewer, best effort)
   ------------------------------------------------------------ */
const prefs = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`ccd:${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`ccd:${key}`, JSON.stringify(value));
    } catch {}
  },
};

/* ------------------------------------------------------------
   Mac アプリ (Chan to Yare.app) との橋渡し
   アプリの WKWebView の中でだけ ccd ハンドラーがある。ブラウザでは bridge は null で、何も変わらない
   ------------------------------------------------------------ */
const bridge = window.webkit?.messageHandlers?.ccd ?? null;
function post(message) {
  try {
    bridge?.postMessage(message);
  } catch {}
}
// アプリ内では音の ON/OFF の正はアプリ側にあり、起動時に window.__ccdSound で渡される
let soundWanted = bridge ? window.__ccdSound !== false : prefs.get('sound', true);
let lastBadge = null;

/* ------------------------------------------------------------
   Formatting
   ------------------------------------------------------------ */
function durationParts(ms) {
  const m = Math.floor(Math.max(0, ms) / 60000);
  if (m < 1) return [['now', '']];
  if (m < 60) return [[String(m), 'm']];
  const h = Math.floor(m / 60);
  if (h < 24) {
    const rest = m % 60;
    return rest && h < 10 ? [[String(h), 'h'], [String(rest), 'm']] : [[String(h), 'h']];
  }
  return [[String(Math.floor(h / 24)), 'd']];
}

function fillDuration(el, ms) {
  el.replaceChildren();
  durationParts(ms).forEach(([num, unit], i) => {
    if (i) el.append(' ');
    el.append(num);
    if (unit) {
      const s = document.createElement('small');
      s.textContent = unit;
      el.append(s);
    }
  });
}

function durationText(ms) {
  return durationParts(ms)
    .map(([n, u]) => n + u)
    .join(' ');
}

const clock = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dayClock = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
function stamp(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return Date.now() - ts < 20 * 60 * 60 * 1000 ? clock.format(d) : dayClock.format(d);
}

// Markdown の記号を落として、一覧で読める1段落にする
function plain(text) {
  if (!text) return '';
  return text
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/^[ \t]*\|?[ \t:|-]+\|[ \t:|-]*$/gm, '')
    .replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_, row) => row.split('|').map((c) => c.trim()).filter(Boolean).join(' / '))
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[\s>*-]+/gm, '')
    .replace(/[─━]{3,}/g, '')
    .replace(/★\s*Insight/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ------------------------------------------------------------
   Markdown (最小限・安全): DOM API だけで組み立て、innerHTML は使わない
   ------------------------------------------------------------ */
function inline(parent, text) {
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\((https?:\/\/[^)\s]+)\)|https?:\/\/[^\s)）」]+)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) parent.append(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('`')) {
      const c = document.createElement('code');
      c.textContent = tok.slice(1, -1);
      parent.append(c);
    } else if (tok.startsWith('**')) {
      const b = document.createElement('strong');
      b.textContent = tok.slice(2, -2);
      parent.append(b);
    } else {
      const a = document.createElement('a');
      a.href = m[2] ?? tok;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = m[2] ? tok.slice(1, tok.indexOf('](')) : tok;
      parent.append(a);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

function renderMarkdown(target, text) {
  target.replaceChildren();
  if (!text) return;
  const lines = text.split('\n');
  let i = 0;
  let para = [];
  const flush = () => {
    if (!para.length) return;
    const p = document.createElement('p');
    inline(p, para.join(' '));
    target.append(p);
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    // 出力スタイルの装飾行 (`★ Insight ─────` や `─────`) は見出し/区切りとして扱う
    const deco = line.trim().replace(/^`|`$/g, '');
    if (/^★\s*Insight/.test(deco)) {
      flush();
      target.append(Object.assign(document.createElement('h4'), { textContent: 'Insight' }));
      i++;
      continue;
    }
    if (/^[─━]{3,}$/.test(deco)) {
      flush();
      i++;
      continue;
    }
    if (/^```/.test(line)) {
      flush();
      const pre = document.createElement('pre');
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      pre.textContent = buf.join('\n');
      target.append(pre);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flush();
      const table = document.createElement('table');
      let head = true;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        const cells = lines[i].trim().slice(1, -1).split('|').map((c) => c.trim());
        i++;
        if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
        const tr = document.createElement('tr');
        for (const c of cells) {
          const td = document.createElement(head ? 'th' : 'td');
          inline(td, c);
          tr.append(td);
        }
        table.append(tr);
        head = false;
      }
      target.append(table);
      continue;
    }
    const h = line.match(/^#{1,6}\s+(.*)/);
    if (h) {
      flush();
      const el = document.createElement('h4');
      inline(el, h[1]);
      target.append(el);
      i++;
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      flush();
      const ordered = /^\s*\d+\./.test(line);
      const list = document.createElement(ordered ? 'ol' : 'ul');
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        const li = document.createElement('li');
        inline(li, lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''));
        list.append(li);
        i++;
      }
      target.append(list);
      continue;
    }
    if (!line.trim() || /^[─━-]{3,}/.test(line.trim())) {
      flush();
      i++;
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flush();
}

const FAILURE = {
  'tab-not-found': 'No cmux tab found for this session',
  'session-not-found': 'The session has ended',
  'session-waiting': 'Answer the prompt in the terminal first',
  'cmux-failed': 'Could not reach cmux',
};

// mcp__claude_ai_redash-mcp__execute_adhoc_query -> redash · execute_adhoc_query
function toolName(name) {
  const m = name.match(/^mcp__(.+?)__(.+)$/);
  if (!m) return name;
  const server = m[1].replace(/^claude_ai_/, '').replace(/[-_]mcp$/, '').replace(/^plugin_[^_]+_/, '');
  return `${server} · ${m[2]}`;
}

const STATE_LABEL = {
  ask: 'Needs you',
  reply: 'Your reply',
  work: 'Working',
  dormant: 'Your reply',
  fresh: 'Unused',
};

function toolNote(s) {
  if (s.state === 'ask') {
    if (s.pendingTool === 'AskUserQuestion') return 'Waiting for your answer';
    if (s.pendingTool === 'ExitPlanMode') return 'Waiting for plan approval';
    if (s.pendingTool) return `Waiting for approval to run ${toolName(s.pendingTool)}`;
    if (s.waitingFor === 'permission prompt') return 'Waiting for approval';
    if (typeof s.waitingFor === 'string' && s.waitingFor) return s.waitingFor;
    return 'Waiting for you';
  }
  if (s.state === 'work') {
    const quiet = s.lastActivityAt ? Date.now() - s.lastActivityAt : 0;
    if (quiet > STALL_MS) return `No activity for ${durationText(quiet)}`;
    if (s.pendingTool) return `Running ${toolName(s.pendingTool)}`;
    if (s.rawStatus === 'shell') return 'Running a shell command';
    return 'Thinking';
  }
  return null;
}

/* ------------------------------------------------------------
   State mark
   ------------------------------------------------------------ */
function drawMark(svg, state) {
  svg.replaceChildren();
  const add = (tag, attrs) => {
    const n = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    svg.append(n);
  };
  switch (state) {
    case 'ask':
      add('path', { d: 'M6 0.8 11.2 6 6 11.2 0.8 6Z', fill: 'var(--ask)' });
      break;
    case 'reply':
      add('circle', { cx: 6, cy: 6, r: 5, fill: 'var(--you-mark)' });
      break;
    case 'work':
      add('circle', { cx: 6, cy: 6, r: 4.4, fill: 'none', stroke: 'var(--claude)', 'stroke-width': 1.6 });
      add('circle', { cx: 6, cy: 6, r: 1.8, fill: 'var(--claude)' });
      break;
    case 'dormant':
      add('circle', { cx: 6, cy: 6, r: 4, fill: 'none', stroke: 'var(--ink-3)', 'stroke-width': 1.4 });
      break;
    default:
      add('circle', { cx: 6, cy: 6, r: 4, fill: 'none', stroke: 'var(--ink-3)', 'stroke-width': 1.4, 'stroke-dasharray': '2 2' });
  }
}

/* ------------------------------------------------------------
   Relay track
   ------------------------------------------------------------ */
function drawTrack(track, s, now) {
  track.replaceChildren();
  const from = now - WINDOW_MS;
  const pct = (t) => `${(((Math.max(t, from) - from) / WINDOW_MS) * 100).toFixed(3)}%`;
  const width = (a, b) => `${(((Math.min(b, now) - Math.max(a, from)) / WINDOW_MS) * 100).toFixed(3)}%`;
  const node = (cls) => {
    const d = document.createElement('div');
    d.className = cls;
    track.append(d);
    return d;
  };

  for (let h = 1; h < 3; h++) node('gridline').style.left = `${((h / 3) * 100).toFixed(3)}%`;

  let any = false;
  for (const [a, end] of s.turns) {
    const live = end == null;
    const b = end ?? now;
    if (b < from) continue;
    any = true;
    const seg = node(`seg claude${live ? ' live' : ''}`);
    seg.style.left = pct(a);
    seg.style.width = width(a, b);
  }

  if (s.state === 'reply' || s.state === 'ask') {
    any = true; // あなたの番の線は常に引かれるので「動きなし」の注記は出さない
    const seg = node(`seg ${s.state === 'ask' ? 'ask' : 'you'}`);
    seg.style.left = pct(s.since);
    seg.style.width = width(s.since, now);
  }

  node('now');
  if (!any) node('clip').textContent = 'No activity in the last 3h';
}

function drawAxis() {
  els.axis.replaceChildren();
  const labels = ['3h ago', '2h ago', '1h ago', 'now'];
  labels.forEach((text, i) => {
    const span = document.createElement('span');
    span.textContent = text;
    span.style.left = `${((i / 3) * 100).toFixed(3)}%`;
    if (i === 0) span.style.transform = 'translateX(0)';
    els.axis.append(span);
  });
}

/* ------------------------------------------------------------
   Row
   ------------------------------------------------------------ */
function makeRow(id) {
  const el = els.tpl.content.firstElementChild.cloneNode(true);
  const q = (sel) => el.querySelector(sel);
  const refs = {
    mark: q('.mark'),
    label: q('.state-label'),
    elapsed: q('.elapsed'),
    main: q('.main'),
    title: q('.title'),
    meta: q('.meta'),
    gist: q('.gist'),
    track: q('.track'),
    jump: q('.jump'),
    detail: q('.detail'),
    youTime: q('.turn-you time'),
    youSaid: q('.turn-you .said'),
    claudeTime: q('.turn-claude time'),
    claudeSaid: q('.turn-claude .said'),
    facts: q('.facts'),
    composer: q('.composer'),
    memo: q('.composer textarea'),
    hint: q('.composer-hint'),
    memoButtons: [...el.querySelectorAll('.composer button')],
  };
  refs.main.addEventListener('click', () => toggle(id));
  refs.composer.addEventListener('submit', (e) => {
    e.preventDefault();
    sendMemo(id, refs, e.submitter?.value === 'remember' ? 'remember' : 'send');
  });
  refs.memo.addEventListener('keydown', (e) => {
    // ⌘/Ctrl + Enter で送る。Enter 単体は改行 (送信時には空白に畳まれる)
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      sendMemo(id, refs, 'send');
    }
  });
  refs.jump.addEventListener('click', () => jump(id, refs.jump));
  el.addEventListener('animationend', (e) => {
    if (e.animationName.startsWith('arrive') || e.animationName === 'beam') el.classList.remove('arrived');
  });
  const row = { el, refs };
  rows.set(id, row);
  return row;
}

function toggle(id) {
  if (openIds.has(id)) openIds.delete(id);
  else openIds.add(id);
  const row = rows.get(id);
  const s = snapshot?.sessions.find((x) => x.id === id);
  if (row && s) fillRow(row, s, Date.now());
}

function metaItem(text, { icon, code, cls, href } = {}) {
  const span = document.createElement(href ? 'a' : 'span');
  span.className = `m${cls ? ` ${cls}` : ''}`;
  if (href) {
    span.href = href;
    span.target = '_blank';
    span.rel = 'noopener noreferrer';
  }
  if (icon) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#${icon}`);
    svg.append(use);
    span.append(svg);
  }
  const t = document.createElement('span');
  if (code) t.className = 'code';
  t.textContent = text;
  span.append(t);
  return span;
}

function fact(dt, ddContent) {
  const d = document.createElement('div');
  const a = document.createElement('dt');
  a.textContent = dt;
  const b = document.createElement('dd');
  b.append(ddContent);
  d.append(a, b);
  return d;
}

function codeText(text) {
  const c = document.createElement('code');
  c.textContent = text;
  return c;
}

function copyButton(value, label) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'copy';
  b.title = 'Copy';
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'icon');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', '#i-copy');
  svg.append(use);
  const t = document.createElement('span');
  t.textContent = label;
  b.append(t, svg);
  b.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(value);
      t.textContent = 'Copied';
      setTimeout(() => (t.textContent = label), 1400);
    } catch {}
  });
  return b;
}

const QUIET_BRANCHES = new Set(['HEAD', 'master', 'main']);

function fillRow(row, s, now) {
  const { el, refs } = row;
  const open = openIds.has(s.id);
  el.dataset.state = s.state;
  el.classList.toggle('open', open);

  if (refs.mark.dataset.state !== s.state) {
    drawMark(refs.mark, s.state);
    refs.mark.dataset.state = s.state;
  }
  refs.label.textContent = STATE_LABEL[s.state] ?? s.state;
  fillDuration(refs.elapsed, now - s.since);
  refs.elapsed.title = `Since ${stamp(s.since)}`;

  refs.title.textContent = s.title;
  refs.title.title = s.title;

  const meta = [];
  // 一目で要る順に並べ、1行に収まらない分は末尾から省略する
  if (s.repo) meta.push(metaItem(s.repo));
  for (const pr of s.prs) meta.push(metaItem(`#${pr.number}`, { icon: 'i-pr', href: pr.url }));
  if (s.tab?.workspace) meta.push(metaItem(s.tab.workspace, { cls: 'ws' }));
  const branchShown =
    s.branch && !QUIET_BRANCHES.has(s.branch) && !(s.worktree && (s.branch === s.worktree || s.branch.endsWith(`/${s.worktree}`)));
  if (s.worktree) meta.push(metaItem(s.worktree, { icon: 'i-branch', code: true, cls: 'wt' }));
  else if (branchShown) meta.push(metaItem(s.branch, { icon: 'i-branch', code: true }));
  refs.meta.replaceChildren(...meta);

  // gist: その状態で一番知りたい一文
  refs.gist.replaceChildren();
  const note = toolNote(s);
  if (note) {
    const n = document.createElement('span');
    n.className = 'tool-note';
    n.textContent = note;
    refs.gist.append(n);
  }
  const say = (who, text) => {
    if (!text) return;
    if (refs.gist.childNodes.length) refs.gist.append(document.createTextNode('　'));
    const w = document.createElement('span');
    w.className = 'who';
    w.textContent = who;
    refs.gist.append(w, plain(text).slice(0, 280));
  };
  if (s.state === 'work') say('Asked', s.lastPrompt);
  else if (s.state === 'ask') say('Claude', s.lastReply ?? s.lastPrompt);
  else say('Claude', s.lastReply);

  refs.main.setAttribute('aria-expanded', String(open));
  if (s.state !== 'dormant' && s.state !== 'fresh') drawTrack(refs.track, s, now);
  else refs.track.replaceChildren();

  refs.jump.disabled = !s.tab;
  refs.jump.title = s.tab ? `Open “${s.tab.title || s.title}” in cmux` : 'No cmux tab found for this session';

  refs.detail.hidden = !open;
  if (open) {
    refs.youTime.textContent = stamp(s.lastPromptAt);
    refs.youSaid.textContent = s.lastPrompt ?? '';
    refs.claudeTime.textContent = stamp(s.lastReplyAt);
    // 返答が変わったときだけ描き直す (読んでいる途中のスクロールや選択を崩さない)
    if (refs.renderedReply !== s.lastReply) {
      renderMarkdown(refs.claudeSaid, s.lastReply);
      refs.renderedReply = s.lastReply;
    }
    const blocked = !s.tab ? 'tab-not-found' : s.state === 'ask' ? 'session-waiting' : null;
    refs.composer.dataset.blocked = blocked ?? '';
    refs.memo.disabled = Boolean(blocked);
    for (const b of refs.memoButtons) b.disabled = Boolean(blocked) || refs.sending === true;
    if (!refs.sending && !refs.sentAt) {
      refs.hint.textContent = blocked
        ? FAILURE[blocked]
        : s.state === 'work'
          ? 'Claude is working. Your message is queued until this turn ends.'
          : '⌘↩ to send';
    }
    const facts = [fact('Path', codeText(s.cwd ?? 'unknown'))];
    if (s.branch) facts.push(fact('Branch', codeText(s.branch)));
    if (s.tab) facts.push(fact('cmux', `${s.tab.workspace ?? ''} / ${s.tab.title ?? ''}`));
    if (s.costUSD != null) facts.push(fact('Cost', `$${s.costUSD.toFixed(2)}`));
    facts.push(fact('Session', copyButton(s.id, s.name ?? s.id.slice(0, 8))));
    refs.facts.replaceChildren(...facts);
  }
}

/* ------------------------------------------------------------
   Board
   ------------------------------------------------------------ */
function laneOf(state) {
  if (state === 'ask' || state === 'reply') return 'you';
  if (state === 'work') return 'claude';
  return 'shelf';
}

function order(list) {
  const rank = { ask: 0, reply: 1, work: 2, dormant: 3, fresh: 4 };
  return list.sort((a, b) => {
    if (rank[a.state] !== rank[b.state]) return rank[a.state] - rank[b.state];
    // 確認待ちと作業中は古い順 (待たせている順)、返事待ちと放置は新しい順 (文脈が新しい順)
    if (a.state === 'ask' || a.state === 'work') return a.since - b.since;
    return b.since - a.since;
  });
}

let rowIndex = 0;
function placeRows(list, sessions) {
  sessions.forEach((s, i) => {
    const { el } = rows.get(s.id);
    el.style.setProperty('--i', String(rowIndex++));
    if (list.children[i] !== el) list.insertBefore(el, list.children[i] ?? null);
  });
  while (list.children.length > sessions.length) list.lastElementChild.remove();
}

function render() {
  if (!snapshot) return;
  const now = Date.now();
  const sessions = order([...snapshot.sessions]);
  const byLane = { you: [], claude: [], shelf: [] };
  for (const s of sessions) byLane[laneOf(s.state)].push(s);

  const seen = new Set();
  const arrivals = [];
  for (const s of sessions) {
    seen.add(s.id);
    const row = rows.get(s.id) ?? makeRow(s.id);
    fillRow(row, s, now);
    const before = lastStates.get(s.id);
    if (!firstRender && before !== s.state && (s.state === 'reply' || s.state === 'ask')) {
      arrivals.push(s);
      row.el.classList.remove('arrived');
      void row.el.offsetWidth;
      row.el.classList.add('arrived');
    }
    lastStates.set(s.id, s.state);
  }
  for (const id of [...rows.keys()]) {
    if (!seen.has(id)) {
      rows.get(id).el.remove();
      rows.delete(id);
      lastStates.delete(id);
      openIds.delete(id);
    }
  }

  rowIndex = 0;
  for (const lane of ['you', 'claude', 'shelf']) placeRows(els.lanes[lane].list, byLane[lane]);
  if (firstRender) playLiveEntrance();
  els.lanes.you.empty.hidden = byLane.you.length > 0;
  els.lanes.claude.empty.hidden = byLane.claude.length > 0;
  els.lanes.shelf.section.hidden = byLane.shelf.length === 0;
  els.lanes.shelf.count.textContent = String(byLane.shelf.length);

  const none = sessions.length === 0;
  els.nothing.hidden = !none;
  for (const lane of Object.values(els.lanes)) if (none) lane.section.hidden = true;
  if (!none) {
    els.lanes.you.section.hidden = false;
    els.lanes.claude.section.hidden = false;
  }

  renderTally(byLane);
  if (bridge && lastBadge !== byLane.you.length) {
    lastBadge = byLane.you.length;
    post({ type: 'badge', count: lastBadge });
  }
  drawAxis();
  els.board.setAttribute('aria-busy', 'false');

  if (arrivals.length) announce(arrivals);
  firstRender = false;
}

function renderTally(byLane) {
  const ask = byLane.you.filter((s) => s.state === 'ask').length;
  const parts = [];
  const part = (cls, label, n) => {
    const span = document.createElement('span');
    span.className = cls;
    const b = document.createElement('b');
    b.textContent = String(n);
    span.append(`${label} `, b);
    return span;
  };
  parts.push(part('t-you', 'Your turn', byLane.you.length));
  if (ask) parts.push(part('t-ask', 'needs you', ask));
  parts.push(part('t-claude', 'Claude’s turn', byLane.claude.length));
  if (byLane.shelf.length) parts.push(part('t-shelf', 'Untouched', byLane.shelf.length));
  const nodes = [];
  parts.forEach((p, i) => {
    if (i) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '·';
      nodes.push(sep);
    }
    nodes.push(p);
  });
  els.tally.replaceChildren(...nodes);
  document.title = byLane.you.length ? `(${byLane.you.length}) Chan to Yare` : 'Chan to Yare';
}

/* ------------------------------------------------------------
   Notify: 何件増えても音は1回 (確認待ちを優先)
   ------------------------------------------------------------ */
function announce(arrivals) {
  const ask = arrivals.find((s) => s.state === 'ask');
  if (bridge) {
    // 音はアプリが鳴らす (ON/OFF もアプリが判断)。通知はアプリが前面にないときだけアプリが出す
    post({ type: 'sound', kind: ask ? 'ask' : 'reply' });
    for (const s of arrivals.slice(0, 3)) {
      post({
        type: 'notify',
        title: `${STATE_LABEL[s.state]}: ${s.title}`,
        body: plain(toolNote(s) ?? s.lastReply ?? '').slice(0, 140),
        sessionId: s.id,
        kind: s.state,
      });
    }
    return;
  }
  if (soundWanted) window.Chime.play(ask ? 'ask' : 'reply');
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.hasFocus()) return;
  for (const s of arrivals.slice(0, 3)) {
    const n = new Notification(`${STATE_LABEL[s.state]}: ${s.title}`, {
      body: plain(toolNote(s) ?? s.lastReply ?? '').slice(0, 140),
      tag: s.id,
      silent: true,
    });
    n.onclick = () => {
      window.focus();
      const row = rows.get(s.id);
      if (row) jump(s.id, row.refs.jump);
      n.close();
    };
  }
}

/* ------------------------------------------------------------
   Memo: tell the session something on the spot
   ------------------------------------------------------------ */
async function sendMemo(id, refs, mode) {
  const text = refs.memo.value.trim();
  if (!text || refs.sending || refs.composer.dataset.blocked) return;
  refs.sending = true;
  for (const b of refs.memoButtons) b.disabled = true;
  refs.hint.textContent = mode === 'remember' ? 'Asking it to remember…' : 'Sending…';
  try {
    const res = await fetch('/api/memo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CC-Dashboard': '1' },
      body: JSON.stringify({ sessionId: id, text, mode }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.reason ?? 'cmux-failed');
    refs.memo.value = '';
    refs.hint.textContent = mode === 'remember' ? 'Sent. It will save this to memory.' : 'Sent to the session.';
    refs.composer.classList.remove('failed');
  } catch (e) {
    refs.hint.textContent = FAILURE[e.message] ?? FAILURE['cmux-failed'];
    refs.composer.classList.add('failed');
  } finally {
    refs.sending = false;
    refs.sentAt = Date.now();
    for (const b of refs.memoButtons) b.disabled = Boolean(refs.composer.dataset.blocked);
    setTimeout(() => {
      refs.sentAt = 0;
      refs.composer.classList.remove('failed');
    }, 4000);
  }
}

/* ------------------------------------------------------------
   Jump to the cmux tab
   ------------------------------------------------------------ */
async function jump(id, button) {
  if (button.disabled) return;
  button.classList.remove('failed');
  button.classList.add('busy');
  const label = button.querySelector('.jump-label');
  try {
    const res = await fetch('/api/focus', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CC-Dashboard': '1' },
      body: JSON.stringify({ sessionId: id }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).reason ?? 'failed');
  } catch (e) {
    button.classList.add('failed');
    const reason = FAILURE[e.message];
    label.textContent = 'Failed';
    button.title = reason ?? FAILURE['cmux-failed'];
    setTimeout(() => {
      label.textContent = 'Open';
      button.classList.remove('failed');
    }, 2500);
  } finally {
    button.classList.remove('busy');
  }
}

// アプリの通知から呼ばれる入口。行がなくても (別のタブを開いていても) cmux のタブに移る
window.ccdJump = (id) => {
  if (typeof id !== 'string') return;
  const row = rows.get(id);
  if (row && !row.refs.jump.disabled) return jump(id, row.refs.jump);
  return fetch('/api/focus', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CC-Dashboard': '1' },
    body: JSON.stringify({ sessionId: id }),
  }).catch(() => {});
};

/* ------------------------------------------------------------
   Sound and notification controls
   ------------------------------------------------------------ */
function renderSound() {
  // アプリ内ではアプリが音を鳴らすので、Web Audio の準備を待たない
  const ready = bridge ? true : window.Chime.ready;
  const on = soundWanted && ready;
  const use = els.sound.querySelector('use');
  const text = els.sound.querySelector('span');
  use.setAttribute('href', on ? '#i-sound' : '#i-mute');
  els.sound.setAttribute('aria-pressed', String(on));
  els.sound.classList.toggle('attention', soundWanted && !ready);
  text.textContent = soundWanted ? (ready ? 'Sound on' : 'Enable sound') : 'Sound off';
}

els.sound.addEventListener('click', () => {
  if (bridge) {
    soundWanted = !soundWanted;
    post({ type: 'soundEnabled', on: soundWanted });
    renderSound();
    if (soundWanted) post({ type: 'sound', kind: 'reply' });
    return;
  }
  if (soundWanted && !window.Chime.ready) {
    window.Chime.unlock();
  } else {
    soundWanted = !soundWanted;
    prefs.set('sound', soundWanted);
    if (soundWanted) window.Chime.unlock();
  }
  setTimeout(() => {
    renderSound();
    if (soundWanted && window.Chime.ready) window.Chime.play('reply');
  }, 60);
});
// ページのどこかを一度触れば音が出せるようになる
document.addEventListener(
  'pointerdown',
  () => {
    if (soundWanted && !bridge) window.Chime.unlock();
    setTimeout(renderSound, 60);
  },
  { once: true, capture: true },
);

function renderNotify() {
  // アプリ内では通知の許可はアプリ (macOS) が求めるので、このボタンは出さない
  const can = !bridge && 'Notification' in window && Notification.permission === 'default';
  els.notify.hidden = !can;
}
els.notify.addEventListener('click', async () => {
  try {
    await Notification.requestPermission();
  } catch {}
  renderNotify();
});

/* ------------------------------------------------------------
   Live connection
   ------------------------------------------------------------ */
function setLink(ok) {
  els.link.classList.toggle('down', !ok);
  document.body.classList.toggle('link-down', !ok);
  els.link.textContent = ok ? '' : 'Disconnected. Reconnecting…';
}

function connect() {
  const es = new EventSource('/api/events');
  es.onopen = () => setLink(true);
  es.onmessage = (ev) => {
    try {
      snapshot = JSON.parse(ev.data);
    } catch {
      return;
    }
    setLink(true);
    const brand = document.querySelector('.brand');
    brand.classList.remove('beat');
    void brand.offsetWidth;
    brand.classList.add('beat');
    render();
  };
  es.onerror = () => setLink(false);
}

function playLiveEntrance() {
  els.board.classList.remove('enter');
  void els.board.offsetWidth;
  els.board.classList.add('enter');
  clearTimeout(playLiveEntrance.t);
  playLiveEntrance.t = setTimeout(() => els.board.classList.remove('enter'), 2200);
}

/* ------------------------------------------------------------
   Views: #live / #insights
   ------------------------------------------------------------ */
function route() {
  const view = location.hash === '#insights' ? 'insights' : location.hash === '#prs' ? 'prs' : 'live';
  els.board.hidden = view !== 'live';
  document.getElementById('insights').hidden = view !== 'insights';
  document.getElementById('prs').hidden = view !== 'prs';
  for (const v of ['live', 'insights', 'prs']) {
    const a = document.getElementById(`nav-${v}`);
    if (v === view) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  if (view === 'insights') window.Insights?.show();
  if (view === 'prs') window.PRs?.show();
  if (view === 'live' && !firstRender) playLiveEntrance();
}
window.addEventListener('hashchange', route);

renderSound();
renderNotify();
connect();
route();
setInterval(render, 15000);
