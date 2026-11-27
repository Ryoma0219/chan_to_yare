<!-- LOGO -->
<h1>
<p align="center">
  <img src="assets/logo.png" alt="Logo" width="128">
  <br>Chan to Yare
</h1>
  <p align="center">
    A local dashboard for running many Claude Code sessions in parallel.
    <br />
    See whose turn it is, jump to the right tab, and look back on how you work with Claude.
    <br />
    <a href="#about">About</a>
    ·
    <a href="#install">Install</a>
    ·
    <a href="#usage">Usage</a>
    ·
    <a href="HACKING.md">Developing</a>
  </p>
</p>

## About

Chan to Yare is a dashboard for people who run many Claude Code sessions
at once in [cmux](https://github.com/manaflow-ai/cmux) tabs. When a dozen
sessions are going, it is easy to lose track of which ones are waiting for
you and which ones are still working. Chan to Yare puts every session on one screen, sorted
by whose turn it is, and tells you the moment one needs you.

It reads only what Claude Code already writes to disk (session state and
conversation logs), plus your pull requests through `gh`. There is no
agent to install in your sessions, and the only network calls are to
GitHub and Google Fonts. It is a Node server with zero dependencies, a web
UI, and a thin native macOS app around it.

The name is Japanese for "do it properly."

## Install

You need macOS, Node 20 or later, [cmux](https://github.com/manaflow-ai/cmux), and Claude Code.
The PRs view also needs the [GitHub CLI](https://cli.github.com) signed in.

```sh
git clone git@github.com:Ryoma0219/chan_to_yare.git
cd chan_to_yare
node server.mjs   # http://127.0.0.1:7878
```

To keep the server running in the background and open the dashboard as a
native app with a Dock badge and notifications:

```sh
cp launchd/com.ryoma0219.cc-dashboard.plist ~/Library/LaunchAgents/   # edit the paths first
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ryoma0219.cc-dashboard.plist
./macos/build.sh --open   # builds ~/Applications/Chan to Yare.app
```

See [HACKING.md](HACKING.md) for details.

## Usage

| View        | What it shows                                                                                             |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| Live        | Every running session, grouped into your turn, Claude's turn, and untouched for 12+ hours                 |
| Last 7 days | When Claude worked and waited on you, how fast you reply, cost, repositories, tools, skills and approvals |
| PRs         | Each PR you opened in the last 30 days next to the sessions behind it, on four axes                       |

From the Live view you can open a session's cmux tab, read its last
exchange, and send it a note ("Send" or "Remember") without leaving the
board. When a session starts waiting on you, the app plays a sound once,
posts a macOS notification, and updates the Dock badge.

In the app, `⌘1` `⌘2` `⌘3` switch views and `⌘R` reloads.

## Developing

Architecture, data sources, metric definitions, the macOS app, and
security notes are in [HACKING.md](HACKING.md).

## Status

Chan to Yare is a personal tool in daily use.

|  #  | Step                                                     | Status |
| :-: | -------------------------------------------------------- | :----: |
|  1  | Live board with notifications and tab jumping            |   ✅   |
|  2  | Send a note to a session from the board                  |   ✅   |
|  3  | Last 7 days analytics                                    |   ✅   |
|  4  | PR retrospective on four axes                            |   ✅   |
|  5  | Native macOS app with a Dock badge                       |   ✅   |
|  6  | Menu bar item with the count of sessions waiting on you  |   ❌   |
|  7  | Hand-off ledger and a "safe to close" check per session  |   ❌   |
