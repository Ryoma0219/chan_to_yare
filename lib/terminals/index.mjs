// 端末 (cmux / tmux) をまとめて扱う。
//
// 各端末のモジュールが持つもの
//   id, label, envKeys, can: { focus, send, launch }
//   available()                         CLI があるか
//   identify(env)                       プロセスの環境変数から、タブのキー
//   listTabs(run, keys)                 キー -> { id, title, group, groupId, ... }
//   focus(run, tab)                     true / false / { ok, hostPid }
//   paste(run, tab, text)               改行で送信しない形で貼る
//   pressEnter(run, tab)
//   launch(run, { name, cwd, command }, keys)
//
// 確認待ちの読み直しや Exit の断りなど、安全のための確認は端末側ではなく lib/collect.mjs に置く。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cmux from './cmux.mjs';
import tmux from './tmux.mjs';

// 入れ子のときは内側を優先する。tmux のペインの中のプロセスには、tmux サーバーを
// 起動したタブの CMUX_SURFACE_ID が残っていることがあり、それは当てにならない
export const BACKENDS = [tmux, cmux];

// 新しいタブを開く端末を自動で選ぶときの順番 (動いているセッションの数が同じとき)
const LAUNCH_ORDER = ['cmux', 'tmux'];

// tmux のクライアントがどの端末アプリにいるか。値はこの表のキーだけを受け付ける
const APP_BY_TERM_PROGRAM = {
  'iTerm.app': 'iTerm',
  Apple_Terminal: 'Terminal',
  ghostty: 'Ghostty',
  WezTerm: 'WezTerm',
  vscode: 'Visual Studio Code',
};

export const CONFIG_FILE = path.join(os.homedir(), '.config', 'cc-dashboard', 'config.json');

export function envKeys(backends = BACKENDS) {
  return [...new Set(backends.flatMap((b) => b.envKeys))];
}

// ps eww の 1 行から、許可したキーの環境変数だけを取り出す。それ以外は保持しない。
// 環境変数はコマンドの後ろに並ぶので、同じキーが複数あれば最後のものを使う
export function pickEnv(line, keys) {
  const env = {};
  for (const key of keys) {
    const re = new RegExp(`(?:^|\\s)${key}=(\\S+)`, 'g');
    let m;
    let last = null;
    while ((m = re.exec(line))) last = m[1];
    if (last != null) env[key] = last;
  }
  return env;
}

// pid -> { env: 許可したキーだけの環境変数, tty: '/dev/ttys003' | null }
export async function readEnvs(run, pids, keys) {
  const result = new Map();
  if (!pids.length) return result;
  const out = await run('ps', ['eww', '-o', 'pid=,tty=,command=', '-p', pids.join(',')]);
  if (out == null) return null;
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s/);
    if (!m) continue;
    const tty = /^ttys?\d+$/.test(m[2]) ? `/dev/${m[2]}` : null;
    result.set(Number(m[1]), { env: pickEnv(line, keys), tty });
  }
  return result;
}

// 当てはまる端末をすべて、優先順に返す。tmux のペインから起動したアプリ (エディタの端末など) は
// TMUX と TMUX_PANE を引き継ぐので、どれを使うかはタブの一覧と tty を突き合わせてから決める
export function identifyAll(env, tty = null, backends = BACKENDS) {
  const refs = [];
  for (const b of backends) {
    const key = b.identify(env);
    if (key) refs.push({ backend: b.id, key, tty });
  }
  return refs;
}

export function identify(env, backends = BACKENDS) {
  return identifyAll(env, null, backends)[0] ?? null;
}

// タブが tty を持つ端末 (tmux) は、プロセスの tty と一致したときだけ同じ場所とみなす
export function sameTty(ref, tab) {
  return !tab.tty || (ref.tty != null && ref.tty === tab.tty);
}

export function appForTermProgram(value) {
  return Object.hasOwn(APP_BY_TERM_PROGRAM, value ?? '') ? APP_BY_TERM_PROGRAM[value] : null;
}

export function readConfig(file = CONFIG_FILE) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    return c && typeof c === 'object' && !Array.isArray(c) ? c : {};
  } catch {
    return {};
  }
}

// Resume / Hand off / Improve Claude を開く端末。
// launcher が "auto" (既定) なら、動いているセッションが一番多い端末を使う
export function chooseLauncher({ config = {}, refs = [], backends = BACKENDS }) {
  const wanted = typeof config.launcher === 'string' ? config.launcher : 'auto';
  if (wanted === 'none') return null;
  const usable = backends.filter((b) => b.can.launch && b.available());
  const keysOf = (b) => refs.filter((r) => r.backend === b.id).map((r) => r.key);
  if (wanted !== 'auto') {
    const b = usable.find((x) => x.id === wanted);
    return b ? { backend: b, keys: keysOf(b) } : null;
  }
  const rank = (b) => (LAUNCH_ORDER.indexOf(b.id) + 1 || LAUNCH_ORDER.length + 1);
  const sorted = usable
    .map((b) => ({ backend: b, keys: keysOf(b) }))
    .sort((a, b) => b.keys.length - a.keys.length || rank(a.backend) - rank(b.backend));
  return sorted[0] ?? null;
}

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// 端末で打てば同じことができるコマンド。開けなかったときに画面に出してコピーさせる
export function manualCommand(cwd, command) {
  return `cd ${shellQuote(cwd)} && ${command.trim()}`;
}

export async function launchIn(launcher, run, { name, cwd, command }) {
  const manual = manualCommand(cwd, command);
  if (!launcher) return { ok: false, reason: 'no-terminal', command: manual };
  const { backend, keys } = launcher;
  const ok = await backend.launch(run, { name, cwd, command }, keys);
  return ok ? { ok: true, terminal: backend.label } : { ok: false, reason: 'terminal-failed', terminal: backend.label, command: manual };
}
