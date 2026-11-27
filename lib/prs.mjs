// PR ごとの振り返り。会話ログ (Analytics のファイル状態) と GitHub の PR 情報を結ぶ。
//
// 総合スコアは作らない。4つの軸を並べる:
//   任せ度   依頼回数・依頼あたりのツール数・Claude があなたを待っていた割合
//   コスト   推定費用・変更100行あたりの Claude の作業時間
//   速さ     最初の依頼→PR 作成・作成→マージ・作成→最初のレビュー
//   品質     修正依頼・コメント・revert・21日以内の手戻り (自分の別 PR が同じファイルを変えた)

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = 30 * DAY_MS;
const REWORK_MS = 21 * DAY_MS;
const WAIT_CAP_MS = 2 * 60 * 60 * 1000;
// 自動レビューのボットは「人のレビュー」に数えない
const BOT = /(\[bot\]|bot)$|^(github-actions|copilot|copilot-pull-request-reviewer|coderabbitai|claude|devin-ai-integration|sonarcloud)$/i;
const REWORK_MIN_LINES = 3; // これ以上書き直された PR に印を付ける
// 手戻りの判定から外すファイル (誰が触っても変わる共有ファイル)
const NOISY = [/(^|\/)db\/schema\.rb$/, /\.lock$/, /(^|\/)(package-lock\.json|bun\.lockb?|yarn\.lock|pnpm-lock\.yaml)$/, /(^|\/)config\/locales\//, /(^|\/)CHANGELOG/i, /\.snap$/];
// AI の使い方を整える仕事 (スキル・指示書・hook の編集)
const META = /(\/\.claude\/(skills|commands|agents|hooks|plugins)\/|\/\.claude\/settings(\.local)?\.json$|\/\.claude\/[^/]+\.(sh|py|js|mjs)$|(^|\/)(CLAUDE|AGENTS|SKILL)\.md$)/;

const median = (xs) => {
  const a = xs.filter((x) => x != null && Number.isFinite(x)).sort((p, q) => p - q);
  if (!a.length) return null;
  const m = (a.length - 1) / 2;
  return (a[Math.floor(m)] + a[Math.ceil(m)]) / 2;
};

function weekStart(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  const dow = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - dow);
  return d.getTime();
}

export function computePRs({ files, prs, login, priceOf, patchOf, now = Date.now() }) {
  const since = now - WINDOW_MS;
  const mine = prs.filter((p) => p.createdAt >= since - REWORK_MS); // 手戻り判定用に少し前から持つ
  const byUrl = new Map(mine.map((p) => [p.url, p]));

  // セッション (本体ファイル) とサブエージェントのファイル
  const mains = [];
  const subsBySession = new Map();
  for (const st of files.values()) {
    if (st.kind === 'main') mains.push(st);
    else {
      const list = subsBySession.get(st.sessionId) ?? [];
      list.push(st);
      subsBySession.set(st.sessionId, list);
    }
  }

  const acc = new Map(); // url -> accumulator
  const accOf = (url) => {
    let a = acc.get(url);
    if (!a) {
      a = { prompts: 0, tools: 0, claudeMs: 0, waitMs: 0, costUSD: 0, interrupts: 0, youApprovals: 0, subagents: 0, skills: new Set(), sessions: [], firstPrompt: null, lastActivity: null };
      acc.set(url, a);
    }
    return a;
  };

  // 30日間のセッション全体 (Anthropic の「セッションあたりの依頼回数」と、使い方を整える仕事の割合)
  const sessionStats = [];

  for (const st of mains) {
    const linked = [...st.prs.entries()].filter(([url]) => byUrl.has(url)).sort((a, b) => a[1] - b[1]);
    const cost = (list) => list.reduce((s, [t, model, w]) => s + w * priceOf(model), 0);
    const usage = [...st.usage.values(), ...(subsBySession.get(st.sessionId) ?? []).flatMap((x) => [...x.usage.values()])];

    const promptsIn = st.prompts.filter((t) => t >= since);
    const claudeIn = st.turns.filter(([, e]) => e >= since).reduce((s, [a, b]) => s + (b - a), 0);
    const isMeta = st.edits.some(([, p]) => META.test(p));
    if (promptsIn.length || claudeIn) {
      sessionStats.push({ start: promptsIn[0] ?? st.turns.find(([, e]) => e >= since)?.[0] ?? now, prompts: promptsIn.length, claudeMs: claudeIn, isMeta, hasPR: linked.length > 0 });
    }
    if (!linked.length) continue;

    // 出来事を「どの PR の初出までに起きたか」で振り分ける
    const cut = linked.map(([, t]) => t);
    const pick = (t) => {
      for (let i = 0; i < cut.length; i++) if (t <= cut[i]) return linked[i][0];
      return linked[linked.length - 1][0];
    };
    const touched = new Set();
    const bump = (t, fn) => {
      const url = pick(t);
      touched.add(url);
      fn(accOf(url));
    };
    for (const t of st.prompts) bump(t, (a) => {
      a.prompts++;
      a.firstPrompt = a.firstPrompt == null ? t : Math.min(a.firstPrompt, t);
      a.lastActivity = Math.max(a.lastActivity ?? 0, t);
    });
    for (const [t] of st.tools) bump(t, (a) => a.tools++);
    for (const [s, e] of st.turns) bump(e, (a) => {
      a.claudeMs += e - s;
      a.lastActivity = Math.max(a.lastActivity ?? 0, e);
    });
    for (const [s, e] of st.waits) bump(e, (a) => (a.waitMs += Math.min(e - s, WAIT_CAP_MS)));
    for (const [t, model, w] of usage) bump(t, (a) => (a.costUSD += w * priceOf(model)));
    for (const t of st.interrupts) bump(t, (a) => a.interrupts++);
    for (const [t, kind] of st.perms) if (kind === 'you') bump(t, (a) => a.youApprovals++);
    for (const [t, name] of st.skills) bump(t, (a) => a.skills.add(name));
    for (const t of st.subagents) bump(t, (a) => a.subagents++);
    for (const url of touched) {
      accOf(url).sessions.push({ id: st.sessionId, title: st.title, prompts: st.prompts.length, first: st.prompts[0] ?? null, last: st.prompts[st.prompts.length - 1] ?? null, costUSD: cost(usage) });
    }
  }

  // 手戻り: この PR が足した行が、マージ後21日以内にマージされた自分の別 PR で消された (書き直された) か。
  // 行の中身のハッシュで照合する。共有ファイルや空行・閉じ括弧は数えない
  const usable = (f) => !NOISY.some((re) => re.test(f));
  const rows = [];
  for (const p of mine) {
    if (p.createdAt < since) continue;
    const a = acc.get(p.url);
    const lines = (p.additions ?? 0) + (p.deletions ?? 0);
    const others = (p.reviews ?? []).filter((r) => r.author && r.author !== login && !BOT.test(r.author) && r.at);
    const firstReview = others.length ? Math.min(...others.map((r) => r.at)) : null;
    const rework = [];
    let reworkLines = 0;
    let addedLines = 0;
    const patch = patchOf(p.url);
    if (p.mergedAt && patch) {
      const added = new Map(); // file -> Set(hash)
      for (const [f, hs] of Object.entries(patch.adds)) {
        if (!usable(f)) continue;
        added.set(f, new Set(hs));
        addedLines += new Set(hs).size;
      }
      const churned = new Map(); // file -> Set(hash)
      for (const q of mine) {
        if (q.url === p.url || q.repo !== p.repo || !q.mergedAt || q.mergedAt <= p.mergedAt || q.mergedAt > p.mergedAt + REWORK_MS) continue;
        const qp = patchOf(q.url);
        if (!qp) continue;
        let n = 0;
        const files = [];
        for (const [f, hs] of Object.entries(qp.dels)) {
          const mineSet = added.get(f);
          if (!mineSet) continue;
          const got = churned.get(f) ?? new Set();
          let k = 0;
          for (const h of hs) if (mineSet.has(h) && !got.has(h)) {
            got.add(h);
            k++;
          }
          churned.set(f, got);
          if (k) {
            n += k;
            files.push(f);
          }
        }
        if (n) rework.push({ url: q.url, number: q.number, title: q.title, lines: n, files });
      }
      for (const set of churned.values()) reworkLines += set.size;
    }
    const reworkWindowOpen = p.mergedAt ? now - p.mergedAt < REWORK_MS : null;
    rows.push({
      url: p.url,
      repo: p.repo,
      number: p.number,
      title: p.title,
      state: p.isDraft && p.state === 'OPEN' ? 'DRAFT' : p.state,
      createdAt: p.createdAt,
      mergedAt: p.mergedAt,
      additions: p.additions,
      deletions: p.deletions,
      lines,
      changedFiles: p.changedFiles,
      linked: Boolean(a),
      prompts: a?.prompts ?? null,
      tools: a?.tools ?? null,
      toolsPerPrompt: a && a.prompts ? a.tools / a.prompts : null,
      claudeMs: a?.claudeMs ?? null,
      waitMs: a?.waitMs ?? null,
      waitShare: a && a.claudeMs + a.waitMs > 0 ? a.waitMs / (a.claudeMs + a.waitMs) : null,
      costUSD: a?.costUSD ?? null,
      claudeMsPer100Lines: a && lines ? (a.claudeMs / lines) * 100 : null,
      interrupts: a?.interrupts ?? null,
      youApprovals: a?.youApprovals ?? null,
      subagents: a?.subagents ?? null,
      skills: a ? [...a.skills] : [],
      sessions: a?.sessions ?? [],
      startToCreateMs: a?.firstPrompt && a.firstPrompt < p.createdAt ? p.createdAt - a.firstPrompt : null,
      createToMergeMs: p.mergedAt ? p.mergedAt - p.createdAt : null,
      createToReviewMs: firstReview ? firstReview - p.createdAt : null,
      changesRequested: (p.reviews ?? []).filter((r) => r.state === 'CHANGES_REQUESTED').length,
      reviewComments: (p.comments ?? 0) + (p.threads ?? 0),
      reviewers: [...new Set(others.map((r) => r.author))],
      revertedBy: p.revertedBy ?? null,
      rework,
      reworkLines,
      addedLines,
      reworkShare: addedLines ? reworkLines / addedLines : null,
      reworkWindowOpen,
    });
  }
  rows.sort((x, y) => y.createdAt - x.createdAt);

  // 集計 (マージ済みを中心に)
  const merged = rows.filter((r) => r.mergedAt);
  const linkedRows = rows.filter((r) => r.linked);
  const settled = merged.filter((r) => !r.reworkWindowOpen);
  const sum = (xs, k) => xs.reduce((s, r) => s + (r[k] ?? 0), 0);
  const claudeAll = sum(linkedRows, 'claudeMs');
  const waitAll = sum(linkedRows, 'waitMs');
  const metaMs = sessionStats.filter((s) => s.isMeta).reduce((s, x) => s + x.claudeMs, 0);
  const allMs = sessionStats.reduce((s, x) => s + x.claudeMs, 0);

  const totals = {
    prs: rows.length,
    merged: merged.length,
    linked: linkedRows.length,
    costPerMerged: median(merged.filter((r) => r.linked).map((r) => r.costUSD)),
    totalCostMerged: sum(merged, 'costUSD'),
    promptsPerPR: median(linkedRows.map((r) => r.prompts)),
    toolsPerPrompt: median(linkedRows.map((r) => r.toolsPerPrompt)),
    waitShare: claudeAll + waitAll > 0 ? waitAll / (claudeAll + waitAll) : null,
    claudePer100Lines: median(merged.filter((r) => r.linked && r.lines >= 10).map((r) => r.claudeMsPer100Lines)),
    createToMerge: median(merged.map((r) => r.createToMergeMs)),
    createToReview: median(rows.map((r) => r.createToReviewMs)),
    startToCreate: median(rows.map((r) => r.startToCreateMs)),
    reworkRate: sum(settled, 'addedLines') ? sum(settled, 'reworkLines') / sum(settled, 'addedLines') : null,
    reworkSettled: settled.length,
    reworkPRs: merged.filter((r) => r.reworkLines >= REWORK_MIN_LINES).length,
    reverted: rows.filter((r) => r.revertedBy).length,
    changesRequested: rows.filter((r) => r.changesRequested > 0).length,
    sessions: sessionStats.length,
    promptsPerSession: median(sessionStats.map((s) => s.prompts)),
    metaShare: allMs ? metaMs / allMs : null,
  };

  // 週ごとの推移 (PR の作成週で分ける)
  const weeks = [];
  for (let w = weekStart(since); w <= now; w += 7 * DAY_MS) {
    const end = w + 7 * DAY_MS;
    const inWeek = rows.filter((r) => r.createdAt >= w && r.createdAt < end);
    const mergedW = inWeek.filter((r) => r.mergedAt);
    const linkedW = inWeek.filter((r) => r.linked);
    const settledW = mergedW.filter((r) => !r.reworkWindowOpen);
    const sess = sessionStats.filter((s) => s.start >= w && s.start < end);
    const c = sum(linkedW, 'claudeMs');
    const wt = sum(linkedW, 'waitMs');
    const sm = sess.reduce((s, x) => s + x.claudeMs, 0);
    weeks.push({
      start: w,
      prs: inWeek.length,
      merged: mergedW.length,
      promptsPerPR: median(linkedW.map((r) => r.prompts)),
      toolsPerPrompt: median(linkedW.map((r) => r.toolsPerPrompt)),
      waitShare: c + wt > 0 ? wt / (c + wt) : null,
      costPerMerged: median(mergedW.filter((r) => r.linked).map((r) => r.costUSD)),
      createToMergeMs: median(mergedW.map((r) => r.createToMergeMs)),
      reworkRate: sum(settledW, 'addedLines') ? sum(settledW, 'reworkLines') / sum(settledW, 'addedLines') : null,
      metaShare: sm ? sess.filter((s) => s.isMeta).reduce((s, x) => s + x.claudeMs, 0) / sm : null,
      promptsPerSession: median(sess.map((s) => s.prompts)),
    });
  }

  return { generatedAt: now, since, login, totals, weeks, prs: rows };
}
