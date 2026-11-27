'use strict';

// The "Ended" view: sessions that are no longer running, searchable,
// with Resume (claude --resume) and Hand off (a new session that gets the gist) buttons.
window.Ended = (() => {
  const $ = (id) => document.getElementById(id);
  const root = $('ended');
  const list = $('ended-list');
  const input = $('ended-q');
  const status = $('ended-status');
  let seq = 0; // 最後に出したリクエストの番号。古い応答で上書きしない
  let timer = null;
  let loaded = false;

  const REASONS = {
    'session-running': 'This session is already running.',
    'cwd-missing': 'Its folder is gone.',
    'session-not-found': 'It is no longer in the last 31 days of logs.',
    'terminal-failed': 'The terminal did not respond. If no tab opened, try again in 30 seconds, or run this yourself:',
    'no-terminal': 'No supported terminal to open it in. Run this yourself:',
    'launch-failed': 'Could not open it.',
  };
  const reasonText = (reason) => REASONS[reason] ?? REASONS['terminal-failed'];

  // 開けなかった理由。手で打てるコマンドが返ってきたら、コピーボタンを添える (copyButton は app.js)
  function showResult(note, res) {
    if (res.ok) {
      note.textContent = res.terminal ? `Opened in a new ${res.terminal} tab.` : 'Opened in a new tab.';
      return;
    }
    const text = reasonText(res.reason);
    if (res.command && typeof window.copyButton === 'function') {
      const copy = window.copyButton(res.command, 'Copy command');
      copy.addEventListener('click', (e) => e.stopPropagation());
      note.replaceChildren(document.createTextNode(`${text} `), copy);
    } else {
      note.textContent = text;
    }
  }

  function h(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }

  function ago(ts) {
    if (!ts) return '';
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 60) return `${Math.max(m, 1)}m ago`;
    const hrs = Math.round(m / 60);
    if (hrs < 48) return `${hrs}h ago`;
    return `${Math.round(hrs / 24)}d ago`;
  }

  const tokens = (n) => (n == null ? null : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

  async function post(kind, sessionId) {
    try {
      const res = await ccdAuth.fetch(`/api/${kind}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CC-Dashboard': '1' },
        body: JSON.stringify({ sessionId }),
      });
      const body = await res.json().catch(() => ({}));
      return res.ok ? { ok: true, terminal: body.terminal ?? null } : { ok: false, reason: body.reason ?? 'terminal-failed', command: body.command ?? null };
    } catch {
      return { ok: false, reason: 'terminal-failed' };
    }
  }

  // Resume / Hand off のボタン。PRs ビューでも使う
  function launchButtons(s, { onDone } = {}) {
    const wrap = h('span', 'launch');
    const note = h('span', 'launch-note muted');
    note.setAttribute('role', 'status');
    const make = (kind, label, enabled, why) => {
      const b = h('button', 'tool', label);
      b.type = 'button';
      b.disabled = !enabled;
      if (!enabled) b.title = why;
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        for (const x of wrap.querySelectorAll('button')) x.disabled = true;
        note.textContent = 'Opening…';
        const res = await post(kind, s.id);
        showResult(note, res);
        onDone?.(res);
        setTimeout(() => {
          resume.disabled = !(s.resumable ?? true);
          handoff.disabled = s.handoffCwd === null;
        }, 1500);
      });
      return b;
    };
    const resume = make('resume', 'Resume', s.resumable ?? true, 'The folder it started in is gone.');
    const handoff = make('handoff', 'Hand off', s.handoffCwd !== null, 'Its folders are gone.');
    resume.title ||= 'Continue this conversation (claude --resume). Reloads its whole context.';
    handoff.title ||= 'Start a new session with a short summary and a pointer to this log.';
    wrap.append(resume, handoff, note);
    return wrap;
  }

  function prChip(p) {
    const a = h('a', 'ended-pr', p.number ? `#${p.number}` : 'PR');
    a.href = p.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    if (p.title) a.title = p.title;
    const wrap = h('span');
    wrap.append(a);
    if (p.state) wrap.append(' ', h('span', `state-badge ${p.state.toLowerCase()}`, p.state === 'MERGED' ? 'merged' : p.state.toLowerCase()));
    return wrap;
  }

  function row(s) {
    const li = h('li', 'ended-row');
    const head = h('div', 'ended-head');
    head.append(h('span', 'ended-title', s.title));
    if (s.name && s.name !== s.title) {
      const n = h('span', 'ended-name muted', `“${s.name}”`);
      n.title = 'Name set with /rename. It can carry over from an earlier conversation in the same tab.';
      head.append(' ', n);
    }
    const meta = h('div', 'ended-meta muted');
    const where = [s.repo, s.worktree, s.branch].filter(Boolean).join(' · ');
    if (where) meta.append(h('span', null, where));
    meta.append(h('span', null, ago(s.lastActivityAt)));
    for (const p of s.prs) meta.append(prChip(p));
    const t = tokens(s.contextTokens);
    if (t) {
      const c = h('span', 'ended-ctx', t);
      c.title = 'Context size. Resume re-reads all of it once the cache has expired (after an hour at most).';
      meta.append(c);
    }
    const said = h('dl', 'ended-said');
    const line = (k, v) => {
      if (!v) return;
      const d = h('div');
      d.append(h('dt', null, k), h('dd', null, v));
      said.append(d);
    };
    // 最初・最後の依頼と同じなら重ねて出さない
    const flat = (x) => (x ?? '').replace(/\s+/g, ' ').trim();
    const m = flat(s.match).replace(/^…|…$/g, '');
    if (m && m !== flat(s.firstPrompt) && m !== flat(s.lastPrompt)) line('Match', s.match);
    line('First', s.firstPrompt);
    if (s.lastPrompt !== s.firstPrompt) line('Last', s.lastPrompt);
    li.append(head, meta, said, launchButtons(s));
    return li;
  }

  async function load() {
    const mine = ++seq;
    const q = input.value.trim();
    root.classList.toggle('refreshing', loaded);
    try {
      const res = await ccdAuth.fetch(`/api/ended?q=${encodeURIComponent(q)}`, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(String(res.status));
      const { sessions } = await res.json();
      if (mine !== seq) return;
      loaded = true;
      list.replaceChildren(...sessions.map(row));
      status.hidden = sessions.length > 0;
      status.textContent = q ? 'No ended session matches.' : 'No ended sessions in the last 31 days.';
      root.setAttribute('aria-busy', 'false');
    } catch {
      if (mine !== seq) return;
      status.hidden = false;
      status.textContent = 'Could not read the session logs. Reload to try again.';
    } finally {
      if (mine === seq) root.classList.remove('refreshing');
    }
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(load, 150);
  });

  function show() {
    load();
    if (!input.value) input.focus();
  }

  if (location.hash === '#ended') show();
  return { show, launchButtons, reasonText, tokens };
})();
