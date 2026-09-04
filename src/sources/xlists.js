/**
 * src/sources/xlists.js — X(Twitter) からの読み取り（CONTRACT.md「F: X読み取り」）
 *
 * 既定は無効。`X_READ_ENABLED=true` かつ `X_BEARER_TOKEN` がある時のみ動作する。
 * 無効時・エラー時は必ず空配列を返す（throw しない）。
 *
 * ※ X API の無料枠では読み取りエンドポイントは利用できない（Basic $200/月〜）。
 */

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { canonicalizeUrl } from '../resolve.js';

const X_API_BASE = 'https://api.x.com/2';
const TIMEOUT_MS = 15000;
const DEFAULT_X_SOURCES_PATH = new URL('../../config/x-sources.json', import.meta.url);

/**
 * 読み取りが有効かどうか。
 * @param {Record<string,string|undefined>} [env]
 * @returns {boolean}
 */
export function isXReadEnabled(env = process.env) {
  const flag = String((env && env.X_READ_ENABLED) || '').trim().toLowerCase();
  const token = String((env && env.X_BEARER_TOKEN) || '').trim();
  return flag === 'true' && token.length > 0;
}

/**
 * config/x-sources.json を読む。読めなければ空設定。
 * @param {string|URL} [path]
 * @returns {Promise<Object>}
 */
export async function loadXSources(path = DEFAULT_X_SOURCES_PATH) {
  try {
    const text = await readFile(path, 'utf8');
    return JSON.parse(text);
  } catch {
    return { enabled: false, lists: [], searches: [] };
  }
}

function stableId(title, url) {
  const norm = String(title || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s　]+/g, '');
  return createHash('sha1').update(`${norm}|${url}`).digest('hex').slice(0, 16);
}

async function xGet(pathAndQuery, token) {
  const res = await fetch(`${X_API_BASE}${pathAndQuery}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      authorization: `Bearer ${token}`,
      'user-agent': 'TCGNewsBot/1.0',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`X API ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/** X API のレスポンスを RawItem[] に変換 */
function toRawItems(payload, entry, feedUrl) {
  const tweets = Array.isArray(payload?.data) ? payload.data : [];
  const users = new Map(
    (payload?.includes?.users || []).map((u) => [u.id, u])
  );

  const items = [];
  for (const t of tweets) {
    const user = users.get(t.author_id);
    const username = user?.username || 'i';
    const url = canonicalizeUrl(`https://x.com/${username}/status/${t.id}`);
    const raw = String(t.text || '').replace(/\s+/g, ' ').trim();
    if (!raw) continue;

    // 1行目をタイトル代わりに（長すぎる場合は切る）
    const title = raw.length > 90 ? `${raw.slice(0, 90)}…` : raw;
    const publishedAt = t.created_at ? new Date(t.created_at).toISOString() : new Date().toISOString();

    items.push({
      id: stableId(title, url),
      title,
      url,
      sourceName: user?.username ? `@${user.username}` : '@x',
      sourceId: entry.id || 'x',
      sourceWeight: typeof entry.weight === 'number' ? entry.weight : 1.0,
      summary: raw.slice(0, 200),
      publishedAt,
      ips: Array.isArray(entry.ips) && entry.ips.length ? [...entry.ips] : ['newtcg'],
      feedUrl,
      kind: 'x',
    });
  }
  return items;
}

/**
 * X から RawItem[] を収集する。無効時・エラー時は [] を返す。
 * @param {Object} [xConfig] config/x-sources.json の内容（省略時はファイルから読む）
 * @param {{verbose?:boolean, env?:Record<string,string|undefined>}} [opts]
 * @returns {Promise<Array<Object>>}
 */
export async function fetchXItems(xConfig, opts = {}) {
  const { verbose = false, env = process.env } = opts || {};

  if (!isXReadEnabled(env)) {
    if (verbose) console.log('[xlists] 無効（X_READ_ENABLED / X_BEARER_TOKEN 未設定）のためスキップ');
    return [];
  }

  let config = xConfig;
  if (!config) config = await loadXSources();
  if (!config || config.enabled === false) {
    if (verbose) console.log('[xlists] config/x-sources.json が enabled:false のためスキップ');
    return [];
  }

  const token = String(env.X_BEARER_TOKEN || '').trim();
  const maxResults = Math.min(100, Math.max(10, Number(config.maxResultsPerQuery) || 25));
  const fields =
    '&tweet.fields=created_at,public_metrics,entities&expansions=author_id&user.fields=username,name';

  const out = [];

  for (const entry of config.searches || []) {
    if (!entry || !entry.query) continue;
    const feedUrl = `${X_API_BASE}/tweets/search/recent?query=${encodeURIComponent(entry.query)}`;
    try {
      const json = await xGet(
        `/tweets/search/recent?query=${encodeURIComponent(entry.query)}&max_results=${maxResults}${fields}`,
        token
      );
      const items = toRawItems(json, entry, feedUrl);
      out.push(...items);
      if (verbose) console.log(`[xlists] search "${entry.query}" -> ${items.length}件`);
    } catch (err) {
      console.warn(`[xlists] search 失敗 (${entry.id || entry.query}): ${err?.message || err}`);
    }
  }

  for (const entry of config.lists || []) {
    if (!entry || !entry.id || /^0+$/.test(String(entry.id))) continue; // サンプル値はスキップ
    const feedUrl = `${X_API_BASE}/lists/${entry.id}/tweets`;
    try {
      const json = await xGet(`/lists/${entry.id}/tweets?max_results=${maxResults}${fields}`, token);
      const items = toRawItems(json, entry, feedUrl);
      out.push(...items);
      if (verbose) console.log(`[xlists] list ${entry.id} -> ${items.length}件`);
    } catch (err) {
      console.warn(`[xlists] list 失敗 (${entry.id}): ${err?.message || err}`);
    }
  }

  // URL重複除去
  const seen = new Set();
  return out.filter((it) => {
    if (seen.has(it.url)) return false;
    seen.add(it.url);
    return true;
  });
}

/** 別名（用途が分かりやすいように） */
export const collectXItems = fetchXItems;
