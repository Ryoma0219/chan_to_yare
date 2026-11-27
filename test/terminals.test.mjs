import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { pickEnv, identify, identifyAll, sameTty, readEnvs, envKeys, chooseLauncher, manualCommand, launchIn, appForTermProgram } from '../lib/terminals/index.mjs';
import cmux from '../lib/terminals/cmux.mjs';
import tmux, { TMUX_BIN, parseKey } from '../lib/terminals/tmux.mjs';

const SURFACE = '0A1B2C3D-0000-4000-8000-000000000001';
const SOCKET = '/private/tmp/tmux-501/default';

function recorder(result = '') {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push({ cmd, args });
    return typeof result === 'function' ? result(cmd, args) : result;
  };
  return { calls, run };
}

const fake = (id, { available = true, launch = true } = {}) => ({
  id,
  label: id,
  envKeys: [],
  can: { focus: true, send: true, launch },
  available: () => available,
  identify: () => null,
});

test('pickEnv keeps only allowed keys', () => {
  const line = ` 123 claude --x HOME=/Users/me SECRET_TOKEN=abc CMUX_SURFACE_ID=${SURFACE} TMUX_PANE=%3`;
  assert.deepEqual(pickEnv(line, ['CMUX_SURFACE_ID', 'TMUX_PANE', 'TMUX']), { CMUX_SURFACE_ID: SURFACE, TMUX_PANE: '%3' });
});

test('pickEnv takes the last value (environment comes after the command)', () => {
  const line = ' 1 claude TMUX_PANE=%9 TMUX_PANE=%2';
  assert.equal(pickEnv(line, ['TMUX_PANE']).TMUX_PANE, '%2');
});

test('pickEnv does not match a key that is only a suffix', () => {
  assert.deepEqual(pickEnv(' 1 x MY_TMUX=/a', ['TMUX']), {});
});

test('env keys cover every backend', () => {
  assert.deepEqual(new Set(envKeys()), new Set(['CMUX_SURFACE_ID', 'TMUX', 'TMUX_PANE']));
});

test('identify: cmux', () => {
  assert.deepEqual(identify({ CMUX_SURFACE_ID: SURFACE.toLowerCase() }), { backend: 'cmux', key: SURFACE, tty: null });
});

test('identify: tmux inside cmux wins over the stale cmux surface', () => {
  const env = { CMUX_SURFACE_ID: SURFACE, TMUX: `${SOCKET},4242,0`, TMUX_PANE: '%7' };
  assert.deepEqual(identify(env), { backend: 'tmux', key: `%7@${SOCKET}`, tty: null });
});

test('readEnvs reads the tty and only allowed keys', async () => {
  const { calls, run } = recorder(` 101 ttys003  claude HOME=/x TMUX=${SOCKET},1,0 TMUX_PANE=%4\n 102 ??       claude CMUX_SURFACE_ID=${SURFACE}\n`);
  const envs = await readEnvs(run, [101, 102], envKeys());
  assert.deepEqual(calls[0].args, ['eww', '-o', 'pid=,tty=,command=', '-p', '101,102']);
  assert.deepEqual(envs.get(101), { env: { TMUX: `${SOCKET},1,0`, TMUX_PANE: '%4' }, tty: '/dev/ttys003' });
  assert.deepEqual(envs.get(102), { env: { CMUX_SURFACE_ID: SURFACE }, tty: null });
});

test('identifyAll keeps every candidate in order, with the tty', () => {
  const env = { CMUX_SURFACE_ID: SURFACE, TMUX: `${SOCKET},1,0`, TMUX_PANE: '%7' };
  assert.deepEqual(identifyAll(env, '/dev/ttys009'), [
    { backend: 'tmux', key: `%7@${SOCKET}`, tty: '/dev/ttys009' },
    { backend: 'cmux', key: SURFACE, tty: '/dev/ttys009' },
  ]);
});

test('a tmux pane only matches a process on the same tty', () => {
  // tmux のペインから起動したエディタの端末で動く claude は、TMUX_PANE を引き継いでいても別の tty にいる
  const pane = { id: '%7', tty: '/dev/ttys004' };
  assert.equal(sameTty({ tty: '/dev/ttys004' }, pane), true);
  assert.equal(sameTty({ tty: '/dev/ttys009' }, pane), false);
  assert.equal(sameTty({ tty: null }, pane), false);
  assert.equal(sameTty({ tty: '/dev/ttys009' }, { id: SURFACE }), true);
});

test('identify rejects malformed values', () => {
  assert.equal(identify({ CMUX_SURFACE_ID: 'not-a-uuid' }), null);
  assert.equal(identify({ TMUX: 'relative/sock,1,0', TMUX_PANE: '%1' }), null);
  assert.equal(identify({ TMUX: `${SOCKET},1,0`, TMUX_PANE: '1' }), null);
  assert.equal(identify({ TMUX: "/tmp/a'b,1,0", TMUX_PANE: '%1' }), null);
});

test('tmux keys round-trip', () => {
  assert.deepEqual(parseKey(`%12@${SOCKET}`), { pane: '%12', socket: SOCKET });
  assert.equal(parseKey('%12'), null);
});

test('appForTermProgram only maps known values', () => {
  assert.equal(appForTermProgram('iTerm.app'), 'iTerm');
  assert.equal(appForTermProgram('Evil; rm -rf'), null);
  assert.equal(appForTermProgram('toString'), null);
  assert.equal(appForTermProgram(undefined), null);
});

test('chooseLauncher auto picks the terminal with the most live sessions', () => {
  const a = fake('cmux');
  const b = fake('tmux');
  const refs = [{ backend: 'tmux', key: 'x' }, { backend: 'tmux', key: 'y' }, { backend: 'cmux', key: 'z' }];
  const l = chooseLauncher({ refs, backends: [b, a] });
  assert.equal(l.backend.id, 'tmux');
  assert.deepEqual(l.keys, ['x', 'y']);
});

test('chooseLauncher auto prefers cmux on a tie', () => {
  assert.equal(chooseLauncher({ refs: [], backends: [fake('tmux'), fake('cmux')] }).backend.id, 'cmux');
});

test('chooseLauncher skips unavailable terminals', () => {
  assert.equal(chooseLauncher({ refs: [], backends: [fake('tmux'), fake('cmux', { available: false })] }).backend.id, 'tmux');
  assert.equal(chooseLauncher({ refs: [], backends: [fake('cmux', { available: false })] }), null);
});

test('chooseLauncher follows the config', () => {
  const backends = [fake('tmux'), fake('cmux')];
  assert.equal(chooseLauncher({ config: { launcher: 'tmux' }, backends }).backend.id, 'tmux');
  assert.equal(chooseLauncher({ config: { launcher: 'none' }, backends }), null);
  assert.equal(chooseLauncher({ config: { launcher: 'kitty' }, backends }), null);
});

test('manualCommand quotes the folder and drops the leading space', () => {
  assert.equal(manualCommand("/w/it's here", ' claude --resume X'), `cd '/w/it'\\''s here' && claude --resume X`);
});

test('launchIn without a terminal runs nothing', async () => {
  const { calls, run } = recorder();
  const res = await launchIn(null, run, { name: 'n', cwd: '/w', command: ' claude' });
  assert.deepEqual(res, { ok: false, reason: 'no-terminal', command: "cd '/w' && claude" });
  assert.equal(calls.length, 0);
});

test('cmux launch passes the name and folder as arguments', async () => {
  const { calls, run } = recorder();
  assert.equal(await cmux.launch(run, { name: '$(x) n', cwd: '/w', command: ' claude' }), true);
  assert.deepEqual(calls[0].args, ['new-workspace', '--name', '$(x) n', '--cwd', '/w', '--command', ' claude']);
});

test('cmux paste never uses `cmux send`', async () => {
  const { calls, run } = recorder();
  const tab = { id: SURFACE, groupId: SURFACE };
  await cmux.paste(run, tab, 'a\nb');
  await cmux.pressEnter(run, tab);
  assert.deepEqual(calls.map((c) => c.args[0]), ['set-buffer', 'paste-buffer', 'send-key']);
});

test('tmux commands always name the socket and pane', async () => {
  const { calls, run } = recorder();
  const tab = { id: '%3', socket: SOCKET, groupId: '$1' };
  await tmux.paste(run, tab, 'hello');
  await tmux.pressEnter(run, tab);
  assert.deepEqual(calls[0].args.slice(0, 3), ['-S', SOCKET, 'set-buffer']);
  assert.deepEqual(calls[1].args, ['-S', SOCKET, 'paste-buffer', '-p', '-d', '-b', calls[0].args[4], '-t', '%3']);
  assert.deepEqual(calls[2].args, ['-S', SOCKET, 'send-keys', '-t', '%3', 'Enter']);
});

test('tmux launch opens on the server with the most sessions and types the command', async () => {
  const { calls, run } = recorder((cmd, args) => (args.includes('new-window') ? '%9\n' : ''));
  const keys = [`%1@/s/a`, `%2@/s/b`, `%3@/s/b`];
  assert.equal(await tmux.launch(run, { name: "n'1", cwd: '/w', command: ' claude --resume X' }, keys), true);
  assert.deepEqual(calls[0].args, ['-S', '/s/b', 'new-window', '-P', '-F', '#{pane_id}', '-c', '/w', '-n', "n'1"]);
  assert.deepEqual(calls[1].args, ['-S', '/s/b', 'send-keys', '-t', '%9', '-l', '--', ' claude --resume X']);
  assert.deepEqual(calls[2].args, ['-S', '/s/b', 'send-keys', '-t', '%9', 'Enter']);
});

test('tmux launch fails when no window opened', async () => {
  const { run } = recorder(null);
  assert.equal(await tmux.launch(run, { name: 'n', cwd: '/w', command: ' claude' }, []), false);
});

test('tmux focus switches the client that shows another session and reports its pid', async () => {
  const SEP = '\u001f';
  const { calls, run } = recorder((cmd, args) =>
    args.includes('list-clients') ? [`100${SEP}/dev/ttys001${SEP}555${SEP}$2`, `50${SEP}/dev/ttys002${SEP}556${SEP}$9`].join('\n') : '',
  );
  const res = await tmux.focus(run, { id: '%3', socket: SOCKET, groupId: '$1' });
  assert.deepEqual(res, { ok: true, hostPid: 555 });
  assert.deepEqual(calls.at(-1).args, ['-S', SOCKET, 'switch-client', '-c', '/dev/ttys001', '-t', '%3']);
});

test('tmux focus keeps a client that already shows the session', async () => {
  const SEP = '\u001f';
  const { calls, run } = recorder((cmd, args) =>
    args.includes('list-clients') ? [`100${SEP}/dev/ttys001${SEP}555${SEP}$2`, `50${SEP}/dev/ttys002${SEP}556${SEP}$1`].join('\n') : '',
  );
  const res = await tmux.focus(run, { id: '%3', socket: SOCKET, groupId: '$1' });
  assert.deepEqual(res, { ok: true, hostPid: 556 });
  assert.ok(!calls.some((c) => c.args.includes('switch-client')));
});

// 専用ソケットの使い捨て tmux サーバーで、実物の動きを確かめる。利用者の tmux には触らない
const realRun = (cmd, args) =>
  new Promise((resolve) => execFile(cmd, args, { timeout: 3000 }, (err, stdout) => resolve(err ? null : stdout)));

test('tmux end to end on a private server', { skip: TMUX_BIN ? false : 'tmux is not installed' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccd-tmux-'));
  const socket = path.join(fs.realpathSync(dir), 'sock');
  const out = path.join(dir, 'out.txt');
  const base = ['-S', socket, '-f', '/dev/null'];
  execFileSync(TMUX_BIN, [...base, 'new-session', '-d', '-s', 'ccd', '-x', '120', '-y', '30', `cat > '${out}'`]);
  t.after(() => {
    try {
      execFileSync(TMUX_BIN, [...base, 'kill-server']);
    } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const pane = execFileSync(TMUX_BIN, [...base, 'list-panes', '-a', '-F', '#{pane_id}'], { encoding: 'utf8' }).trim();
  const key = tmux.identify({ TMUX: `${socket},1,0`, TMUX_PANE: pane });
  assert.equal(key, `${pane}@${socket}`);

  const tabs = await tmux.listTabs(realRun, [key]);
  const tab = tabs.get(key);
  assert.equal(tab.group, 'ccd');
  assert.match(tab.tty, /^\/dev\/ttys?\d+$/);

  assert.equal(await tmux.paste(realRun, tab, 'first line'), true);
  assert.equal(await tmux.pressEnter(realRun, tab), true);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(fs.readFileSync(out, 'utf8'), 'first line\n');

  assert.deepEqual(await tmux.focus(realRun, tab), { ok: true });

  const before = (await tmux.listTabs(realRun, [key])).size;
  assert.equal(await tmux.launch(realRun, { name: 'launched', cwd: dir, command: ' true' }, [key]), true);
  const after = await tmux.listTabs(realRun, [key]);
  assert.equal(after.size, before + 1);
  assert.ok([...after.values()].some((x) => x.title === 'launched'));
});
