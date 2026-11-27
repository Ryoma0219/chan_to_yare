// ダッシュボードの API を開けるのは、トークンを知っている人だけにする。
//
// 127.0.0.1 にしか bind していなくても、同じ Mac の別アカウントや、ループバックに届く
// コンテナ・サンドボックス内のコマンドからは curl で叩ける。Host や独自ヘッダーは
// 自由に付けられるので、それだけでは防げない。
//
// トークンは ~/.config/cc-dashboard/token (0600) に置き、再起動しても変えない。
// API には X-CC-Token ヘッダーで付ける。EventSource はヘッダーを付けられないので /api/events だけ ?t=。
//   ブラウザ   npm run open が /#t=<token> を開き、ページ (public/auth.js) が localStorage に置く
//   Mac アプリ トークンファイルを読み、window.__ccdToken としてページに注入する
// Cookie は使わない。ポートで分かれないので、127.0.0.1 の別ポートのサーバーにも送られてしまう。
// トークンはページにも API の応答にも載せない。載せると、同じ未認証の呼び出し元が GET で取れてしまう。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const TOKEN_FILE =
  process.env.CC_DASHBOARD_TOKEN_FILE || path.join(os.homedir(), '.config', 'cc-dashboard', 'token');
const TOKEN_RE = /^[0-9a-f]{64}$/;

// 既存のトークンを読む。なければ作る。権限が緩くなっていたら締め直す
export function loadToken(file = TOKEN_FILE) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  try {
    const token = fs.readFileSync(file, 'utf8').trim();
    if (TOKEN_RE.test(token)) {
      fs.chmodSync(file, 0o600);
      return token;
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const token = crypto.randomBytes(32).toString('hex');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return token;
}

function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// url は new URL 済みのもの。クエリのトークンは /api/events (EventSource) にだけ認める
export function isAuthorized(req, url, token) {
  if (same(req.headers['x-cc-token'], token)) return true;
  return req.method === 'GET' && url.pathname === '/api/events' && same(url.searchParams.get('t'), token);
}
