// src/x.js
// X API v2 クライアント。OAuth 1.0a (HMAC-SHA1) の署名を node:crypto だけで自前実装。
// npm依存なし（Node標準の fetch / node:crypto のみ / ESM名前付きexport / Node >= 20）。
//
// 契約: CONTRACT.md 区画C
//   export async function verifyCredentials(creds)
//   export async function postThread(texts, creds, { dryRun })
//   creds = {apiKey, apiSecret, accessToken, accessTokenSecret}

import crypto from 'node:crypto';

const API_BASE = 'https://api.x.com';
export const ENDPOINT_ME = `${API_BASE}/2/users/me`;
export const ENDPOINT_TWEETS = `${API_BASE}/2/tweets`;

/** ツイート間の待機（レート制限・スパム判定回避） */
export const TWEET_INTERVAL_MS = 3000;
/** リトライ対象のHTTPステータス */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503]);
/** 指数バックオフ（初回5秒 → 10秒 → 20秒） */
const BACKOFF_MS = [5000, 10000, 20000];
const MAX_RETRIES = BACKOFF_MS.length;
/** x-rate-limit-reset に従う場合の待機上限 */
const MAX_RESET_WAIT_MS = 120000;

// ---------------------------------------------------------------------------
// OAuth 1.0a 署名
// ---------------------------------------------------------------------------

/**
 * RFC3986 パーセントエンコード。
 * 非予約文字は A-Z a-z 0-9 `-` `.` `_` `~` のみ。
 * encodeURIComponent が残す `!` `*` `'` `(` `)` も明示的にエンコードする。
 * @param {string|number} value
 * @returns {string}
 */
export function percentEncode(value) {
  return encodeURIComponent(String(value ?? '')).replace(
    /[!*'()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** HMAC-SHA1 を base64 で返す（RFC2104 / RFC2202 準拠） */
export function hmacSha1(key, data) {
  return crypto.createHmac('sha1', key).update(data, 'utf8').digest('base64');
}

/** [key, value] の配列に正規化（オブジェクト / エントリ配列 / URLSearchParams を受ける） */
function toEntries(params) {
  if (!params) return [];
  if (params instanceof URLSearchParams) return [...params.entries()];
  if (Array.isArray(params)) return params.map(([k, v]) => [String(k), v == null ? '' : String(v)]);
  return Object.entries(params).map(([k, v]) => [String(k), v == null ? '' : String(v)]);
}

/**
 * 署名ベース文字列を生成する（RFC 5849 §3.4.1）。
 *   {METHOD}&{pctEnc(url_without_query)}&{pctEnc(sorted_params)}
 * URL のクエリ文字列と extraParams / oauth パラメータを結合し、
 * エンコード後のキー→値の順でソートして連結する。
 *
 * 注意: JSONボディの POST では**ボディを含めない**（クエリと oauth パラメータのみ）。
 *
 * @param {string} method
 * @param {string} url
 * @param {object|Array|URLSearchParams} params
 * @returns {string}
 */
export function buildSignatureBaseString(method, url, params) {
  const u = new URL(url);
  const baseUrl = `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${u.pathname}`;

  const all = [...u.searchParams.entries(), ...toEntries(params)].map(([k, v]) => [
    percentEncode(k),
    percentEncode(v),
  ]);
  all.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));

  const paramString = all.map(([k, v]) => `${k}=${v}`).join('&');
  return `${method.toUpperCase()}&${percentEncode(baseUrl)}&${percentEncode(paramString)}`;
}

/** 署名キー `{pctEnc(consumerSecret)}&{pctEnc(tokenSecret)}` で HMAC-SHA1 署名 */
export function signBaseString(baseString, consumerSecret, tokenSecret = '') {
  const key = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  return hmacSha1(key, baseString);
}

/** 32桁hexのnonce */
function makeNonce() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * OAuth 1.0a の Authorization ヘッダ文字列を組み立てる。
 * @param {string} method
 * @param {string} url
 * @param {{apiKey:string,apiSecret:string,accessToken:string,accessTokenSecret:string}} creds
 * @param {{extraParams?:object, nonce?:string, timestamp?:number|string}} [opts]
 * @returns {string} `OAuth key="value", ...`
 */
export function buildOAuthHeader(method, url, creds, { extraParams = {}, nonce, timestamp } = {}) {
  const oauthParams = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: nonce ?? makeNonce(),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(timestamp ?? Math.floor(Date.now() / 1000)),
    oauth_token: creds.accessToken,
    oauth_version: '1.0',
  };

  const base = buildSignatureBaseString(method, url, [
    ...toEntries(extraParams),
    ...toEntries(oauthParams),
  ]);
  const signature = signBaseString(base, creds.apiSecret, creds.accessTokenSecret);

  // ヘッダには oauth_* のみを載せる（extraParams は載せない）
  const headerParams = { ...oauthParams, oauth_signature: signature };
  const pairs = Object.keys(headerParams)
    .sort()
    .map((k) => `${percentEncode(k)}="${percentEncode(headerParams[k])}"`);
  return `OAuth ${pairs.join(', ')}`;
}

// ---------------------------------------------------------------------------
// 共通ユーティリティ
// ---------------------------------------------------------------------------

const CRED_FIELDS = [
  ['apiKey', 'X_API_KEY'],
  ['apiSecret', 'X_API_SECRET'],
  ['accessToken', 'X_ACCESS_TOKEN'],
  ['accessTokenSecret', 'X_ACCESS_TOKEN_SECRET'],
];

/** 不足している認証情報を日本語メッセージで返す（無ければ null） */
export function validateCreds(creds) {
  const missing = CRED_FIELDS.filter(([k]) => !creds || typeof creds[k] !== 'string' || creds[k].trim() === '');
  if (missing.length === 0) return null;
  return `認証情報が不足しています: ${missing.map(([, env]) => env).join(', ')}（.env を確認してください）`;
}

/** ステータスコードごとの日本語ヒント */
export function hintForStatus(status) {
  switch (status) {
    case 401:
      return '\nヒント(401): APIキー/トークンの誤り、コピペ時の空白混入、または端末の時刻ずれ（OAuthのtimestampが±5分を超える）が原因です。Keys and tokens から再生成して .env を貼り直してください。';
    case 403:
      return '\nヒント(403): アプリ権限が Read-only のままの可能性が高いです。User authentication settings を「Read and write」に変更し、**その後で** Access Token を再生成してください（変更前のトークンでは書き込めません）。';
    case 429:
      return '\nヒント(429): レート制限に達しました。Free tier は投稿 500件/月（アプリ単位）です。時間をおいて再実行してください。';
    default:
      return '';
  }
}

function getHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

function clip(text, max = 300) {
  const s = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** x-rate-limit-reset（epoch秒）から待機ミリ秒を求める。無ければ null */
function resetWaitMs(headers, now = Date.now()) {
  const raw = getHeader(headers, 'x-rate-limit-reset');
  if (raw == null) return null;
  const reset = Number(raw);
  if (!Number.isFinite(reset) || reset <= 0) return null;
  const wait = reset * 1000 - now;
  if (!Number.isFinite(wait)) return null;
  return Math.min(Math.max(wait, 1000), MAX_RESET_WAIT_MS);
}

/** ツイートURL */
export function tweetUrl(id, username) {
  return username ? `https://x.com/${username}/status/${id}` : `https://x.com/i/web/status/${id}`;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * 認証情報の疎通確認。GET /2/users/me を OAuth1.0a で叩く。
 * **throw しない**。
 * @param {{apiKey:string,apiSecret:string,accessToken:string,accessTokenSecret:string}} creds
 * @param {{fetchImpl?:Function}} [opts]
 * @returns {Promise<{ok:boolean, username?:string, id?:string, error?:string}>}
 */
export async function verifyCredentials(creds, { fetchImpl = globalThis.fetch } = {}) {
  const invalid = validateCreds(creds);
  if (invalid) return { ok: false, error: invalid };

  let res;
  let body = '';
  try {
    res = await fetchImpl(ENDPOINT_ME, {
      method: 'GET',
      headers: {
        Authorization: buildOAuthHeader('GET', ENDPOINT_ME, creds),
        'User-Agent': 'tcg-twitter-bot/1.0',
      },
    });
    body = typeof res.text === 'function' ? await res.text() : '';
  } catch (err) {
    return { ok: false, error: `通信エラー: ${err?.message ?? String(err)}` };
  }

  if (!res.ok) {
    return {
      ok: false,
      error: `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''} / ${clip(body)}${hintForStatus(res.status)}`,
    };
  }

  try {
    const json = JSON.parse(body);
    const data = json?.data ?? {};
    if (!data.id) return { ok: false, error: `想定外のレスポンス: ${clip(body)}` };
    return { ok: true, username: data.username, id: String(data.id) };
  } catch {
    return { ok: false, error: `JSONの解析に失敗: ${clip(body)}` };
  }
}

/** 1ツイート投稿（リトライ込み）。成功時はツイートIDを返す */
async function postOne(text, replyToId, creds, { fetchImpl, sleepImpl, log }) {
  const payload = replyToId
    ? { text, reply: { in_reply_to_tweet_id: String(replyToId) } }
    : { text };
  const body = JSON.stringify(payload);

  let attempt = 0;
  for (;;) {
    let res;
    let raw = '';
    try {
      res = await fetchImpl(ENDPOINT_TWEETS, {
        method: 'POST',
        headers: {
          // JSONボディは署名ベース文字列に含めない
          Authorization: buildOAuthHeader('POST', ENDPOINT_TWEETS, creds),
          'Content-Type': 'application/json',
          'User-Agent': 'tcg-twitter-bot/1.0',
        },
        body,
      });
      raw = typeof res.text === 'function' ? await res.text() : '';
    } catch (err) {
      // ネットワーク断もリトライ対象
      if (attempt < MAX_RETRIES) {
        const wait = BACKOFF_MS[attempt];
        attempt += 1;
        log?.(`通信エラー: ${err?.message ?? err} — ${Math.round(wait / 1000)}秒後に再試行 (${attempt}/${MAX_RETRIES})`);
        await sleepImpl(wait);
        continue;
      }
      throw new Error(`通信エラー（${MAX_RETRIES}回リトライ後）: ${err?.message ?? String(err)}`);
    }

    if (res.ok) {
      let json;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new Error(`投稿レスポンスの解析に失敗: ${clip(raw)}`);
      }
      const id = json?.data?.id;
      if (!id) throw new Error(`投稿レスポンスにIDがありません: ${clip(raw)}`);
      return String(id);
    }

    // 401 / 403 は設定ミス。リトライしても無駄なので即throw
    if (res.status === 401 || res.status === 403) {
      throw new Error(`HTTP ${res.status} / ${clip(raw)}${hintForStatus(res.status)}`);
    }

    if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_RETRIES) {
      const wait = resetWaitMs(res.headers) ?? BACKOFF_MS[attempt];
      attempt += 1;
      log?.(`HTTP ${res.status} — ${Math.round(wait / 1000)}秒後に再試行 (${attempt}/${MAX_RETRIES})`);
      await sleepImpl(wait);
      continue;
    }

    throw new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''} / ${clip(raw)}${hintForStatus(res.status)}`);
  }
}

/**
 * スレッド投稿。2本目以降は in_reply_to_tweet_id で連結。
 * 途中で失敗した場合、そこまでに投稿できたIDを `err.postedIds` に入れて throw する。
 *
 * @param {string[]|Array<{text:string}>} texts
 * @param {{apiKey:string,apiSecret:string,accessToken:string,accessTokenSecret:string}} creds
 * @param {{dryRun?:boolean, username?:string, fetchImpl?:Function, sleepImpl?:Function, log?:Function}} [opts]
 * @returns {Promise<{ids:string[], urls:string[]}>}
 */
export async function postThread(texts, creds, opts = {}) {
  const {
    dryRun = false,
    username,
    fetchImpl = globalThis.fetch,
    sleepImpl = sleep,
    log = console.log,
  } = opts;

  const list = (Array.isArray(texts) ? texts : [texts])
    .map((t) => (typeof t === 'string' ? t : t?.text))
    .filter((t) => typeof t === 'string' && t.trim() !== '');

  if (list.length === 0) return { ids: [], urls: [] };

  if (dryRun) {
    log('===== DRY RUN（実際には投稿しません） =====');
    list.forEach((text, i) => {
      log(`----- ${i + 1}/${list.length}${i > 0 ? '（リプライ）' : ''} -----`);
      log(text);
    });
    log(`===== 合計 ${list.length} ツイート =====`);
    return { ids: list.map((_, i) => `dry-${i + 1}`), urls: [] };
  }

  const invalid = validateCreds(creds);
  if (invalid) throw new Error(invalid);

  const ids = [];
  let replyToId = null;
  for (let i = 0; i < list.length; i += 1) {
    if (i > 0) await sleepImpl(TWEET_INTERVAL_MS);
    try {
      const id = await postOne(list[i], replyToId, creds, { fetchImpl, sleepImpl, log });
      ids.push(id);
      replyToId = id;
    } catch (err) {
      const wrapped = new Error(`${i + 1}本目の投稿に失敗しました: ${err?.message ?? String(err)}`);
      wrapped.cause = err;
      wrapped.postedIds = ids.slice();
      throw wrapped;
    }
  }

  return { ids, urls: ids.map((id) => tweetUrl(id, username)) };
}

/**
 * 単発投稿。内部で postThread に委譲する。
 * @returns {Promise<{id:string|null, url:string|null, ids:string[], urls:string[]}>}
 */
export async function postSingle(text, creds, opts = {}) {
  const result = await postThread([text], creds, opts);
  return {
    id: result.ids[0] ?? null,
    url: result.urls[0] ?? null,
    ids: result.ids,
    urls: result.urls,
  };
}
