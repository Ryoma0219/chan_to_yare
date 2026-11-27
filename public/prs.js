'use strict';

// The "PRs" view: each pull request you opened, read together with the sessions behind it.
// No single score: four axes side by side (delegation, cost, speed, quality guard).
window.PRs = (() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const $ = (id) => document.getElementById(id);
  const root = $('prs');
  const tip = $('tip');
  let data = null;
  let loading = null;
  let timer = null;
  let sortKey = 'createdAt';
  let sortDir = -1;
  const openRows = new Set();

  /* ---------- helpers ---------- */
  function h(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }
  function svg(tag, attrs = {}) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  }
  const num = new Intl.NumberFormat('en-US');
  const dash = '–';
  const usd = (x) => (x == null ? dash : x >= 100 ? `$${num.format(Math.round(x))}` : x >= 1 ? `$${x.toFixed(1)}` : `$${x.toFixed(2)}`);
  const pct = (x) => (x == null ? dash : x > 0 && x < 0.01 ? `${(x * 100).toFixed(1)}%` : `${Math.round(x * 100)}%`);
  const dec = (x) => (x == null ? dash : x >= 10 ? String(Math.round(x)) : x.toFixed(1));
  function dur(ms) {
    if (ms == null) return dash;
    if (ms === 0) return '0';
    const m = ms / 60000;
    if (m < 1) return `${Math.max(1, Math.round(ms / 1000))} s`;
    if (m < 60) return `${Math.round(m)} m`;
    const hr = m / 60;
    if (hr < 48) return `${hr < 10 ? hr.toFixed(1) : Math.round(hr)} h`;
    return `${(hr / 24).toFixed(1)} d`;
  }
  const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
  const weekLabel = (t) => dateFmt.format(new Date(t));

  function showTip(x, y, title, rows) {
    tip.replaceChildren(h('p', 'tip-title', title));
    for (const r of rows) {
      const line = h('p', 'tip-row');
      if (r.key) line.append(h('span', `tip-key ${r.key}`));
      line.append(h('b', null, r.value), h('span', null, r.label));
      tip.append(line);
    }
    tip.hidden = false;
    const w = tip.offsetWidth;
    const ht = tip.offsetHeight;
    let left = x + 14;
    if (left + w > window.innerWidth - 8) left = x - w - 14;
    let top = y - ht - 14;
    if (top < 8) top = y + 14;
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${top}px`;
  }
  const hideTip = () => (tip.hidden = true);

  /* ---------- the four axes ---------- */
  // Each metric: a figure for the whole period and, when it varies by week, five weekly columns.
  const AXES = [
    {
      key: 'delegation',
      title: 'Delegation',
      note: 'How much you hand over. Anthropic tracks the same signals internally.',
      metrics: [
        { label: 'Your prompts per PR', total: (t) => dec(t.promptsPerPR), week: 'promptsPerPR', fmt: dec, hint: 'median' },
        { label: 'Tool calls per prompt', total: (t) => dec(t.toolsPerPrompt), week: 'toolsPerPrompt', fmt: dec, hint: 'median' },
        { label: 'Claude waiting on you', total: (t) => pct(t.waitShare), week: 'waitShare', fmt: pct, hint: 'share of session time' },
      ],
    },
    {
      key: 'cost',
      title: 'Cost',
      note: 'DORA suggests cost per merged change rather than token volume.',
      metrics: [
        { label: 'Cost per merged PR', total: (t) => usd(t.costPerMerged), week: 'costPerMerged', fmt: usd, hint: 'median, estimated' },
        { label: 'Claude time per 100 lines', total: (t) => dur(t.claudePer100Lines), hint: 'median, merged PRs' },
        { label: 'Work on how you use AI', total: (t) => pct(t.metaShare), week: 'metaShare', fmt: pct, hint: 'skills, CLAUDE.md, hooks' },
      ],
    },
    {
      key: 'speed',
      title: 'Speed',
      note: 'Wall-clock time, not how fast it felt.',
      metrics: [
        { label: 'First prompt → PR', total: (t) => dur(t.startToCreate), hint: 'median' },
        { label: 'PR → merge', total: (t) => dur(t.createToMerge), week: 'createToMergeMs', fmt: dur, hint: 'median' },
        { label: 'PR → first review', total: (t) => dur(t.createToReview), hint: 'median, by a person, not a bot' },
      ],
    },
    {
      key: 'quality',
      title: 'Quality guard',
      note: 'Speed gains tend to come back as rework and review load.',
      metrics: [
        { label: 'Lines rewritten within 21 days', total: (t) => pct(t.reworkRate), week: 'reworkRate', fmt: pct, hint: (t) => `${t.reworkSettled} PRs whose 21 days have passed` },
        { label: 'PRs with rework', total: (t) => `${t.reworkPRs} of ${t.merged}`, hint: '3 or more lines rewritten' },
        { label: 'Reverted · changes requested', total: (t) => `${t.reverted} · ${t.changesRequested}` },
      ],
    },
  ];

  function miniColumns(weeks, key, fmt, label) {
    const box = h('div', 'mini-cols');
    const vals = weeks.map((w) => w[key]);
    const max = Math.max(...vals.filter((v) => v != null), 0) || 1;
    weeks.forEach((w, i) => {
      const col = h('div', 'mini-col');
      col.tabIndex = 0;
      const bar = h('span', 'mini-bar');
      const v = w[key];
      bar.style.height = v == null ? '0' : `${Math.max(4, (v / max) * 100)}%`;
      if (v == null) col.classList.add('empty');
      if (i === weeks.length - 1) col.classList.add('current');
      col.append(bar);
      const show = (x, y) =>
        showTip(x, y, `Week of ${weekLabel(w.start)}`, [{ key: 'working', value: v == null ? dash : fmt(v), label: `${label} · ${w.prs} PRs` }]);
      col.addEventListener('pointermove', (e) => show(e.clientX, e.clientY));
      col.addEventListener('pointerleave', hideTip);
      col.addEventListener('focus', () => {
        const r = col.getBoundingClientRect();
        show(r.left + r.width / 2, r.top);
      });
      col.addEventListener('blur', hideTip);
      box.append(col);
    });
    return box;
  }

  function renderAxes(d) {
    const wrap = $('axes');
    wrap.replaceChildren();
    for (const ax of AXES) {
      const panel = h('section', `panel axis-panel axis-${ax.key}`);
      const head = h('div', 'panel-head');
      head.append(h('h3', null, ax.title));
      panel.append(head, h('p', 'panel-note', ax.note));
      const list = h('dl', 'axis-metrics');
      for (const m of ax.metrics) {
        const row = h('div', 'axis-metric');
        const dt = h('dt');
        dt.append(h('span', 'axis-label', m.label));
        const hint = typeof m.hint === 'function' ? m.hint(d.totals) : m.hint;
        if (hint) dt.append(h('span', 'axis-hint', hint));
        const dd = h('dd', null, m.total(d.totals));
        row.append(dt, dd);
        if (m.week) row.append(miniColumns(d.weeks, m.week, m.fmt, m.label));
        list.append(row);
      }
      panel.append(list);
      wrap.append(panel);
    }
    const weeks = h('p', 'axis-weeks', `Columns are weeks, ${weekLabel(d.weeks[0].start)} to now; the brightest is this week.`);
    wrap.append(weeks);
  }

  /* ---------- scatter: size vs cost ---------- */
  function renderScatter(d) {
    const rows = d.prs.filter((p) => p.linked && p.lines > 0 && p.costUSD > 0);
    const legend = $('scatter-legend');
    legend.replaceChildren(
      ...[
        ['dot merged', 'Merged'],
        ['dot open', 'Open or draft'],
        ['dot rework', 'Rewritten within 21 days'],
        ['dot reverted', 'Reverted'],
      ].map(([cls, label]) => {
        const li = h('li');
        li.append(h('span', cls), document.createTextNode(label));
        return li;
      }),
    );
    const box = $('scatter');
    box.replaceChildren();
    if (!rows.length) {
      box.append(h('p', 'ranked-empty', 'No PRs with both size and cost yet.'));
      return;
    }
    const W = 1000;
    const H = 320;
    const pad = { l: 54, r: 16, t: 12, b: 34 };
    const lx = (v) => Math.log10(Math.max(1, v));
    const xs = rows.map((p) => lx(p.lines));
    const ys = rows.map((p) => Math.log10(Math.max(0.01, p.costUSD)));
    const x0 = Math.floor(Math.min(...xs));
    const x1 = Math.ceil(Math.max(...xs));
    const y0 = Math.floor(Math.min(...ys));
    const y1 = Math.ceil(Math.max(...ys));
    const sx = (v) => pad.l + ((v - x0) / (x1 - x0 || 1)) * (W - pad.l - pad.r);
    const sy = (v) => H - pad.b - ((v - y0) / (y1 - y0 || 1)) * (H - pad.t - pad.b);
    const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Each PR by lines changed and estimated cost' });
    for (let e = x0; e <= x1; e++) {
      const x = sx(e);
      s.append(svg('line', { x1: x, x2: x, y1: pad.t, y2: H - pad.b, class: 'grid' }));
      const t = svg('text', { x, y: H - 10, class: 'tick', 'text-anchor': 'middle' });
      t.textContent = e >= 3 ? `${10 ** (e - 3)}k lines` : `${10 ** e} lines`;
      s.append(t);
    }
    for (let e = y0; e <= y1; e++) {
      const y = sy(e);
      s.append(svg('line', { x1: pad.l, x2: W - pad.r, y1: y, y2: y, class: 'grid' }));
      const t = svg('text', { x: pad.l - 8, y: y + 4, class: 'tick', 'text-anchor': 'end' });
      t.textContent = `$${10 ** e >= 1 ? num.format(10 ** e) : (10 ** e).toFixed(2)}`;
      s.append(t);
    }
    rows.forEach((p, i) => {
      const cx = sx(xs[i]);
      const cy = sy(ys[i]);
      const g = svg('g', { class: 'pt', tabindex: '0' });
      const state = p.mergedAt ? 'merged' : 'open';
      g.append(svg('circle', { cx, cy, r: 14, class: 'hit' }));
      if (p.reworkLines >= 3) g.append(svg('circle', { cx, cy, r: 8.5, class: 'ring rework' }));
      if (p.revertedBy) g.append(svg('circle', { cx, cy, r: 8.5, class: 'ring reverted' }));
      g.append(svg('circle', { cx, cy, r: 5, class: `mark ${state}` }));
      g.style.setProperty('--i', String(i));
      const show = (x, y) =>
        showTip(x, y, `${p.repo.split('/')[1]} #${p.number}`, [
          { value: num.format(p.lines), label: 'lines changed' },
          { key: 'working', value: usd(p.costUSD), label: 'estimated cost' },
          { value: num.format(p.prompts ?? 0), label: 'your prompts' },
          { value: p.title.length > 46 ? `${p.title.slice(0, 46)}…` : p.title, label: '' },
        ]);
      g.addEventListener('pointermove', (e) => show(e.clientX, e.clientY));
      g.addEventListener('pointerleave', hideTip);
      g.addEventListener('focus', () => {
        const r = g.getBoundingClientRect();
        show(r.left + r.width / 2, r.top);
      });
      g.addEventListener('blur', hideTip);
      g.addEventListener('click', () => reveal(p.url));
      g.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') reveal(p.url);
      });
      s.append(g);
    });
    box.append(s);
  }

  /* ---------- the table ---------- */
  const COLS = [
    { key: 'title', label: 'Pull request', cls: 'name' },
    { key: 'lines', label: 'Lines', cls: 'n' },
    { key: 'prompts', label: 'Prompts', cls: 'n' },
    { key: 'toolsPerPrompt', label: 'Tools / prompt', cls: 'n' },
    { key: 'claudeMs', label: 'Claude time', cls: 'n' },
    { key: 'waitShare', label: 'Waited on you', cls: 'n' },
    { key: 'costUSD', label: 'Est. cost', cls: 'n' },
    { key: 'createToMergeMs', label: 'PR → merge', cls: 'n' },
    { key: 'reviewComments', label: 'Review', cls: 'n' },
    { key: 'reworkLines', label: 'Rework', cls: 'n' },
  ];

  function reveal(url) {
    openRows.add(url);
    renderTable(data);
    const row = root.querySelector(`tr[data-url="${CSS.escape(url)}"]`);
    row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    row?.classList.add('flash');
  }

  function stateBadge(p) {
    const b = h('span', `state-badge ${p.state.toLowerCase()}`, p.state === 'MERGED' ? 'merged' : p.state.toLowerCase());
    return b;
  }

  function detailRow(p) {
    const tr = h('tr', 'pr-detail');
    const td = h('td');
    td.colSpan = COLS.length;
    const grid = h('div', 'pr-detail-grid');

    const sess = h('div');
    sess.append(h('h4', null, `Sessions (${p.sessions.length})`));
    if (!p.sessions.length) sess.append(h('p', 'muted', 'No session log found for this PR.'));
    const ul = h('ul', 'plain-list');
    for (const s of p.sessions) {
      const li = h('li');
      li.append(h('span', 'session-title', s.title ?? s.id.slice(0, 8)), h('span', 'muted', ` · ${s.prompts} prompts · ${usd(s.costUSD)}`));
      ul.append(li);
    }
    sess.append(ul);

    const rv = h('div');
    rv.append(h('h4', null, 'Review'));
    const facts = h('dl', 'facts-list');
    const fact = (k, v) => {
      const d = h('div');
      d.append(h('dt', null, k), h('dd', null, v));
      facts.append(d);
    };
    fact('Reviewers', p.reviewers.length ? p.reviewers.join(', ') : 'none yet');
    fact('Comments and threads', num.format(p.reviewComments));
    fact('Changes requested', num.format(p.changesRequested));
    fact('PR → first review', dur(p.createToReviewMs));
    fact('First prompt → PR', dur(p.startToCreateMs));
    if (p.skills.length) fact('Skills used', p.skills.join(', '));
    if (p.interrupts) fact('Interrupted by you', num.format(p.interrupts));
    rv.append(facts);

    const q = h('div');
    q.append(h('h4', null, 'Rework within 21 days'));
    if (p.revertedBy) {
      const a = h('a', 'warn', 'Reverted');
      a.href = p.revertedBy;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      q.append(h('p', null, ''), a);
    }
    if (!p.mergedAt) q.append(h('p', 'muted', 'Not merged yet.'));
    else if (!p.rework.length) q.append(h('p', 'muted', p.reworkWindowOpen ? 'None so far. The 21 days have not passed yet.' : 'None of its lines were rewritten.'));
    else {
      const ul2 = h('ul', 'plain-list');
      for (const w of p.rework) {
        const li = h('li');
        const a = h('a', null, `#${w.number}`);
        a.href = w.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        li.append(a, document.createTextNode(` rewrote ${w.lines} lines in ${w.files.map((f) => f.split('/').pop()).join(', ')}`));
        ul2.append(li);
      }
      q.append(ul2);
    }

    grid.append(sess, rv, q);
    td.append(grid);
    tr.append(td);
    return tr;
  }

  function renderTable(d) {
    const table = $('pr-table');
    table.replaceChildren();
    const thead = h('thead');
    const hr = h('tr');
    for (const c of COLS) {
      const th = h('th', c.cls);
      const b = h('button', 'sort', c.label);
      b.type = 'button';
      if (sortKey === c.key) {
        th.setAttribute('aria-sort', sortDir < 0 ? 'descending' : 'ascending');
        b.append(h('span', 'sort-mark', sortDir < 0 ? ' ↓' : ' ↑'));
      }
      b.addEventListener('click', () => {
        if (sortKey === c.key) sortDir = -sortDir;
        else {
          sortKey = c.key;
          sortDir = c.key === 'title' ? 1 : -1;
        }
        renderTable(data);
      });
      th.append(b);
      hr.append(th);
    }
    thead.append(hr);
    const tbody = h('tbody');
    const val = (p) => (sortKey === 'title' ? p.title : p[sortKey]);
    const rows = d.prs.slice().sort((a, b) => {
      const x = val(a);
      const y = val(b);
      if (x == null && y == null) return b.createdAt - a.createdAt;
      if (x == null) return 1;
      if (y == null) return -1;
      return (x < y ? -1 : x > y ? 1 : 0) * sortDir;
    });
    for (const p of rows) {
      const tr = h('tr', 'pr-row');
      tr.dataset.url = p.url;
      tr.tabIndex = 0;
      const open = openRows.has(p.url);
      tr.setAttribute('aria-expanded', String(open));
      const name = h('td', 'name');
      const top = h('div', 'pr-top');
      const link = h('a', 'pr-num', `${p.repo.split('/')[1]} #${p.number}`);
      link.href = p.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.addEventListener('click', (e) => e.stopPropagation());
      top.append(link, stateBadge(p), h('span', 'muted', dateFmt.format(new Date(p.createdAt))));
      name.append(top, h('div', 'pr-title', p.title));
      tr.append(name);
      const linesCell = h('td', 'n');
      linesCell.append(h('span', 'add', `+${num.format(p.additions ?? 0)}`), h('span', 'del', ` −${num.format(p.deletions ?? 0)}`));
      tr.append(linesCell);
      for (const v of [
        p.prompts == null ? dash : num.format(p.prompts),
        dec(p.toolsPerPrompt),
        dur(p.claudeMs),
        pct(p.waitShare),
        usd(p.costUSD),
        dur(p.createToMergeMs),
        p.reviewComments || p.changesRequested ? `${p.reviewComments}${p.changesRequested ? ` · ${p.changesRequested} CR` : ''}` : dash,
      ])
        tr.append(h('td', 'n', v));
      const q = h('td', 'n');
      if (p.revertedBy) q.append(h('span', 'flag reverted', 'reverted'));
      else if (p.reworkLines >= 3) q.append(h('span', 'flag rework', `${p.reworkLines} lines`));
      else {
        q.append(document.createTextNode(p.mergedAt ? (p.reworkWindowOpen ? '…' : '0') : dash));
        if (p.reworkWindowOpen) q.title = 'The 21 days after merge have not passed yet';
      }
      tr.append(q);
      const toggle = () => {
        if (openRows.has(p.url)) openRows.delete(p.url);
        else openRows.add(p.url);
        renderTable(data);
      };
      tr.addEventListener('click', toggle);
      tr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle();
        }
      });
      tbody.append(tr);
      if (open) tbody.append(detailRow(p));
    }
    table.append(thead, tbody);
  }

  /* ---------- entrance (same grammar as Last 7 days) ---------- */
  let pendingEntrance = true;
  const io = 'IntersectionObserver' in window
    ? new IntersectionObserver(
        (entries) => {
          for (const en of entries) {
            if (!en.isIntersecting) continue;
            const el = en.target;
            io.unobserve(el);
            el.classList.remove('pre');
            el.classList.add('in');
            if (el.classList.contains('axis-panel')) window.Look?.countUp(el);
            setTimeout(() => el.classList.add('settled'), 2600);
          }
        },
        { threshold: 0, rootMargin: '0px 0px -8% 0px' },
      )
    : null;
  const blocks = () => [...root.querySelectorAll('.panel')];
  function prepareEntrance() {
    for (const el of blocks()) {
      io?.unobserve(el);
      el.classList.add('anim', 'pre');
      el.classList.remove('in', 'settled');
    }
  }
  function replayEntrance() {
    for (const el of blocks()) {
      el.classList.add('anim');
      if (!el.classList.contains('in')) el.classList.add('pre');
      if (!el.classList.contains('pre')) continue;
      if (io) io.observe(el);
      else el.classList.replace('pre', 'in');
    }
  }

  /* ---------- load ---------- */
  function render(d) {
    const first = pendingEntrance;
    pendingEntrance = false;
    data = d;
    const t = d.totals;
    $('prs-range').textContent = `${dateFmt.format(new Date(d.since))} – now · updated ${new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(d.generatedAt))}`;
    $('prs-lead').textContent =
      `${t.prs} PRs you opened in the last 30 days, ${t.merged} merged. ${t.linked} of them have the Claude Code sessions behind them in your local logs. ` +
      'There is no overall score on purpose: read the four axes side by side.' +
      (d.error ? ` GitHub could not be reached, so this shows the last saved data (${d.error}).` : '');
    renderAxes(d);
    renderScatter(d);
    renderTable(d);
    $('prs-status').hidden = true;
    root.setAttribute('aria-busy', 'false');
    if (first) requestAnimationFrame(replayEntrance);
  }

  async function load() {
    if (loading) return loading;
    root.classList.toggle('refreshing', Boolean(data));
    loading = (async () => {
      try {
        const res = await fetch('/api/prs', { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(String(res.status));
        render(await res.json());
      } catch {
        const st = $('prs-status');
        st.hidden = false;
        st.textContent = data ? 'Could not refresh. Showing the last result.' : 'Could not build the PR analysis. Check that `gh` is logged in, then reload.';
      } finally {
        root.classList.remove('refreshing');
        loading = null;
      }
    })();
    return loading;
  }

  function show() {
    pendingEntrance = true;
    prepareEntrance();
    if (data) render(data);
    load();
    clearInterval(timer);
    timer = setInterval(() => {
      if (!root.hidden) load();
    }, 120000);
  }

  if (location.hash === '#prs') show();
  return { show };
})();
