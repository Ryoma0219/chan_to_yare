# Developing Chan to Yare

This document covers how Chan to Yare works and how to change it. For what
it is and how to install it, see the [README](README.md).

## Layout

Chan to Yare has three layers: a Node server, a web UI, and a thin native
macOS app. The server uses only the Node standard library and has no
dependencies.

| Path                     | Role                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------- |
| `server.mjs`             | HTTP server, SSE stream, and the API (`state`, `events`, `insights`, `prs`, `ended`, `focus`, `memo`, `exit`, `improve`, `resume`, `handoff`) |
| `lib/collect.mjs`        | Finds running sessions, decides their state, maps them to cmux tabs, jumps tabs, sends notes, ends sessions |
| `lib/improve.mjs`        | Writes an Improve Claude request to a file and opens a new cmux workspace that runs it        |
| `lib/ended.mjs`          | Lists and searches ended sessions, and opens them again with Resume or Hand off               |
| `lib/transcript.mjs`     | Reads one conversation log incrementally and keeps its title, last exchange, and turns        |
| `lib/analytics.mjs`      | Reads 31 days of conversation logs incrementally and builds the Last 7 days view              |
| `lib/github.mjs`         | Fetches your pull requests, reviews, diffs, and reverts through `gh`, with a disk cache       |
| `lib/prs.mjs`            | Links pull requests to sessions and computes the four axes of the PRs view                    |
| `public/`                | The web UI: plain DOM and SVG, no framework                                                   |
| `test/`                  | Tests for `lib/` and the server, run with `npm test` (`node:test`, no dependencies)          |
| `public/themes.css`      | The color theme, as hues only                                                                 |
| `macos/ChanToYare.swift` | The macOS app: a WKWebView window, Dock badge, notifications, sound, and menus                |
| `macos/build.sh`         | Builds `~/Applications/Chan to Yare.app` with `swiftc` and signs it ad hoc                    |
| `launchd/`               | The LaunchAgent that keeps the server running                                                 |
| `demo/`                  | A server that serves the UI with dummy data, for the README screenshots                       |

## Running

```sh
node server.mjs   # http://127.0.0.1:7878, override the port with PORT=7979
npm run open      # opens it in the browser with the token (PORT=7979 npm run open)
```

Changes under `public/` show up on reload. Changes to `server.mjs` or
`lib/` need a server restart. Run `node --check <file>` after editing
JavaScript, and `npm test` after changing `server.mjs` or `lib/`.

To try a change without touching the dashboard that launchd keeps running,
start a second server on another port (`PORT=7979 node server.mjs`). It
still talks to the real cmux. Do not close tabs or workspaces through the
cmux CLI while testing: on 2026-11-27 a `close-workspace` followed by a
`tree` query crashed cmux, and every running session went with it.

### Screenshots

The README screenshots come from `demo/server.mjs`, which serves `public/`
with the dummy data in `demo/fixtures.mjs`. It reads no logs and calls
neither cmux nor GitHub. All times are relative to the moment of the
request.

```sh
node demo/server.mjs   # http://127.0.0.1:7880
```

The current images were taken at 1440 px wide, 2x, in dark mode, with
`prefers-reduced-motion: reduce` so the count-up and draw-in animations
do not show half done. A full-page capture can still catch the week chart
mid-animation, so set the viewport to the page height and capture the
viewport instead. Live has the "Rate limit the invoices endpoint" row
open, and PRs has `storefront #401` open and is cut off at 2376 px. The
notification button was hidden and sound was set to off, since both
only show their attention state in a browser. They were then scaled to 1600 px wide
(`sips --resampleWidth 1600`) and saved in `assets/screenshots/`.

## Data sources

| Source                                   | Used for                                                                                     |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| `~/.claude/sessions/<pid>.json`          | Session state written by Claude Code itself: `busy`, `shell`, `idle`, or `waiting`           |
| `~/.claude/projects/*/<sessionId>.jsonl` | Conversation logs: title, prompts and replies, turn timing, token usage, tools, PR links     |
| `ps eww`                                 | Only `CMUX_SURFACE_ID` from each process, to know which cmux tab a session lives in          |
| `cmux tree --json`                       | Tab and workspace names                                                                      |
| `gh`                                     | Your pull requests: size, files, reviews, diffs, and reverts                                 |

Chan to Yare writes in four ways: it focuses a cmux tab
(`select-workspace` and `focus-panel`), it sends a note to a session
(`set-buffer`, `paste-buffer`, `send-key enter`), it ends a session by
sending `/exit` the same way, and it opens a new workspace
(`new-workspace`) for Improve Claude, Resume, and Hand off. It never
closes tabs or workspaces.

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

### Exiting a session

Expanded rows in Your turn have an Exit button left of Improve Claude. The first click arms it (`Exit?`)
for three seconds and the second click sends `/exit` through the same
buffer as a note. `window.confirm` is not used because the macOS app's
WKWebView silently returns false for it.

The server refuses `waiting` sessions for the same reason as notes, and
`busy` or `shell` sessions because `/exit` would be queued and end the
session when the turn finishes. After sending, it waits up to five seconds
for the process to go away and reports `exit-timeout` otherwise. The cmux
tab is left open at the shell, showing `claude --resume <id>`.

### Improving Claude

Improve Claude opens a new cmux workspace in which Claude Code works on a
request about its own behavior. It can be started from the header, which
opens the session in `~/.claude`, or from a row's composer, which opens it
in that session's directory and adds the session's title, directory, and
log path to the request so Claude can read what actually happened. The
server looks these up from the session id and ignores anything else the
page sends.

The request text never reaches a shell. The server writes it to
`~/.cache/cc-dashboard/improve/<random>.md` (mode 600, removed after ten
minutes) and types only a fixed command into the new workspace:

```sh
 claude "$(cat '/Users/you/.cache/cc-dashboard/improve/<random>.md')"
```

The leading space is deliberate. A new shell may show a countdown offering
to resume an earlier session in the same directory, and that countdown
reads the first key as "cancel". The space is that key. Without the
countdown, the shell ignores it.

## Ended

The Ended view lists sessions from the last 31 days that are no longer
running and have at least one prompt from you, newest first. It reuses the
files `lib/analytics.mjs` already reads, which keep each session's prompts
(500 characters each, the last 200), the directory it started in, the last
directory and branch, the last reply, and the context size of the last
main-chain message.

Search runs on the server, so the prompt text never reaches the page. The
query is split on whitespace (including full-width spaces) and every word
must appear, case-insensitively, in the title, a prompt, the `/rename`
name, the repository, worktree, branch, directory, or a linked PR's URL,
`#number`, or title. PR titles come from the GitHub cache only.

The headline is the `ai-title`, or the repository and the first prompt.
`/rename` names are shown beside it, not as the headline: Claude Code
rewrites them throughout the log and carries them over across `/clear`,
so two different conversations can share one.

### Resume and Hand off

Resume opens a new workspace and runs `claude --resume <id>` in the
directory whose project folder holds the log (the start or the last
directory, whichever matches `~/.claude/projects/<dir>`; the start one if
neither does). `claude --resume` looks the log up from there, so this
works even when the session moved into a worktree.
The server refuses a session that is running (any live process with that
id in `~/.claude/sessions`, which a resumed session keeps), one it opened
in the last 30 seconds (reserved before calling cmux, and kept even if
cmux times out), and one whose directory is gone.

Hand off opens a new session in the last directory (or the starting one if
that is gone) with a short brief: title, branch, PRs, first and last
prompts, last reply, and the log path. Like Improve Claude, the brief goes
to `~/.cache/cc-dashboard/handoff/<random>.md` and the shell only gets the
fixed `claude "$(cat ...)"` command. The brief asks Claude to wait for
instructions and read only the parts of the log it needs.

Resuming after the prompt cache has expired (an hour at most) writes the
whole history to the cache again on the first turn. For a quick follow-up
on a long session, Hand off is cheaper. Both views show the context size
so you can choose.

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

It reads the token from `~/.config/cc-dashboard/token`, passes it to the
page as `window.__ccdToken`, opens `http://127.0.0.1:7878/` in a
WKWebView, and talks to the page
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

The server returns conversation content and can type into running
sessions, so it is locked down:

- Every `/api/` route needs a token. Binding to `127.0.0.1` keeps other
  machines out, but not other macOS accounts, containers, or sandboxed
  commands that can reach loopback and set any header they like.
  - The token lives in `~/.config/cc-dashboard/token` (file `0600`,
    directory `0700`). The server creates it on first start and keeps it
    across restarts.
  - Requests send it as `X-CC-Token`. `EventSource` cannot set headers,
    so `/api/events` alone also accepts `?t=<token>`.
  - `npm run open` opens `/#t=<token>`. The fragment never reaches the
    server; `public/auth.js` moves it into `localStorage` and removes it
    from the address bar. The URL goes to `osascript` on stdin, so the
    token never shows up in `ps`.
  - The macOS app injects it as `window.__ccdToken`.
  - There is no cookie on purpose. Cookies ignore ports, so any server
    on another `127.0.0.1` port, which another account or a container
    can start, would receive it. `localStorage` is per port.
  - The token is never put in the page or in an API response, since an
    unauthenticated caller could read it from there.
  - Without a valid token the page moves to `/locked`. The page and the
    static code and assets stay open; the app's health check uses
    `/favicon.svg`.
- It binds to `127.0.0.1` only and rejects any `Host` header other than
  `127.0.0.1:<port>` or `localhost:<port>`, which blocks DNS rebinding.
- It sends no CORS headers. The CSP allows no outside connections except
  Google Fonts.
- `POST /api/focus`, `/api/memo`, `/api/exit`, `/api/improve`, `/api/resume`, and `/api/handoff` require
  JSON and an `X-CC-Dashboard: 1` header, so a plain cross-site form cannot
  reach them.
- Improve Claude requests and Hand off briefs go to a file, never into a
  command line. The directory and log path come from the server, not the
  page. Resume puts only a validated session UUID in its command, and
  workspace names go to cmux as `execFile` arguments.
- Resume refuses a running session, and one it opened in the last 30
  seconds, so two processes never write to one log.
- cmux only receives tab UUIDs that exist in the current tab list, passed
  through `execFile`.
- From `ps eww`, only `CMUX_SURFACE_ID` is kept. Other environment
  variables are never stored or served.
- A request handler that throws returns 500 instead of taking the process
  down, and a path that `new URL` cannot parse (such as `//`) gets 400.
- A note to a working session can race with a permission prompt. The
  session's status is read again right before pasting and right before
  Enter, and nothing is sent while it is waiting on a prompt. A small
  window remains between the last check and the key press.
- Values taken from conversation logs are embedded in the Improve Claude
  prompt and the Hand off brief as single lines and marked as data, not
  instructions.
- PR links from conversation logs are kept only if they look like
  `https://github.com/<owner>/<repo>/pull/<n>`.
- `~/.cache/cc-dashboard/github.json` (PR titles and file paths, including
  private repositories) is written `0600` in a `0700` directory.
- The page loads Google Fonts, so Google sees a request each time it opens.
