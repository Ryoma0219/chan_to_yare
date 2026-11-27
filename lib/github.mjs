// GitHub から自分の PR の情報を取る (gh CLI を使う)。
//
// - 直近の自分の PR: gh search prs --author @me
// - 詳細 (行数・ファイル・レビュー): GraphQL を20件ずつまとめて取る
// - revert: タイトルに Revert を含む PR を検索し、本文の "Reverts owner/repo#N" かタイトルで元の PR を当てる
// 結果は ~/.cache/cc-dashboard/github.json にも置き、再起動後すぐ表示できるようにする。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';

const CACHE_FILE = path.join(os.homedir(), '.cache', 'cc-dashboard', 'github.json');
const NAME_RE = /^[A-Za-z0-9_.-]+$/;
const BATCH = 20;
const FRESH_CLOSED_MS = 30 * 60 * 1000;
const FRESH_OPEN_MS = 5 * 60 * 1000;
const LIST_FRESH_MS = 5 * 60 * 1000;

function gh(args, timeout = 60000) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().slice(0, 300)));
      else resolve(stdout);
    });
  });
}

const PR_FIELDS = `
  number title url state isDraft createdAt mergedAt closedAt
  additions deletions changedFiles headRefName
  author { login }
  reviews(first: 60) { nodes { state submittedAt author { login } } }
  comments { totalCount }
  reviewThreads(first: 1) { totalCount }
  files(first: 100) { nodes { path } }
`;

// 手戻りの判定に使う行か (空行・閉じ括弧・end などは数えない)
function meaningful(text) {
  if (text.length < 4) return false;
  if (/^[\s{}()\[\];,.:'"`<>/|\\-]*$/.test(text)) return false;
  if (/^(end|else|fi|done|\}\)?;?|\)\s*;?|<\/\w+>)$/.test(text)) return false;
  return true;
}

export class GitHub {
  constructor() {
    this.details = new Map(); // url -> { fetchedAt, pr }
    this.patches = new Map(); // url -> { adds: {file: [hash]}, dels: {file: [hash]} } (マージ済みは不変なので取り直さない)
    this.list = null; // { fetchedAt, since, items }
    this.reverts = null; // { fetchedAt, map: url -> revertUrl }
    this.login = null;
    this.error = null;
    this.#load();
  }

  #load() {
    try {
      // 以前の版が 0644 で書いたファイルも、次の保存を待たずに締める
      fs.chmodSync(path.dirname(CACHE_FILE), 0o700);
      fs.chmodSync(CACHE_FILE, 0o600);
    } catch {}
    try {
      const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      for (const [url, v] of Object.entries(c.details ?? {})) this.details.set(url, v);
      for (const [url, v] of Object.entries(c.patches ?? {})) this.patches.set(url, v);
      this.list = c.list ?? null;
      this.reverts = c.reverts ? { fetchedAt: c.reverts.fetchedAt, map: new Map(Object.entries(c.reverts.map)) } : null;
      this.login = c.login ?? null;
    } catch {}
  }

  // private リポジトリの PR タイトルやファイルパスが入るので、本人だけが読めるようにする。
  // writeFileSync の mode は新しく作るときにしか効かないので、一時ファイルに書いて置き換える
  #save() {
    try {
      const dir = path.dirname(CACHE_FILE);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
      const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
      fs.writeFileSync(
        tmp,
        JSON.stringify({
          details: Object.fromEntries(this.details),
          patches: Object.fromEntries(this.patches),
          list: this.list,
          reverts: this.reverts ? { fetchedAt: this.reverts.fetchedAt, map: Object.fromEntries(this.reverts.map) } : null,
          login: this.login,
        }),
        { mode: 0o600 },
      );
      fs.renameSync(tmp, CACHE_FILE);
    } catch {}
  }

  async #whoami() {
    if (this.login) return this.login;
    this.login = (await gh(['api', 'user', '--jq', '.login'])).trim();
    return this.login;
  }

  // 自分が sinceISO 以降に作った PR (owners に限る)
  async #myPRs(owners, sinceISO) {
    const now = Date.now();
    if (this.list && this.list.since === sinceISO && now - this.list.fetchedAt < LIST_FRESH_MS) return this.list.items;
    const items = [];
    for (const owner of owners) {
      if (!NAME_RE.test(owner)) continue;
      const out = await gh([
        'search', 'prs', '--author', '@me', '--owner', owner, '--created', `>=${sinceISO}`,
        '--limit', '300', '--json', 'number,repository,url,title,state,createdAt',
      ]);
      for (const p of JSON.parse(out)) items.push({ url: p.url, repo: p.repository.nameWithOwner, number: p.number });
    }
    this.list = { fetchedAt: now, since: sinceISO, items };
    return items;
  }

  async #fetchDetails(items) {
    const now = Date.now();
    const stale = items.filter((it) => {
      const d = this.details.get(it.url);
      if (!d) return true;
      const closed = d.pr.state !== 'OPEN';
      return now - d.fetchedAt > (closed ? FRESH_CLOSED_MS : FRESH_OPEN_MS);
    });
    for (let i = 0; i < stale.length; i += BATCH) {
      const chunk = stale.slice(i, i + BATCH);
      const parts = chunk
        .map((it, j) => {
          const [owner, name] = it.repo.split('/');
          if (!NAME_RE.test(owner) || !NAME_RE.test(name) || !Number.isInteger(it.number)) return '';
          return `p${j}: repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${it.number}) { ${PR_FIELDS} } }`;
        })
        .filter(Boolean);
      if (!parts.length) continue;
      const out = await gh(['api', 'graphql', '-f', `query=query { ${parts.join('\n')} }`]);
      const data = JSON.parse(out).data ?? {};
      chunk.forEach((it, j) => {
        const pr = data[`p${j}`]?.pullRequest;
        if (!pr) return;
        this.details.set(it.url, {
          fetchedAt: now,
          pr: {
            url: pr.url,
            repo: it.repo,
            number: pr.number,
            title: pr.title,
            state: pr.state,
            isDraft: pr.isDraft,
            createdAt: Date.parse(pr.createdAt),
            mergedAt: pr.mergedAt ? Date.parse(pr.mergedAt) : null,
            closedAt: pr.closedAt ? Date.parse(pr.closedAt) : null,
            additions: pr.additions,
            deletions: pr.deletions,
            changedFiles: pr.changedFiles,
            branch: pr.headRefName,
            author: pr.author?.login ?? null,
            reviews: (pr.reviews?.nodes ?? []).map((r) => ({
              state: r.state,
              at: r.submittedAt ? Date.parse(r.submittedAt) : null,
              author: r.author?.login ?? null,
            })),
            comments: pr.comments?.totalCount ?? 0,
            threads: pr.reviewThreads?.totalCount ?? 0,
            files: (pr.files?.nodes ?? []).map((f) => f.path),
          },
        });
      });
    }
  }

  async #findReverts(owners, sinceISO) {
    const now = Date.now();
    if (this.reverts && now - this.reverts.fetchedAt < FRESH_CLOSED_MS) return this.reverts.map;
    const map = new Map();
    for (const owner of owners) {
      if (!NAME_RE.test(owner)) continue;
      let out;
      try {
        out = await gh([
          'search', 'prs', 'Revert', '--match', 'title', '--owner', owner, '--created', `>=${sinceISO}`,
          '--limit', '200', '--json', 'url,title,body,repository',
        ]);
      } catch {
        continue;
      }
      for (const p of JSON.parse(out)) {
        const m = (p.body ?? '').match(/Reverts ([\w.-]+\/[\w.-]+)#(\d+)/);
        if (m) map.set(`https://github.com/${m[1]}/pull/${m[2]}`, p.url);
        else {
          const t = p.title.match(/^Revert "(.+)"$/);
          if (t) map.set(`title:${p.repository.nameWithOwner}:${t[1]}`, p.url);
        }
      }
    }
    this.reverts = { fetchedAt: now, map };
    return map;
  }

  // 差分の追加行・削除行を、ファイルごとに行の中身のハッシュで持つ (手戻りの判定用)
  async #fetchPatches(prs) {
    const todo = prs.filter((p) => p.mergedAt && !this.patches.has(p.url));
    const one = async (p) => {
      const [owner, name] = p.repo.split('/');
      if (!NAME_RE.test(owner) || !NAME_RE.test(name)) return;
      let out;
      try {
        out = await gh(['api', '--paginate', `repos/${owner}/${name}/pulls/${p.number}/files?per_page=100`, '--jq', '.[] | {filename, patch}'], 120000);
      } catch {
        return;
      }
      const adds = {};
      const dels = {};
      for (const line of out.split('\n')) {
        if (!line) continue;
        let f;
        try {
          f = JSON.parse(line);
        } catch {
          continue;
        }
        for (const l of (f.patch ?? '').split('\n')) {
          const sign = l[0];
          if ((sign !== '+' && sign !== '-') || l.startsWith('+++') || l.startsWith('---')) continue;
          const text = l.slice(1).trim();
          if (!meaningful(text)) continue;
          const h = crypto.createHash('sha1').update(text).digest('base64').slice(0, 12);
          const bucket = sign === '+' ? adds : dels;
          (bucket[f.filename] ??= []).push(h);
        }
      }
      this.patches.set(p.url, { adds, dels });
    };
    // 6本ずつ並べて取る
    for (let i = 0; i < todo.length; i += 6) await Promise.all(todo.slice(i, i + 6).map(one));
  }

  // キャッシュにある PR のタイトルと状態。取りに行かない (Ended の検索で使う)
  prInfo(url) {
    const pr = this.details.get(url)?.pr;
    return pr ? { title: pr.title ?? null, state: pr.state ?? null } : null;
  }

  patchOf(url) {
    return this.patches.get(url) ?? null;
  }

  // owners: 対象にする GitHub の owner (会話ログの PR から決める)
  async myPullRequests(owners, sinceMs) {
    const sinceISO = new Date(sinceMs).toISOString().slice(0, 10);
    try {
      await this.#whoami();
      // 手戻り (21日以内) を見るため、作成日の下限より少し前から取る
      const items = await this.#myPRs(owners, sinceISO);
      await this.#fetchDetails(items);
      const reverts = await this.#findReverts(owners, sinceISO);
      await this.#fetchPatches(items.map((it) => this.details.get(it.url)?.pr).filter(Boolean));
      this.error = null;
      this.#save();
      const prs = items.map((it) => this.details.get(it.url)?.pr).filter(Boolean);
      for (const pr of prs) {
        pr.revertedBy = reverts.get(pr.url) ?? reverts.get(`title:${pr.repo}:${pr.title}`) ?? null;
      }
      return { login: this.login, prs };
    } catch (e) {
      this.error = e.message;
      // 取れなかったときは手元のキャッシュで返す
      const prs = (this.list?.items ?? []).map((it) => this.details.get(it.url)?.pr).filter(Boolean);
      return { login: this.login, prs, error: e.message };
    }
  }
}
