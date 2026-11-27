'use strict';

// API に付けるトークン (lib/auth.mjs)。ほかのスクリプトより先に読む。
//
// Cookie は使わない。Cookie はポートで分かれないので、127.0.0.1 の別ポートで待ち受ける
// サーバー (同じ Mac の別アカウントやコンテナでも立てられる) にブラウザを誘導されると、
// そこへも送られてしまう。localStorage はポートごとに分かれる。
//   Mac アプリ  window.__ccdToken を注入する
//   ブラウザ    npm run open が /#t=<token> で開く。読んだらアドレスから消し、localStorage に置く
window.ccdAuth = (() => {
  const KEY = 'ccd-token';
  const TOKEN_RE = /^[0-9a-f]{64}$/;
  const store = {
    get() {
      try {
        return localStorage.getItem(KEY);
      } catch {
        return null;
      }
    },
    set(v) {
      try {
        localStorage.setItem(KEY, v);
      } catch {}
    },
    clear() {
      try {
        localStorage.removeItem(KEY);
      } catch {}
    },
  };

  let token = null;
  const fromHash = location.hash.match(/^#t=([0-9a-f]{64})$/);
  if (fromHash) {
    token = fromHash[1];
    store.set(token);
    history.replaceState(null, '', location.pathname + location.search);
  } else if (TOKEN_RE.test(window.__ccdToken ?? '')) {
    token = window.__ccdToken;
  } else if (TOKEN_RE.test(store.get() ?? '')) {
    token = store.get();
  }

  function locked() {
    store.clear();
    location.replace('/locked');
  }
  if (!token) locked();

  return {
    // EventSource はヘッダーを付けられないので、この1本だけクエリで渡す
    eventsURL: () => `/api/events?t=${token ?? ''}`,
    async fetch(path, opts = {}) {
      const res = await fetch(path, { ...opts, headers: { ...(opts.headers ?? {}), 'X-CC-Token': token ?? '' } });
      if (res.status === 401) locked();
      return res;
    },
  };
})();
