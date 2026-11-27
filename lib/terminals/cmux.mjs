// cmux (https://github.com/manaflow-ai/cmux) のタブを操作する。
//
// セッションのタブは、プロセスの環境変数 CMUX_SURFACE_ID で分かる。
// 名前は `cmux tree --json` から取る。タブやワークスペースを閉じる操作は持たない
// (2026-11-27、CLI から close-workspace した直後に cmux 本体が落ち、全セッションが消えた)。

import fs from 'node:fs';

export const CMUX_BIN = process.env.CMUX_BIN || '/Applications/cmux.app/Contents/Resources/bin/cmux';
const UUID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

const workspaceArgs = (tab) => (tab.groupId && UUID_RE.test(tab.groupId) ? ['--workspace', tab.groupId] : []);

export default {
  id: 'cmux',
  label: 'cmux',
  envKeys: ['CMUX_SURFACE_ID'],
  can: { focus: true, send: true, launch: true },

  available() {
    return fs.existsSync(CMUX_BIN);
  },

  identify(env) {
    const id = env.CMUX_SURFACE_ID;
    return id && UUID_RE.test(id) ? id.toUpperCase() : null;
  },

  async listTabs(run) {
    const tabs = new Map();
    const out = await run(CMUX_BIN, ['--id-format', 'both', 'tree', '--all', '--json']);
    if (out == null) return null;
    let tree;
    try {
      tree = JSON.parse(out);
    } catch {
      return null;
    }
    for (const win of tree.windows ?? []) {
      for (const ws of win.workspaces ?? []) {
        for (const pane of ws.panes ?? []) {
          for (const sf of pane.surfaces ?? []) {
            if (!sf.id || !UUID_RE.test(sf.id)) continue;
            tabs.set(sf.id.toUpperCase(), {
              id: sf.id,
              title: sf.title ?? null,
              group: ws.title ?? null,
              groupId: ws.id ?? null,
            });
          }
        }
      }
    }
    return tabs;
  },

  async focus(run, tab) {
    const ws = workspaceArgs(tab);
    if (ws.length) await run(CMUX_BIN, ['select-workspace', ...ws]);
    const out = await run(CMUX_BIN, ['focus-panel', '--panel', tab.id, ...ws]);
    await run('open', ['-a', 'cmux']);
    return out != null;
  },

  // cmux send は \n を Enter と解釈するので使わず、バッファ経由で貼り付ける
  async paste(run, tab, text) {
    const buffer = `ccd-${process.pid}-${Date.now().toString(36)}`;
    if ((await run(CMUX_BIN, ['set-buffer', '--name', buffer, '--', text])) == null) return false;
    return (await run(CMUX_BIN, ['paste-buffer', '--name', buffer, ...workspaceArgs(tab), '--surface', tab.id])) != null;
  },

  async pressEnter(run, tab) {
    return (await run(CMUX_BIN, ['send-key', ...workspaceArgs(tab), '--surface', tab.id, 'enter'])) != null;
  },

  async launch(run, { name, cwd, command }) {
    return (await run(CMUX_BIN, ['new-workspace', '--name', name, '--cwd', cwd, '--command', command])) != null;
  },
};
