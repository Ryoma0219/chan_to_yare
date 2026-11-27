'use strict';

// The "Last 7 days" view. Every chart is drawn with SVG / DOM only, text via textContent.
window.Insights = (() => {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const $ = (id) => document.getElementById(id);
  const root = $('insights');
  const tip = $('tip');
  let data = null;
  let loading = null;
  let timer = null;

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
  function hours(ms) {
    const hrs = ms / 3600000;
    if (hrs < 1) return `${Math.round(ms / 60000)} m`;
    return `${hrs < 10 ? hrs.toFixed(1) : Math.round(hrs)} h`;
  }
  function usd(x) {
    if (x >= 100) return `$${num.format(Math.round(x))}`;
    if (x >= 1) return `$${x.toFixed(1)}`;
    return `$${x.toFixed(2)}`;
  }
  function wait(ms) {
    if (ms == null) return '–';
    const m = ms / 60000;
    if (m < 1) return `${Math.round(ms / 1000)} s`;
    if (m < 60) return `${Math.round(m)} m`;
    return `${(m / 60).toFixed(1)} h`;
  }
  const weekdayFmt = new Intl.DateTimeFormat('en-US', { weekday: 'short' });
  const rangeFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
  const timeFmt = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  function dayLabel(d, i, all) {
    const dt = new Date(d.start);
    return i === all.length - 1 ? 'Today' : `${weekdayFmt.format(dt)} ${dt.getDate()}`;
  }
  function toolName(name) {
    const m = name.match(/^mcp__(.+?)__(.+)$/);
    if (!m) return name;
    const server = m[1].replace(/^claude_ai_/, '').replace(/[-_]mcp$/, '').replace(/^plugin_[^_]+_/, '');
    return `${server} · ${m[2]}`;
  }

  /* ---------- tooltip: values lead, labels follow ---------- */
  function showTip(x, y, title, rows) {
    tip.replaceChildren();
    tip.append(h('p', 'tip-title', title));
    for (const r of rows) {
      const line = h('p', 'tip-row');
      if (r.key) {
        const k = h('span', `tip-key ${r.key}`);
        line.append(k);
      }
      line.append(h('b', null, r.value), h('span', null, r.label));
      tip.append(line);
    }
    tip.hidden = false;
    const pad = 14;
    const w = tip.offsetWidth;
    const hgt = tip.offsetHeight;
    let left = x + pad;
    if (left + w > window.innerWidth - 8) left = x - w - pad;
    let top = y - hgt - pad;
    if (top < 8) top = y + pad;
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${top}px`;
  }
  function hideTip() {
    tip.hidden = true;
  }

  /* ---------- ledger ---------- */
  function renderLedger(t) {
    const items = [
      ['Claude worked', hours(t.claudeMs)],
      ['Sessions', num.format(t.sessions)],
      ['Your prompts', num.format(t.prompts)],
      ['PRs opened', num.format(t.prs)],
      ['Estimated cost', usd(t.costUSD)],
      ['Median reply', wait(t.replyMedianMs)],
    ];
    $('ledger').replaceChildren(
      ...items.map(([k, v]) => {
        const d = h('div', 'ledger-item');
        d.append(h('dt', null, k), h('dd', null, v));
        return d;
      }),
    );
  }

  /* ---------- signature: the week, hour by hour ---------- */
  function renderWeek(d) {
    const days = d.days;
    const peak = Math.max(1, ...days.flatMap((x) => [...x.working, ...x.waiting]));
    const top = Math.ceil(peak);
    const W = 960;
    const H = 30;
    const slots = days[0].working.length;
    const sx = W / slots;

    const legend = $('week-legend');
    legend.replaceChildren(
      ...[
        ['working', 'Claude working'],
        ['waiting', 'Waiting on you'],
      ].map(([k, label]) => {
        const li = h('li');
        li.append(h('span', `key ${k}`), document.createTextNode(label));
        return li;
      }),
    );
    $('week-note').textContent =
      `Height is the number of sessions at once (up to ${top}). Each wait counts for at most ${d.waitCapHours} h, so sessions left open overnight don’t fill the chart.`;

    const wrap = $('week');
    wrap.replaceChildren();

    const axis = h('div', 'week-row week-axis');
    axis.append(h('span'));
    const ticks = h('div', 'week-ticks');
    for (const hr of [0, 6, 12, 18, 24]) {
      const t = h('span', null, `${String(hr).padStart(2, '0')}:00`);
      t.style.left = `${(hr / 24) * 100}%`;
      ticks.append(t);
    }
    axis.append(ticks, h('span', 'week-total-head', 'Claude · cost'));
    wrap.append(axis);

    const area = (values, dir) => {
      // dir = -1 draws upward from the baseline, +1 downward
      let p = `M0 ${H}`;
      values.forEach((v, i) => {
        const y = H + dir * (v / top) * (H - 2);
        p += ` L${i * sx} ${y} L${(i + 1) * sx} ${y}`;
      });
      return `${p} L${W} ${H} Z`;
    };
    const line = (values, dir) => {
      let p = '';
      values.forEach((v, i) => {
        const y = H + dir * (v / top) * (H - 2);
        p += `${i ? ' L' : 'M'}${i * sx} ${y} L${(i + 1) * sx} ${y}`;
      });
      return p;
    };

    days.forEach((day, i) => {
      const row = h('div', 'week-row');
      const label = h('span', 'week-day', dayLabel(day, i, days));
      const plot = h('div', 'week-plot');
      const s = svg('svg', { viewBox: `0 0 ${W} ${H * 2}`, preserveAspectRatio: 'none', role: 'img' });
      s.setAttribute(
        'aria-label',
        `${dayLabel(day, i, days)}: Claude worked ${hours(day.claudeMs)}, peak ${Math.max(...day.working).toFixed(1)} sessions at once`,
      );
      for (const hr of [6, 12, 18]) {
        s.append(svg('line', { x1: (hr / 24) * W, x2: (hr / 24) * W, y1: 0, y2: H * 2, class: 'grid' }));
      }
      s.append(svg('path', { d: area(day.working, -1), class: 'area working' }));
      s.append(svg('path', { d: area(day.waiting, 1), class: 'area waiting' }));
      s.append(svg('path', { d: line(day.working, -1), class: 'stroke working', pathLength: 1 }));
      s.append(svg('path', { d: line(day.waiting, 1), class: 'stroke waiting', pathLength: 1 }));
      s.append(svg('line', { x1: 0, x2: W, y1: H, y2: H, class: 'base' }));
      if (i === days.length - 1) {
        const now = new Date(d.generatedAt);
        const x = ((now.getHours() * 60 + now.getMinutes()) / 1440) * W;
        s.append(svg('line', { x1: x, x2: x, y1: 2, y2: H * 2 - 2, class: 'now' }));
      }
      const cross = h('div', 'crosshair');
      cross.hidden = true;
      plot.append(s, cross);

      plot.addEventListener('pointermove', (e) => {
        const r = plot.getBoundingClientRect();
        const slot = Math.max(0, Math.min(slots - 1, Math.floor(((e.clientX - r.left) / r.width) * slots)));
        cross.hidden = false;
        cross.style.left = `${((slot + 0.5) / slots) * 100}%`;
        const t0 = day.start + slot * d.slotMinutes * 60000;
        const t1 = t0 + d.slotMinutes * 60000;
        showTip(e.clientX, r.top, `${dayLabel(day, i, days)} · ${timeFmt.format(t0)}–${timeFmt.format(t1)}`, [
          { key: 'working', value: day.working[slot].toFixed(1), label: 'sessions working' },
          { key: 'waiting', value: day.waiting[slot].toFixed(1), label: 'waiting on you' },
        ]);
      });
      plot.addEventListener('pointerleave', () => {
        cross.hidden = true;
        hideTip();
      });

      const total = h('span', 'week-total');
      total.append(h('b', null, hours(day.claudeMs)), document.createTextNode(` · ${usd(day.costUSD)}`));
      row.append(label, plot, total);
      wrap.append(row);
    });

    // table twin
    const table = h('table', 'mini-table');
    const head = h('tr');
    for (const c of ['Day', 'Claude worked', 'Peak working', 'Peak waiting', 'Prompts', 'Median reply', 'PRs', 'Est. cost']) head.append(h('th', null, c));
    table.append(head);
    days.forEach((day, i) => {
      const tr = h('tr');
      for (const c of [
        dayLabel(day, i, days),
        hours(day.claudeMs),
        Math.max(...day.working).toFixed(1),
        Math.max(...day.waiting).toFixed(1),
        num.format(day.prompts),
        wait(day.replyMedianMs),
        num.format(day.prs),
        usd(day.costUSD),
      ])
        tr.append(h('td', null, c));
      table.append(tr);
    });
    $('week-table').replaceChildren(table);
  }

  /* ---------- columns (reply histogram, cost per day) ---------- */
  function renderColumns(el, items, { cls, value, tipTitle, tipLabel }) {
    const max = Math.max(...items.map((x) => x.v), 0) || 1;
    el.replaceChildren();
    const plot = h('div', 'col-plot');
    for (const it of items) {
      const col = h('div', 'col');
      col.tabIndex = 0;
      const bar = h('div', `col-bar ${cls}`);
      bar.style.height = `${Math.max(it.v > 0 ? 2 : 0, (it.v / max) * 100)}%`;
      const val = h('span', 'col-value', value(it.v));
      const stack = h('div', 'col-stack');
      stack.append(val, bar);
      col.append(stack, h('span', 'col-label', it.label));
      const show = (x, y) => showTip(x, y, tipTitle(it), [{ key: cls, value: value(it.v), label: tipLabel }]);
      col.addEventListener('pointermove', (e) => show(e.clientX, e.clientY));
      col.addEventListener('pointerleave', hideTip);
      col.addEventListener('focus', () => {
        const r = col.getBoundingClientRect();
        show(r.left + r.width / 2, r.top);
      });
      col.addEventListener('blur', hideTip);
      plot.append(col);
    }
    el.append(plot);
  }

  function renderReplies(d) {
    const t = d.totals;
    $('reply-note').textContent = t.replies
      ? `Median ${wait(t.replyMedianMs)} · 3 in 4 replies within ${wait(t.replyP75Ms)} · ${num.format(t.replies)} replies`
      : 'No replies yet in this period.';
    renderColumns(
      $('reply-chart'),
      d.replyBuckets.map((b) => ({ label: b.label, v: b.count })),
      { cls: 'waiting', value: (v) => num.format(v), tipTitle: (it) => `Replied in ${it.label}`, tipLabel: 'replies' },
    );
  }

  function renderCost(d) {
    const models = d.models
      .filter((m) => m.costUSD >= 0.5)
      .map((m) => `${m.model.replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2')} ${usd(m.costUSD)}`);
    $('cost-note').textContent = `${usd(d.totals.costUSD)} in total${models.length ? ` · ${models.join(' · ')}` : ''}. Estimated from token usage.`;
    renderColumns(
      $('cost-chart'),
      d.days.map((day, i, all) => ({ label: dayLabel(day, i, all), v: day.costUSD })),
      { cls: 'working', value: usd, tipTitle: (it) => it.label, tipLabel: 'estimated' },
    );
  }

  /* ---------- repos ---------- */
  function renderRepos(d) {
    const table = $('repo-table');
    table.replaceChildren();
    const head = h('tr');
    const cols = [
      ['Repository', 'name'],
      ['Claude time', 'time'],
      ['Sessions', 'n'],
      ['Prompts', 'n'],
      ['PRs', 'n'],
      ['Est. cost', 'n'],
    ];
    for (const [c, cls] of cols) head.append(h('th', cls, c));
    const thead = h('thead');
    thead.append(head);
    table.append(thead);
    const body = h('tbody');
    const list = d.repos.slice(0, 10);
    const max = Math.max(1, ...list.map((r) => r.claudeMs));
    for (const r of list) {
      const tr = h('tr');
      tr.append(h('td', 'name', r.repo));
      const barCell = h('td', 'time');
      const inner = h('div', 'bar-cell');
      const track = h('div', 'hbar');
      const fill = h('span', 'hbar-fill working');
      fill.style.width = `${(r.claudeMs / max) * 100}%`;
      track.append(fill);
      inner.append(track, h('span', 'hbar-value', hours(r.claudeMs)));
      barCell.append(inner);
      tr.append(barCell);
      for (const v of [num.format(r.sessions), num.format(r.prompts), num.format(r.prs), usd(r.costUSD)]) tr.append(h('td', 'n', v));
      body.append(tr);
    }
    table.append(body);
  }

  /* ---------- sessions with a PR vs. without ---------- */
  function renderPrSplit(d) {
    const [pr, none] = d.prSplit;
    const groups = [
      { g: pr, cls: 'working', label: 'With a PR' },
      { g: none, cls: 'muted', label: 'Without a PR' },
    ];
    $('pr-legend').replaceChildren(
      ...groups.map(({ cls, label }) => {
        const li = h('li');
        li.append(h('span', `swatch ${cls}`), document.createTextNode(label));
        return li;
      }),
    );
    $('pr-note').textContent =
      'A session counts as “with a PR” when its branch had a pull request. Investigations, reviews without a PR and work on master count as “without”.';

    const rows = [
      ['Sessions', (g) => g.sessions, (v) => num.format(v)],
      ['Claude time', (g) => g.claudeMs, hours],
      ['Prompts', (g) => g.prompts, (v) => num.format(v)],
      ['Estimated cost', (g) => g.costUSD, usd],
    ];
    $('pr-shares').replaceChildren(
      ...rows.map(([label, get, fmt]) => {
        const total = get(pr) + get(none) || 1;
        const li = h('li');
        const share = Math.round((get(pr) / total) * 100);
        li.append(h('span', 'share-name', label), h('span', 'share-figure', `${share}% · ${100 - share}%`));
        const bar = h('div', 'segbar');
        bar.setAttribute('role', 'img');
        bar.setAttribute('aria-label', `${label}: with a PR ${fmt(get(pr))} (${share}%), without ${fmt(get(none))} (${100 - share}%)`);
        for (const { g, cls, label: name } of groups) {
          const part = h('span', `seg ${cls}`);
          part.style.flexGrow = String(get(g));
          const show = (x, y) =>
            showTip(x, y, `${label} · ${name}`, [{ key: cls, value: fmt(get(g)), label: `${Math.round((get(g) / total) * 100)}%` }]);
          part.addEventListener('pointermove', (e) => show(e.clientX, e.clientY));
          part.addEventListener('pointerleave', hideTip);
          if (get(g) > 0) bar.append(part);
        }
        li.append(bar);
        return li;
      }),
    );

    const table = $('pr-compare');
    table.replaceChildren();
    const head = h('tr');
    head.append(h('th', null, 'Per session (median)'));
    for (const { cls, label } of groups) {
      const th = h('th', 'n');
      th.append(h('span', `swatch ${cls}`), document.createTextNode(label));
      head.append(th);
    }
    const thead = h('thead');
    thead.append(head);
    const body = h('tbody');
    for (const [label, get] of [
      ['Claude time', (g) => (g.medianClaudeMs == null ? '–' : hours(g.medianClaudeMs))],
      ['Prompts', (g) => (g.medianPrompts == null ? '–' : num.format(Math.round(g.medianPrompts)))],
      ['Estimated cost', (g) => (g.medianCostUSD == null ? '–' : usd(g.medianCostUSD))],
      ['Your reply time', (g) => wait(g.replyMedianMs)],
    ]) {
      const tr = h('tr');
      tr.append(h('td', null, label));
      for (const { g } of groups) tr.append(h('td', 'n', get(g)));
      body.append(tr);
    }
    table.append(thead, body);
  }

  /* ---------- how Claude works ---------- */
  function renderRanked(el, items, format) {
    el.replaceChildren();
    if (!items.length) {
      el.append(h('li', 'ranked-empty', 'None in this period.'));
      return;
    }
    const max = Math.max(...items.map((x) => x.count));
    for (const it of items) {
      const li = h('li');
      const name = h('span', 'ranked-name', format(it.name));
      name.title = it.name;
      const track = h('div', 'hbar');
      const fill = h('span', 'hbar-fill working');
      fill.style.width = `${(it.count / max) * 100}%`;
      track.append(fill);
      li.append(name, h('span', 'ranked-count', num.format(it.count)), track);
      el.append(li);
    }
  }

  function renderHow(d) {
    renderRanked($('tools'), d.tools.slice(0, 10), toolName);
    renderRanked($('skills'), d.skills.slice(0, 10), (n) => n);
    const p = d.perms;
    const total = p.auto + p.you + p.blocked + p.declined || 1;
    const rows = [
      ['Approved automatically', p.auto, 'working'],
      ['Approved by you', p.you, 'waiting'],
      ['Blocked by the classifier', p.blocked, 'muted'],
      ['Declined by you', p.declined, 'muted'],
    ];
    $('approvals').replaceChildren(
      ...rows.map(([label, n, cls]) => {
        const li = h('li');
        const share = (n / total) * 100;
        li.append(h('span', 'meter-name', label), h('span', 'meter-figure', `${num.format(n)} · ${share < 1 && n ? '<1' : Math.round(share)}%`));
        const track = h('div', `meter ${cls}`);
        const fill = h('span', 'meter-fill');
        fill.style.width = `${Math.max(n ? 0.8 : 0, share)}%`;
        track.append(fill);
        li.append(track);
        return li;
      }),
    );
    $('how-figures').replaceChildren(
      ...[
        ['Interrupted by you', d.interrupts],
        ['Subagents launched', d.subagents],
      ].map(([k, v]) => {
        const item = h('div');
        item.append(h('dt', null, k), h('dd', null, num.format(v)));
        return item;
      }),
    );
  }

  /* ---------- load ---------- */
  // entrance: blocks reveal when they scroll into view; replayed each time the view is opened
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
            if (el.id === 'ledger') window.Look?.countUp(el);
            setTimeout(() => el.classList.add('settled'), 2600);
          }
        },
        { threshold: 0, rootMargin: '0px 0px -8% 0px' },
      )
    : null;
  const blocks = () => [$('ledger'), ...root.querySelectorAll('.panel')];
  // hide every block right away so nothing empty shows while the data loads
  function prepareEntrance() {
    for (const el of blocks()) {
      io?.unobserve(el);
      el.classList.add('anim', 'pre');
      el.classList.remove('in', 'settled');
    }
  }
  function replayEntrance() {
    for (const el of blocks()) {
      if (!el.classList.contains('pre')) continue;
      if (io) io.observe(el);
      else el.classList.replace('pre', 'in');
    }
  }
  function render(d) {
    const first = pendingEntrance;
    pendingEntrance = false;
    data = d;
    $('ins-range').textContent = `${rangeFmt.format(new Date(d.from))} – ${rangeFmt.format(new Date(d.to))} · updated ${timeFmt.format(new Date(d.generatedAt))}`;
    renderLedger(d.totals);
    renderWeek(d);
    renderPrSplit(d);
    renderReplies(d);
    renderCost(d);
    renderRepos(d);
    renderHow(d);
    $('ins-status').hidden = true;
    root.setAttribute('aria-busy', 'false');
    if (first) requestAnimationFrame(replayEntrance);
  }

  async function load() {
    if (loading) return loading;
    root.classList.toggle('refreshing', Boolean(data));
    loading = (async () => {
      try {
        const res = await fetch('/api/insights', { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(String(res.status));
        render(await res.json());
      } catch {
        const status = $('ins-status');
        status.hidden = false;
        status.textContent = data ? 'Could not refresh. Showing the last result.' : 'Could not read the session logs. Reload to try again.';
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
    }, 60000);
  }

  window.addEventListener('resize', hideTip);
  if (location.hash === '#insights') show();
  return { show };
})();
