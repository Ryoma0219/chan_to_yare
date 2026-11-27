#!/usr/bin/env node
// ダッシュボードを既定のブラウザで開く。トークンは URL の # 以降に付けるのでサーバーには送られず、
// ページ (public/auth.js) が読んで localStorage に置き、アドレスから消す。
// トークンをコマンドの引数に載せると、ps で同じ Mac の別アカウントからも見える。
// そのため osascript には標準入力でスクリプトを渡す。
//
//   npm run open            http://127.0.0.1:7878
//   PORT=7979 npm run open

import { execFile } from 'node:child_process';
import { loadToken } from '../lib/auth.mjs';

const PORT = Number(process.env.PORT || 7878);
const url = `http://127.0.0.1:${PORT}/#t=${loadToken()}`;
const child = execFile('osascript', ['-'], (err) => {
  if (err) {
    console.error(`could not open the browser: ${err.message}`);
    process.exit(1);
  }
});
child.stdin.end(`open location "${url}"\n`);
