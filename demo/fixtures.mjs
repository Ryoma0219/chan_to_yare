// Dummy data for README screenshots. Shapes match /api/state, /api/insights, /api/prs and /api/ended.
// Every timestamp is relative to `now`, so the screenshots look the same whenever they are taken.

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// small deterministic PRNG so every run draws the same charts
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORG = 'northwind';
const prUrl = (repo, number) => `https://github.com/${ORG}/${repo}/pull/${number}`;

/* ------------------------------------------------------------
   Live: /api/state
   ------------------------------------------------------------ */
export function state(now = Date.now()) {
  const ago = (ms) => now - ms;
  // [start, end] pairs in "minutes ago"; end null = still running
  const turns = (...pairs) => pairs.map(([a, b]) => [ago(a * MIN), b == null ? null : ago(b * MIN)]);

  // terminal: 'cmux' | 'tmux' | null (Open / Send / Exit に対応していない端末)
  const TERMINALS = { cmux: 'cmux', tmux: 'tmux' };
  const tabOf = (terminal, title, workspace) =>
    terminal ? { terminal, label: TERMINALS[terminal], title, workspace, can: { focus: true, send: true } } : null;

  const base = (n, { workspace, terminal = 'cmux', ...o }) => ({
    id: uuid(n),
    pid: 40000 + n,
    name: o.title,
    waitingFor: null,
    pendingTool: null,
    rawStatus: o.state === 'work' ? 'busy' : 'idle',
    lastActivityAt: o.state === 'work' ? ago(4000) : null,
    worktree: null,
    branch: 'main',
    prs: [],
    costUSD: null,
    turns: [],
    ...o,
    cwd: `~/code/${o.repo}${o.worktree ? `/.claude/worktrees/${o.worktree}` : ''}`,
    tab: tabOf(terminal, o.title, workspace),
  });

  const sessions = [
    base(1, {
      state: 'ask',
      pendingTool: 'AskUserQuestion',
      title: 'Move checkout to the Payment Element',
      repo: 'storefront',
      workspace: 'checkout',
      worktree: 'payment-element',
      branch: 'dev/payment-element',
      prs: [{ number: 412, url: prUrl('storefront', 412) }],
      since: ago(4 * MIN),
      turns: turns([150, 128], [96, 61], [40, 4]),
      lastPrompt: 'Wire the new Payment Element into the checkout page and keep Apple Pay working.',
      lastPromptAt: ago(40 * MIN),
      lastReply:
        'The Payment Element is in place and the card form renders. Before I remove the old `CardField`, one question: should saved cards stay as a separate list, or move inside the Payment Element?',
      lastReplyAt: ago(4 * MIN),
    }),
    base(2, {
      state: 'ask',
      pendingTool: 'Bash',
      title: 'Fix the flaky CartSummary test',
      repo: 'storefront',
      workspace: 'checkout',
      branch: 'fix/cart-summary-flake',
      since: ago(90 * 1000),
      turns: turns([22, 1.5]),
      lastPrompt: 'CartSummary.test.tsx fails about one run in ten on CI. Find out why and fix it.',
      lastPromptAt: ago(22 * MIN),
      lastReply: 'The test reads the clock before the fake timers start. I want to run the suite 50 times to confirm the fix.',
      lastReplyAt: ago(90 * 1000),
    }),
    base(3, {
      state: 'reply',
      title: 'Rate limit the invoices endpoint',
      repo: 'billing-api',
      workspace: 'billing',
      worktree: 'invoice-rate-limit',
      branch: 'dev/invoice-rate-limit',
      prs: [{ number: 238, url: prUrl('billing-api', 238) }],
      since: ago(12 * MIN),
      costUSD: 4.82,
      turns: turns([170, 140], [118, 85], [55, 12]),
      lastPrompt: 'Add a per-account rate limit to GET /v1/invoices. Return 429 with Retry-After, and add tests.',
      lastPromptAt: ago(55 * MIN),
      lastReply: [
        '## Done: per-account rate limit on `/v1/invoices`',
        '',
        'Requests are now limited to **60 per minute per account**, counted in Redis with a sliding window.',
        '',
        '| Case | Response |',
        '|---|---|',
        '| Under the limit | 200, with `X-RateLimit-Remaining` |',
        '| Over the limit | 429, with `Retry-After` in seconds |',
        '| Redis unreachable | 200 (fails open, logged as a warning) |',
        '',
        '- Added `RateLimiter` in `lib/rate_limiter.rb` and 9 request specs, all passing.',
        '- Opened PR #238 and asked for a review.',
        '',
        'One thing to decide: should internal admin tokens skip the limit?',
      ].join('\n'),
      lastReplyAt: ago(12 * MIN),
    }),
    base(4, {
      state: 'reply',
      title: 'Why search is slow on staging',
      repo: 'storefront',
      workspace: 'search',
      since: ago(38 * MIN),
      costUSD: 2.17,
      turns: turns([75, 38]),
      lastPrompt: 'Search takes 3 seconds on staging but 300 ms locally. Find out why.',
      lastPromptAt: ago(75 * MIN),
      lastReply:
        'Staging is missing the `products_name_trgm` index, so every query does a sequential scan of 1.2M rows. Production has the index. Adding it brings the query down to 40 ms.',
      lastReplyAt: ago(38 * MIN),
    }),
    base(5, {
      state: 'work',
      pendingTool: 'Edit',
      title: 'Dark mode for the settings screen',
      repo: 'mobile-app',
      workspace: 'mobile',
      worktree: 'settings-dark-mode',
      branch: 'dev/settings-dark-mode',
      since: ago(6 * MIN),
      turns: turns([130, 104], [70, 42], [6, null]),
      lastPrompt: 'Make the settings screen follow the system theme. Use the tokens in theme.ts, no hard-coded colors.',
      lastPromptAt: ago(6 * MIN),
      lastReply: 'Theme tokens are wired into the first two sections.',
      lastReplyAt: ago(42 * MIN),
    }),
    base(6, {
      state: 'work',
      rawStatus: 'shell',
      title: 'Upgrade CI to Node 22',
      repo: 'infra',
      workspace: 'infra',
      terminal: 'tmux',
      branch: 'chore/node-22',
      since: ago(2 * MIN),
      turns: turns([48, 30], [2, null]),
      lastPrompt: 'Bump every CI workflow to Node 22 and make sure the build still passes.',
      lastPromptAt: ago(2 * MIN),
      lastReply: 'Updated 6 workflow files.',
      lastReplyAt: ago(30 * MIN),
    }),
    base(7, {
      state: 'work',
      pendingTool: 'mcp__claude_ai_Sentry__search_issues',
      title: 'Triage checkout errors from Sentry',
      repo: 'storefront',
      workspace: 'checkout',
      since: ago(9 * MIN),
      turns: turns([9, null]),
      lastPrompt: 'Look at the checkout errors in Sentry from the last 24 hours and group them by cause.',
      lastPromptAt: ago(9 * MIN),
      lastReply: null,
      lastReplyAt: null,
    }),
    base(8, {
      state: 'work',
      title: 'Release notes for v2.8',
      repo: 'mobile-app',
      workspace: 'mobile',
      since: ago(40 * 1000),
      turns: turns([16, 11], [0.7, null]),
      lastPrompt: 'Write the App Store release notes for v2.8 from the merged PRs since v2.7.',
      lastPromptAt: ago(40 * 1000),
      lastReply: 'Here is a first draft.',
      lastReplyAt: ago(11 * MIN),
    }),
    base(9, {
      state: 'dormant',
      title: 'Read the onboarding funnel numbers',
      repo: 'analytics',
      workspace: 'analytics',
      terminal: null,
      since: ago(19 * HOUR),
      costUSD: 3.4,
      lastPrompt: 'How many sign-ups finished onboarding last week?',
      lastPromptAt: ago(19 * HOUR + 6 * MIN),
      lastReply: '68% of last week’s sign-ups finished onboarding, up from 61%.',
      lastReplyAt: ago(19 * HOUR),
    }),
    base(10, {
      state: 'dormant',
      title: 'Draft the Q1 on-call rotation',
      repo: 'infra',
      workspace: 'infra',
      terminal: 'tmux',
      since: ago(2 * DAY + 3 * HOUR),
      costUSD: 0.92,
      lastPrompt: 'Draft an on-call rotation for Q1 with 6 people.',
      lastPromptAt: ago(2 * DAY + 3 * HOUR + 4 * MIN),
      lastReply: 'Draft rotation saved to docs/oncall-q1.md.',
      lastReplyAt: ago(2 * DAY + 3 * HOUR),
    }),
    base(11, {
      state: 'dormant',
      title: 'Explain the webhook retry logic',
      repo: 'billing-api',
      workspace: 'billing',
      since: ago(4 * DAY),
      costUSD: 1.25,
      lastPrompt: 'How do webhook retries work in this repo?',
      lastPromptAt: ago(4 * DAY + 5 * MIN),
      lastReply: 'Retries use exponential backoff, up to 8 attempts over about 3 days.',
      lastReplyAt: ago(4 * DAY),
    }),
  ];

  return { now, sessions, terminals: [{ id: 'tmux', label: 'tmux' }, { id: 'cmux', label: 'cmux' }] };
}

/* ------------------------------------------------------------
   Last 7 days: /api/insights
   ------------------------------------------------------------ */
export function insights(now = Date.now()) {
  const rand = rng(7);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const slotsNow = Math.floor((now - today.getTime()) / (15 * MIN));

  const days = [];
  for (let d = 6; d >= 0; d--) {
    const start = new Date(today);
    start.setDate(start.getDate() - d);
    const weekend = start.getDay() === 0 || start.getDay() === 6;
    const scale = weekend ? 0.35 : 1;
    const working = [];
    const waiting = [];
    for (let i = 0; i < 96; i++) {
      const hr = i / 4;
      if (d === 0 && i > slotsNow) {
        working.push(0);
        waiting.push(0);
        continue;
      }
      // a work day: morning and afternoon blocks, a lunch dip, a quieter evening
      let level = 0;
      if (hr >= 9 && hr < 12.5) level = 2.6;
      else if (hr >= 13.5 && hr < 18.5) level = 3.4;
      else if (hr >= 20 && hr < 23) level = 1.1;
      const w = level ? Math.max(0, level * scale + (rand() - 0.5) * 1.8) : 0;
      // waits trail the work and linger a little after it stops
      const wt = level ? Math.max(0, level * 0.6 * scale + (rand() - 0.4) * 1.2) : hr >= 18.5 && hr < 20 ? 1.2 * scale : 0;
      working.push(Math.round(w * 1000) / 1000);
      waiting.push(Math.round(wt * 1000) / 1000);
    }
    const busy = working.reduce((a, b) => a + b, 0);
    days.push({
      key: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`,
      start: start.getTime(),
      claudeMs: Math.round(busy * 15 * MIN),
      costUSD: Math.round(busy * 0.62 * 100) / 100,
      prompts: Math.round(busy * 0.55),
      prs: weekend ? 1 : 3 + Math.floor(rand() * 4),
      replyMedianMs: Math.round((60 + rand() * 180) * 1000),
      working,
      waiting,
    });
  }

  const sum = (k) => days.reduce((a, d) => a + d[k], 0);
  const repos = [
    ['storefront', 0.38, 21, 168, 11],
    ['billing-api', 0.22, 12, 94, 6],
    ['mobile-app', 0.18, 10, 77, 5],
    ['infra', 0.1, 7, 41, 3],
    ['analytics', 0.06, 6, 30, 0],
    ['design-system', 0.04, 3, 18, 1],
    ['dotfiles', 0.02, 2, 9, 0],
  ];
  const claudeMs = sum('claudeMs');
  const costUSD = sum('costUSD');

  return {
    generatedAt: now,
    from: days[0].start,
    to: now,
    totals: {
      claudeMs,
      sessions: 61,
      prompts: sum('prompts'),
      prs: sum('prs'),
      costUSD,
      replyMedianMs: 104000,
      replyP75Ms: 412000,
      replies: 318,
    },
    days,
    replyBuckets: [
      { label: '< 1m', count: 96 },
      { label: '1–5m', count: 118 },
      { label: '5–15m', count: 54 },
      { label: '15–60m', count: 29 },
      { label: '1–4h', count: 12 },
      { label: '4h+', count: 9 },
    ],
    repos: repos.map(([repo, share, sessions, prompts, prs]) => ({
      repo,
      claudeMs: Math.round(claudeMs * share),
      sessions,
      prompts,
      prs,
      costUSD: Math.round(costUSD * share * 100) / 100,
    })),
    prSplit: [
      { key: 'pr', sessions: 24, claudeMs: Math.round(claudeMs * 0.64), prompts: 251, costUSD: costUSD * 0.62, medianClaudeMs: 52 * MIN, medianPrompts: 4, medianCostUSD: 6.8, replyMedianMs: 98000 },
      { key: 'none', sessions: 37, claudeMs: Math.round(claudeMs * 0.36), prompts: 186, costUSD: costUSD * 0.38, medianClaudeMs: 9 * MIN, medianPrompts: 2, medianCostUSD: 1.4, replyMedianMs: 121000 },
    ],
    models: [
      { model: 'claude-opus-5-5', costUSD: costUSD * 0.93, outputTokens: 4210000 },
      { model: 'claude-sonnet-5-5', costUSD: costUSD * 0.06, outputTokens: 880000 },
      { model: 'claude-haiku-5-5', costUSD: costUSD * 0.01, outputTokens: 310000 },
    ],
    tools: [
      { name: 'Bash', count: 3412 },
      { name: 'Read', count: 2876 },
      { name: 'Edit', count: 1544 },
      { name: 'Grep', count: 1102 },
      { name: 'Write', count: 388 },
      { name: 'Agent', count: 214 },
      { name: 'mcp__claude_ai_Sentry__search_issues', count: 131 },
      { name: 'WebFetch', count: 97 },
      { name: 'mcp__plugin_chrome-devtools-mcp_chrome-devtools__take_screenshot', count: 64 },
      { name: 'AskUserQuestion', count: 41 },
    ],
    skills: [
      { name: 'create-pr', count: 23 },
      { name: 'superpowers:brainstorming', count: 14 },
      { name: 'code-review', count: 12 },
      { name: 'superpowers:systematic-debugging', count: 9 },
      { name: 'run', count: 7 },
      { name: 'superpowers:writing-plans', count: 5 },
      { name: 'simplify', count: 3 },
    ],
    perms: { auto: 6120, you: 58, blocked: 11, declined: 4 },
    interrupts: 14,
    subagents: 27,
    slotMinutes: 15,
    waitCapHours: 3,
  };
}

/* ------------------------------------------------------------
   PRs: /api/prs
   ------------------------------------------------------------ */
const PR_LIST = [
  // [repo, number, title, state, daysAgo, additions, deletions, prompts, costUSD, extras]
  ['storefront', 412, 'Move checkout to the Payment Element', 'DRAFT', 0.1, 486, 212, 9, 14.2],
  ['billing-api', 238, 'Rate limit GET /v1/invoices per account', 'OPEN', 0.3, 214, 18, 4, 4.8, { reviewers: ['maya-k'], reviewComments: 2, createToReviewMs: 25 * MIN }],
  ['storefront', 409, 'Fix the flaky CartSummary test', 'MERGED', 1.2, 22, 9, 3, 1.1, { reviewers: ['devon-r'] }],
  ['mobile-app', 187, 'Follow the system theme on the profile screen', 'MERGED', 1.6, 341, 120, 6, 7.9, { reviewers: ['sam-t'], reviewComments: 3 }],
  ['infra', 96, 'Cache node_modules between CI jobs', 'MERGED', 2.1, 48, 12, 2, 1.6],
  ['storefront', 405, 'Add a trigram index for product search', 'MERGED', 2.4, 31, 0, 2, 0.9, { reviewers: ['devon-r'] }],
  ['billing-api', 235, 'Retry failed webhooks with jittered backoff', 'MERGED', 3.0, 167, 44, 5, 5.2, { reviewers: ['maya-k'], reviewComments: 4, changesRequested: 1 }],
  ['design-system', 58, 'Add a Tooltip component', 'MERGED', 3.5, 402, 6, 4, 6.1, { reviewers: ['lena-p'] }],
  ['storefront', 401, 'Show delivery estimates on the cart page', 'MERGED', 4.1, 268, 73, 7, 9.4, { reviewers: ['devon-r'], reviewComments: 5, rework: { number: 418, lines: 26, files: ['src/cart/DeliveryEstimate.tsx'] } }],
  ['mobile-app', 184, 'Crash on launch when offline', 'MERGED', 4.4, 38, 15, 3, 2.3, { reviewers: ['sam-t'] }],
  ['analytics', 41, 'Weekly onboarding funnel query', 'CLOSED', 5.0, 120, 0, 2, 1.4],
  ['billing-api', 231, 'Prorate plan changes mid-cycle', 'MERGED', 5.6, 512, 140, 11, 18.7, { reviewers: ['maya-k', 'omar-b'], reviewComments: 9, changesRequested: 1 }],
  ['storefront', 398, 'Lazy-load product images below the fold', 'MERGED', 6.2, 74, 31, 2, 1.8, { revertedBy: prUrl('storefront', 399) }],
  ['infra', 93, 'Move staging to the new VPC', 'MERGED', 7.0, 890, 410, 14, 22.5, { reviewers: ['omar-b'], reviewComments: 6 }],
  ['mobile-app', 180, 'Deep links for order tracking', 'MERGED', 7.8, 233, 40, 5, 6.6, { reviewers: ['sam-t'], reviewComments: 2 }],
  ['storefront', 394, 'Typo in the returns policy page', 'MERGED', 8.3, 2, 2, 1, 0.12],
  ['billing-api', 228, 'Export invoices as CSV', 'MERGED', 9.1, 188, 12, 4, 4.1, { reviewers: ['maya-k'] }],
  ['design-system', 55, 'Tokens for dark mode surfaces', 'MERGED', 9.9, 156, 88, 3, 3.2, { reviewers: ['lena-p'] }],
  ['storefront', 390, 'Gift cards at checkout', 'MERGED', 11.0, 1240, 260, 18, 31.4, { reviewers: ['devon-r', 'maya-k'], reviewComments: 14, changesRequested: 1, rework: { number: 397, lines: 64, files: ['src/checkout/GiftCard.tsx', 'src/checkout/summary.ts'] } }],
  ['mobile-app', 176, 'Upgrade to React Native 0.80', 'MERGED', 12.2, 2100, 1650, 12, 19.8, { reviewers: ['sam-t'], reviewComments: 4 }],
  ['infra', 90, 'Alert when the job queue backs up', 'MERGED', 13.0, 64, 4, 2, 1.3],
  ['storefront', 386, 'Remember the last used shipping address', 'MERGED', 14.5, 142, 38, 4, 3.6, { reviewers: ['devon-r'] }],
  ['billing-api', 224, 'Stop double-charging on retried payments', 'MERGED', 15.8, 96, 21, 6, 5.9, { reviewers: ['maya-k', 'omar-b'], reviewComments: 7 }],
  ['analytics', 38, 'Daily revenue dashboard query', 'MERGED', 17.0, 88, 10, 3, 2.0],
  ['mobile-app', 172, 'Haptics on add to cart', 'MERGED', 18.4, 26, 3, 1, 0.6, { reviewers: ['sam-t'] }],
  ['storefront', 381, 'Split the product page bundle', 'MERGED', 19.9, 310, 280, 5, 5.5, { reviewers: ['devon-r'], reviewComments: 3 }],
  ['dotfiles', 12, 'Add a statusline script', 'MERGED', 21.0, 54, 0, 2, 0.8],
  ['billing-api', 219, 'Tax rates for the EU', 'MERGED', 22.6, 640, 92, 9, 12.3, { reviewers: ['omar-b'], reviewComments: 5, rework: { number: 226, lines: 18, files: ['app/models/tax_rate.rb'] } }],
  ['storefront', 377, 'Wishlist sharing links', 'MERGED', 24.1, 205, 22, 4, 4.4, { reviewers: ['maya-k'] }],
  ['infra', 86, 'Rotate database credentials monthly', 'MERGED', 25.5, 118, 30, 3, 2.7, { reviewers: ['omar-b'] }],
  ['mobile-app', 168, 'Pull to refresh on the orders list', 'OPEN', 26.8, 61, 9, 2, 1.2],
  ['storefront', 372, 'Accessibility pass on the header', 'MERGED', 28.0, 96, 64, 3, 2.1, { reviewers: ['lena-p'], reviewComments: 2 }],
  ['design-system', 51, 'Button loading state', 'MERGED', 2.8, 44, 8, 1, 0.7, { linked: false }],
];

const SESSION_TITLES = {
  'storefront 390': ['Gift cards at checkout', 'Gift card review fixes'],
  'infra 93': ['Move staging to the new VPC', 'Fix staging DNS after the VPC move'],
  'mobile-app 176': ['Upgrade to React Native 0.80'],
};

export function prs(now = Date.now()) {
  const rand = rng(42);
  const list = PR_LIST.map(([repo, number, title, state, daysAgo, additions, deletions, prompts, costUSD, x = {}]) => {
    const createdAt = now - Math.round(daysAgo * DAY);
    const merged = state === 'MERGED';
    const lines = additions + deletions;
    const linked = x.linked ?? true;
    const createToMergeMs = merged ? Math.round((0.4 + rand() * 20) * HOUR) : null;
    const claudeMs = linked ? Math.round((8 + Math.sqrt(lines) * 2.4 + rand() * 10) * MIN) : null;
    const waitMs = linked ? Math.round(claudeMs * (2 + rand() * 4)) : null;
    const tools = linked ? Math.round(prompts * (8 + rand() * 30)) : null;
    const rework = x.rework ? [{ url: prUrl(repo, x.rework.number), number: x.rework.number, title: `Follow-up to #${number}`, lines: x.rework.lines, files: x.rework.files }] : [];
    const reworkLines = rework.reduce((a, w) => a + w.lines, 0);
    const titles = SESSION_TITLES[`${repo} ${number}`] ?? [title];
    const sessions = linked
      ? titles.map((t, i) => ({
          id: uuid(5000 + number * 10 + i),
          title: t,
          prompts: Math.max(1, Math.round(prompts / titles.length)),
          first: createdAt - (i + 1) * 2 * HOUR,
          last: createdAt - i * HOUR,
          costUSD: costUSD / titles.length,
          contextTokens: Math.round(60000 + prompts * 14000 + rand() * 30000),
          running: false,
        }))
      : [];
    return {
      url: prUrl(repo, number),
      repo: `${ORG}/${repo}`,
      number,
      title,
      state,
      createdAt,
      mergedAt: merged ? createdAt + createToMergeMs : null,
      additions,
      deletions,
      lines,
      changedFiles: Math.max(1, Math.round(lines / 40)),
      linked,
      prompts: linked ? prompts : null,
      tools,
      toolsPerPrompt: linked ? tools / prompts : null,
      claudeMs,
      waitMs,
      waitShare: linked ? waitMs / (waitMs + claudeMs) : null,
      costUSD: linked ? costUSD : null,
      claudeMsPer100Lines: linked && lines ? (claudeMs / lines) * 100 : null,
      interrupts: prompts > 8 ? 1 : 0,
      youApprovals: 0,
      subagents: prompts > 6 ? 2 : 0,
      skills: linked ? ['create-pr', ...(prompts > 8 ? ['superpowers:writing-plans'] : [])] : [],
      sessions,
      startToCreateMs: linked ? Math.round((20 + rand() * 90) * MIN) : null,
      createToMergeMs,
      createToReviewMs: x.createToReviewMs ?? (x.reviewers ? Math.round((10 + rand() * 180) * MIN) : null),
      changesRequested: x.changesRequested ?? 0,
      reviewComments: x.reviewComments ?? 0,
      reviewers: x.reviewers ?? [],
      revertedBy: x.revertedBy ?? null,
      rework,
      reworkLines,
      addedLines: additions,
      reworkShare: additions ? reworkLines / additions : 0,
      reworkWindowOpen: merged && daysAgo < 21,
    };
  });

  const weekStart = (() => {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d.getTime();
  })();
  const weeks = [4, 3, 2, 1, 0].map((k, i) => ({
    start: weekStart - k * 7 * DAY,
    prs: [6, 7, 8, 7, 5][i],
    merged: [6, 6, 7, 6, 3][i],
    promptsPerPR: [6, 5, 4.5, 4, 3][i],
    toolsPerPrompt: [14, 17, 19.5, 22, 26][i],
    waitShare: [0.84, 0.81, 0.78, 0.76, 0.72][i],
    costPerMerged: [6.4, 5.9, 5.1, 4.8, 4.2][i],
    createToMergeMs: [26, 19, 14, 11, 7][i] * HOUR,
    reworkRate: [0.031, 0.024, 0.018, 0.012, null][i],
    metaShare: [0.03, 0.05, 0.08, 0.06, 0.09][i],
    promptsPerSession: [4, 3, 3, 3, 2][i],
  }));

  const merged = list.filter((p) => p.state === 'MERGED');
  return {
    generatedAt: now,
    since: now - 30 * DAY,
    login: 'you',
    totals: {
      prs: list.length,
      merged: merged.length,
      linked: list.filter((p) => p.linked).length,
      costPerMerged: 4.9,
      totalCostMerged: merged.reduce((a, p) => a + (p.costUSD ?? 0), 0),
      promptsPerPR: 4,
      toolsPerPrompt: 19.6,
      waitShare: 0.77,
      claudePer100Lines: 7.5 * MIN,
      createToMerge: 9.5 * HOUR,
      createToReview: 48 * MIN,
      startToCreate: 52 * MIN,
      reworkRate: 0.019,
      reworkSettled: merged.filter((p) => !p.reworkWindowOpen).length,
      reworkPRs: list.filter((p) => p.reworkLines >= 3).length,
      reverted: list.filter((p) => p.revertedBy).length,
      changesRequested: list.reduce((a, p) => a + p.changesRequested, 0),
      sessions: 214,
      promptsPerSession: 3,
      metaShare: 0.06,
    },
    weeks,
    prs: list,
    error: null,
  };
}

/* ------------------------------------------------------------
   Ended: /api/ended
   ------------------------------------------------------------ */
const ENDED = [
  // [hoursAgo, title, repo, worktree, branch, prs [[repo, number]], contextTokens, first, last, extras]
  [1.5, 'Move checkout to the Payment Element', 'storefront', 'payment-element', 'you/payment-element', [['storefront', 412]], 212000,
    'Replace the Card Element on the checkout page with the Payment Element. Keep Apple Pay working.',
    'Open a draft PR and list what is left for wallets.'],
  [3.2, 'Retry failed webhooks with jittered backoff', 'billing-api', null, 'you/webhook-backoff', [['billing-api', 235]], 148000,
    'Webhooks to slow customers keep failing. Retry them with exponential backoff and jitter, up to 24 hours.',
    'The review asked for a dead letter queue. Add it.', { name: 'webhook retries' }],
  [6.8, 'Why the nightly export job got slower', 'analytics', null, 'main', [], 96000,
    'The nightly export took 3 hours last night instead of 40 minutes. Find out why.',
    'Write the findings up as a comment on the incident ticket.'],
  [9.5, 'Follow the system theme on the profile screen', 'mobile-app', null, 'you/system-theme', [['mobile-app', 187]], 305000,
    'The profile screen ignores dark mode. Follow the system theme like the rest of the app.',
    'Check it on Android 12 and on an old iPhone.'],
  [20, 'Cache node_modules between CI jobs', 'infra', null, 'you/ci-cache', [['infra', 96]], 74000,
    'CI spends 4 minutes installing dependencies on every job. Cache node_modules keyed on the lockfile.',
    'Merged. Watch the next few runs and tell me the cache hit rate.'],
  [26, 'Add a Tooltip component', 'design-system', 'tooltip', 'you/tooltip', [['design-system', 58]], 182000,
    'Add a Tooltip that works with keyboard focus and respects reduced motion.',
    'Add stories for the four placements.', { gone: true }],
  [49, 'Prorate plan changes mid-cycle', 'billing-api', null, 'you/proration', [['billing-api', 231]], 468000,
    'When a customer upgrades mid-cycle, charge only the difference for the rest of the period.',
    'Add a test for a downgrade on the last day of the cycle.'],
  [73, 'Weekly onboarding funnel query', 'analytics', null, 'main', [['analytics', 41]], 58000,
    'Write a query for the weekly onboarding funnel: signup, first project, first invite.',
    'Close the PR, we will use the dashboard instead.'],
];

export function ended(now = Date.now(), q = '') {
  const prState = new Map(PR_LIST.map(([repo, number, title, state]) => [`${repo} ${number}`, { title, state }]));
  const rows = ENDED.map(([hoursAgo, title, repo, worktree, branch, prs, contextTokens, first, last, x = {}], i) => ({
    id: uuid(9000 + i),
    title,
    name: x.name ?? null,
    repo,
    worktree,
    branch,
    cwd: `~/code/${repo}${worktree ? `/.claude/worktrees/${worktree}` : ''}`,
    lastActivityAt: now - Math.round(hoursAgo * HOUR),
    firstPrompt: first,
    lastPrompt: last,
    lastReply: null,
    contextTokens,
    prs: prs.map(([r, n]) => ({ url: prUrl(r, n), number: n, ...(prState.get(`${r} ${n}`) ?? { title: null, state: null }) })),
    match: null,
    resumable: !x.gone,
    handoffCwd: `~/code/${repo}`,
  }));
  const terms = String(q).normalize('NFKC').toLowerCase().split(/\s+/u).filter(Boolean);
  if (!terms.length) return { sessions: rows };
  const hay = (r) => [r.title, r.name, r.repo, r.worktree, r.branch, r.firstPrompt, r.lastPrompt, ...r.prs.flatMap((p) => [`#${p.number}`, p.title])].filter(Boolean).join('\n').toLowerCase();
  return { sessions: rows.filter((r) => terms.every((t) => hay(r).includes(t))) };
}
