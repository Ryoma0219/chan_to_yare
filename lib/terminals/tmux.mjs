// tmux のペインを操作する。
//
// セッションのペインは、プロセスの環境変数 TMUX (ソケットのパス) と TMUX_PANE (%N) で分かる。
// どのサーバーかを取り違えないよう、コマンドには毎回 -S <ソケット> を付ける。
// ペインやウィンドウを閉じる操作は持たない。

import fs from 'node:fs';
import path from 'node:path';

const PANE_RE = /^%\d+$/;
const SOCKET_RE = /^\/[A-Za-z0-9._/-]+$/;
const SEP = '\u001f';

function findBin() {
  if (process.env.TMUX_BIN) return process.env.TMUX_BIN;
  const dirs = [...(process.env.PATH ?? '').split(':'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, 'tmux');
    if (fs.existsSync(p)) return p;
  }
  return null;
}
export const TMUX_BIN = findBin();

// キーは "<ペイン>@<ソケット>"。ソケットのパスに @ は入れない (SOCKET_RE)
export function tmuxKey(pane, socket) {
  return `${pane}@${socket}`;
}

export function parseKey(key) {
  const at = key.indexOf('@');
  if (at < 0) return null;
  const pane = key.slice(0, at);
  const socket = key.slice(at + 1);
  return PANE_RE.test(pane) && SOCKET_RE.test(socket) ? { pane, socket } : null;
}

const tmux = (socket, args) => (socket ? ['-S', socket, ...args] : args);

export default {
  id: 'tmux',
  label: 'tmux',
  envKeys: ['TMUX', 'TMUX_PANE'],
  can: { focus: true, send: true, launch: true },

  available() {
    return TMUX_BIN != null;
  },

  identify(env) {
    const pane = env.TMUX_PANE;
    const socket = env.TMUX?.split(',')[0];
    if (!pane || !socket || !PANE_RE.test(pane) || !SOCKET_RE.test(socket)) return null;
    return tmuxKey(pane, socket);
  },

  // 動いているセッションがいるサーバーだけを見る
  async listTabs(run, keys = []) {
    const sockets = new Set(keys.map((k) => parseKey(k)?.socket).filter(Boolean));
    const tabs = new Map();
    for (const socket of sockets) {
      const format = ['#{pane_id}', '#{session_id}', '#{session_name}', '#{window_id}', '#{window_name}', '#{pane_tty}'].join(SEP);
      const out = await run(TMUX_BIN, tmux(socket, ['list-panes', '-a', '-F', format]));
      if (out == null) continue;
      for (const line of out.split('\n')) {
        const [pane, sessionId, sessionName, windowId, windowName, tty] = line.split(SEP);
        if (!PANE_RE.test(pane ?? '')) continue;
        tabs.set(tmuxKey(pane, socket), {
          id: pane,
          socket,
          title: windowName || null,
          group: sessionName || null,
          groupId: sessionId || null,
          windowId: windowId || null,
          tty: tty?.startsWith('/dev/') ? tty : null,
        });
      }
    }
    return tabs;
  },

  // ペインを選び、そのセッションを見ているクライアント (なければ最後に使われたクライアント) を切り替える。
  // クライアントのプロセスを返し、外側の端末アプリを前に出すのは呼び出し側に任せる
  async focus(run, tab) {
    const s = tab.socket;
    if ((await run(TMUX_BIN, tmux(s, ['select-window', '-t', tab.id]))) == null) return { ok: false };
    await run(TMUX_BIN, tmux(s, ['select-pane', '-t', tab.id]));
    const out = await run(TMUX_BIN, tmux(s, ['list-clients', '-F', ['#{client_activity}', '#{client_tty}', '#{client_pid}', '#{session_id}'].join(SEP)]));
    const clients = (out ?? '')
      .split('\n')
      .map((line) => {
        const [activity, tty, pid, sessionId] = line.split(SEP);
        return { activity: Number(activity) || 0, tty, pid: Number(pid), sessionId };
      })
      .filter((c) => c.tty?.startsWith('/dev/') && Number.isInteger(c.pid) && c.pid > 0)
      .sort((a, b) => (b.sessionId === tab.groupId) - (a.sessionId === tab.groupId) || b.activity - a.activity);
    const client = clients[0];
    if (!client) return { ok: true };
    if (client.sessionId !== tab.groupId) await run(TMUX_BIN, tmux(s, ['switch-client', '-c', client.tty, '-t', tab.id]));
    return { ok: true, hostPid: client.pid };
  },

  // -p は bracketed paste。貼る文字に改行があっても、そこで送信されない
  async paste(run, tab, text) {
    const buffer = `ccd-${process.pid}-${Date.now().toString(36)}`;
    if ((await run(TMUX_BIN, tmux(tab.socket, ['set-buffer', '-b', buffer, '--', text]))) == null) return false;
    return (await run(TMUX_BIN, tmux(tab.socket, ['paste-buffer', '-p', '-d', '-b', buffer, '-t', tab.id]))) != null;
  },

  async pressEnter(run, tab) {
    return (await run(TMUX_BIN, tmux(tab.socket, ['send-keys', '-t', tab.id, 'Enter']))) != null;
  },

  // 新しいウィンドウのシェルにコマンドを打ち込む (cmux の new-workspace --command と同じく、
  // claude が終わってもシェルが残る)。動いているセッションが一番多いサーバーで開く
  async launch(run, { name, cwd, command }, keys = []) {
    const count = new Map();
    for (const k of keys) {
      const socket = parseKey(k)?.socket;
      if (socket) count.set(socket, (count.get(socket) ?? 0) + 1);
    }
    const socket = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const out = await run(TMUX_BIN, tmux(socket, ['new-window', '-P', '-F', '#{pane_id}', '-c', cwd, '-n', name]));
    const pane = out?.trim();
    if (!pane || !PANE_RE.test(pane)) return false;
    if ((await run(TMUX_BIN, tmux(socket, ['send-keys', '-t', pane, '-l', '--', command]))) == null) return false;
    return (await run(TMUX_BIN, tmux(socket, ['send-keys', '-t', pane, 'Enter']))) != null;
  },
};
