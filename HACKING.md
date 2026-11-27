# Developing Chan to Yare

This document covers how Chan to Yare works and how to change it. For what
it is and how to install it, see the [README](README.md).

## Layout

Chan to Yare has three layers: a Node server, a web UI, and a thin native
macOS app. The server uses only the Node standard library and has no
dependencies.

| Path                     | Role                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| `server.mjs`             | HTTP server, SSE stream, and the API (`state`, `events`, `insights`, `prs`, `focus`, `memo`)  |
| `lib/collect.mjs`        | Finds running sessions, decides their state, maps them to cmux tabs, jumps tabs, sends notes  |
| `lib/transcript.mjs`     | Reads one conversation log incrementally and keeps its title, last exchange, and turns        |
| `lib/analytics.mjs`      | Reads 31 days of conversation logs incrementally and builds the Last 7 days view              |
| `lib/github.mjs`         | Fetches your pull requests, reviews, diffs, and reverts through `gh`, with a disk cache       |
| `lib/prs.mjs`            | Links pull requests to sessions and computes the four axes of the PRs view                    |
| `public/`                | The web UI: plain DOM and SVG, no framework                                                   |
| `public/themes.css`      | The color theme, as hues only                                                                 |
| `macos/ChanToYare.swift` | The macOS app: a WKWebView window, Dock badge, notifications, sound, and menus                |
| `macos/build.sh`         | Builds `~/Applications/Chan to Yare.app` with `swiftc` and signs it ad hoc                    |
| `launchd/`               | The LaunchAgent that keeps the server running                                                 |

## Running

```sh
node server.mjs   # http://127.0.0.1:7878, override the port with PORT=7979
```

Changes under `public/` show up on reload. Changes to `server.mjs` or
`lib/` need a server restart. Run `node --check <file>` after editing
JavaScript.

## Data sources

| Source                                   | Used for                                                                                     |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| `~/.claude/sessions/<pid>.json`          | Session state written by Claude Code itself: `busy`, `shell`, `idle`, or `waiting`           |
| `~/.claude/projects/*/<sessionId>.jsonl` | Conversation logs: title, prompts and replies, turn timing, token usage, tools, PR links     |
| `ps eww`                                 | Only `CMUX_SURFACE_ID` from each process, to know which cmux tab a session lives in          |
| `cmux tree --json`                       | Tab and workspace names                                                                      |
| `gh`                                     | Your pull requests: size, files, reviews, diffs, and reverts                                 |

Chan to Yare writes in only two ways: it focuses a cmux tab
(`select-workspace` and `focus-panel`), and it sends a note to a session
(`set-buffer`, `paste-buffer`, `send-key enter`).

## Live

### Session state

| `status`         | Condition                          | Shown as                          |
| ---------------- | ---------------------------------- | --------------------------------- |
| `waiting`        |                                    | Your turn, "Needs you"            |
| `idle`           | Last reply within 12 hours         | Your turn, "Your reply"           |
| `idle`           | No reply for 12 hours or more      | Untouched for 12+ hours           |
| `busy`, `shell`  |                                    | Claude's turn                     |

`waiting` means a permission prompt or a question is open, and
`waitingFor` says which. A working session with no log activity for three
minutes is marked "No activity".

### Reading conversation logs

Logs can grow to tens of megabytes. The first read takes the last 4 MB and
walks back 4 MB at a time until it finds a human prompt (up to 32 MB),
because screenshots can push the last prompt out of the tail. After that,
only appended bytes are read.

A line counts as a human prompt when it is a non-meta, non-sidechain
`user` entry that is not a tool result and does not start with a marker
Claude Code injects, such as `<command-` or `<system-reminder`. Titles come
from the `ai-title` entries Claude Code already writes.

### Streaming

The server collects state every 1.5 seconds and pushes it over SSE only
when it changed. An open turn is sent with a `null` end and the page
computes elapsed time, so a running session does not cause a push every
tick.

### Sending a note

`cmux send` turns `\n` in the text into Enter, which once ran test text as
shell commands. Notes go through a named buffer instead:

```js
if (record.status === 'waiting') return { ok: false, reason: 'session-waiting' };
await run(CMUX_BIN, ['set-buffer', '--name', buffer, '--', text]);
await run(CMUX_BIN, ['paste-buffer', '--name', buffer, ...ws, '--surface', surface.id]);
await run(CMUX_BIN, ['send-key', ...ws, '--surface', surface.id, 'enter']);
```

Newlines are folded into spaces and control characters are dropped before
sending. Notes are refused while a session is `waiting`, so typed text can
never pick an option in a permission prompt.

## Last 7 days and PRs

### Incremental reads

`lib/analytics.mjs` keeps 31 days of conversation logs, including subagent
logs, in memory. It only parses lines it needs and pulls permission
decisions out of large tool results with a regular expression. The first
scan takes about five seconds and the steady state uses about 20 MB.

### Estimated cost

Each assistant message's usage is weighted by token type (input 1, output
5, cache read 0.1, cache write 1.25 for 5 minutes and 2 for 1 hour) and
multiplied by a per-model input price. The price is derived from the
`cost-state` totals Claude Code records:

```js
// price per model = sum(costUSD) / sum(weighted tokens)
const w = v.inputTokens * 1 + v.outputTokens * 5 + v.cacheReadInputTokens * 0.1
  + v.cacheCreationEphemeral5mInputTokens * 1.25 + v.cacheCreationEphemeral1hInputTokens * 2;
```

`cost-state` is only written on `/clear` or exit, so it cannot give cost
over time by itself. Estimates differ slightly from what Claude Code shows.

### Linking PRs to sessions

Sessions and pull requests are linked by the `pr-link` entries in
conversation logs. Only pull requests you authored are kept, because
reviews and release checks leave `pr-link` entries too. When one session
produced several pull requests, each event is attributed to the first PR
that appeared after it:

```js
const cut = linked.map(([, t]) => t); // when each PR first appeared
const pick = (t) => {
  for (let i = 0; i < cut.length; i++) if (t <= cut[i]) return linked[i][0];
  return linked[linked.length - 1][0];
};
```

### The four axes

There is no overall score on purpose. The axes sit side by side.

| Axis          | Metrics                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| Delegation    | Your prompts per PR, tool calls per prompt, share of session time Claude spent waiting on you        |
| Cost          | Estimated cost per merged PR, Claude time per 100 changed lines, share of time spent on AI setup     |
| Speed         | First prompt to PR, PR to merge, PR to first review by a person                                      |
| Quality guard | Lines rewritten within 21 days, PRs with rework, reverts, changes requested                          |

| Metric        | Definition                                                                                         | Caveat                                                            |
| ------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Waiting       | From the end of a turn to the next human prompt                                                    | Capped at 2 hours per wait (3 hours in the Last 7 days chart)     |
| Rework        | Lines a PR added that a later PR of yours, merged within 21 days, deleted                          | Matched by a hash of the line text; your own PRs only             |
| AI setup work | Claude time in sessions that edited skills, `CLAUDE.md`, `AGENTS.md`, hooks, or settings           | Worktrees and automatic memory writes are excluded                |
| First review  | From PR creation to the first review by someone other than you                                     | Bots such as `github-actions` are excluded                        |

Rework ignores lock files, `db/schema.rb`, locale files, blank lines, and
lines like `end` or `}`. A first version that only checked whether the
same file was touched again reported 47% because follow-up PRs on the same
issue counted as rework. Merged diffs never change, so they are cached for
good.

### GitHub

Details come from GraphQL in batches of 20. Reverts are found by searching
for pull requests titled "Revert" and reading "Reverts owner/repo#N" from
the body. Results are cached in `~/.cache/cc-dashboard/github.json` and
served from there when GitHub cannot be reached. The first load takes
10 to 20 seconds.

Conversation logs are deleted after 30 days by default. Raise
`cleanupPeriodDays` in Claude Code's settings to keep more history.

## UI

- No framework. Text goes in through `textContent` only, never
  `innerHTML`, including the small Markdown renderer for Claude's replies.
- Colors are defined as hues in `public/themes.css`. Tokens in
  `public/style.css` and `public/future.css` supply lightness and chroma,
  so light and dark modes come from one definition.
- Chart colors were checked with the dataviz palette validator for color
  vision deficiency, lightness, and contrast in both modes. Do not use
  blue or cyan for "your turn": they are indistinguishable from the orchid
  Claude color for deuteranopes.
- Blocks animate in when they scroll into view (`anim`, `pre`, `in`,
  `settled`). They replay when a view is opened and never on the periodic
  refresh. Motion stops under `prefers-reduced-motion`.
- Labels and figures use Chakra Petch (bundled in `public/fonts/`, SIL Open
  Font License). Session text uses Source Serif 4 and Noto Serif JP from
  Google Fonts.

## macOS app

The app is one Swift file built with `swiftc`. There is no Xcode project.

```sh
./macos/build.sh          # rebuild ~/Applications/Chan to Yare.app
./macos/build.sh --open   # rebuild and open
```

It opens `http://127.0.0.1:7878/` in a WKWebView and talks to the page
through a `ccd` script message handler. The page only takes this path
when `window.webkit.messageHandlers.ccd` exists, so the browser behaves as
before.

| Direction  | Message                                         | Effect                                                          |
| ---------- | ----------------------------------------------- | --------------------------------------------------------------- |
| Page → app | `{type: 'badge', count}`                        | Sets the Dock badge                                             |
| Page → app | `{type: 'notify', title, body, sessionId, kind}` | Posts a macOS notification unless the app is in front           |
| Page → app | `{type: 'sound', kind}`                         | Plays Glass for a reply or Hero for a prompt                    |
| Page → app | `{type: 'soundEnabled', on}`                    | Remembers the sound setting                                     |
| App → page | `window.ccdJump(sessionId)`                     | Focuses the session's cmux tab when a notification is clicked   |
| App → page | `window.__ccdSound`                             | Passes the sound setting at launch                              |

Messages are accepted only from the main frame at `127.0.0.1:7878`.
WKWebView has no Web Notification API and restricts Web Audio autoplay,
which is why notifications and sound live in the app. External links open
in the default browser. When the server is down the app shows "Server is
not running" and reloads once it is back. Logs go to
`~/Library/Logs/chan-to-yare.log`.

"Open at Login" in the app menu registers the app with
`SMAppService.mainApp`. If that fails because of ad hoc signing, add the
app in System Settings > General > Login Items.

## Running the server with launchd

`launchd/com.ryoma0219.cc-dashboard.plist` starts the server at login and
restarts it if it exits. Before copying it to `~/Library/LaunchAgents/`,
edit the node path, working directory, and log path.

- Point `ProgramArguments` at the real node binary. Version manager shims
  such as nodenv do not work under launchd.
- Keep `/opt/homebrew/bin` on `PATH` for `gh`.
- Do not pass `CMUX_*` variables. cmux commands use them as the default
  target, so a server started from a cmux tab would act on that tab.

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ryoma0219.cc-dashboard.plist
launchctl print gui/$(id -u)/com.ryoma0219.cc-dashboard
launchctl kickstart -k gui/$(id -u)/com.ryoma0219.cc-dashboard   # restart after changing server.mjs or lib/
launchctl bootout gui/$(id -u)/com.ryoma0219.cc-dashboard        # stop (KeepAlive restarts a killed process)
```

Server logs go to `~/Library/Logs/cc-dashboard.log`.

## Security

The server returns conversation content, so it is locked down:

- It binds to `127.0.0.1` only and rejects any `Host` header other than
  `127.0.0.1:<port>` or `localhost:<port>`, which blocks DNS rebinding.
- It sends no CORS headers. The CSP allows no outside connections except
  Google Fonts.
- `POST /api/focus` and `POST /api/memo` require JSON and an
  `X-CC-Dashboard: 1` header, so a plain cross-site form cannot reach them.
- cmux only receives tab UUIDs that exist in the current tab list, passed
  through `execFile`.
- From `ps eww`, only `CMUX_SURFACE_ID` is kept. Other environment
  variables are never stored or served.
