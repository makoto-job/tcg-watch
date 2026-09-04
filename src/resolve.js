/**
 * src/resolve.js — URL の正規化と Google ニュースリダイレクトの解決
 *
 * 依存パッケージなし。Node標準の fetch / Buffer のみ使用。
 */

import { USER_AGENT, DEFAULT_TIMEOUT_MS } from './rss.js';

/** 完全一致で除去するトラッキングパラメータ */
const DROP_PARAMS = new Set([
  'gclid',
  'fbclid',
  'yclid',
  'msclkid',
  'ref',
  'ref_src',
  'ref_url',
  'spm',
  'cmpid',
  'cmp',
  '_ga',
  '_gl',
  'mc_cid',
  'mc_eid',
  'igshid',
]);

/**
 * トラッキングパラメータ・ハッシュを除去し、ホストを小文字化、末尾スラッシュを正規化する。
 * パースできない入力はそのまま返す（絶対に throw しない）。
 * @param {string} url
 * @returns {string}
 */
export function canonicalizeUrl(url) {
  const input = String(url == null ? '' : url).trim();
  if (!input) return input;
  let u;
  try {
    u = new URL(input);
  } catch {
    return input;
  }

  // 記事本体ではなく付随ページを指すURLを本体に寄せる。
  // Yahoo!ニュースの `/articles/<id>/images/000`（画像一覧）や `/comments` を
  // そのまま貼ると、読者は記事にたどり着けない。
  if (/(^|\.)news\.yahoo\.co\.jp$/.test(u.hostname)) {
    const m = u.pathname.match(/^(\/articles\/[0-9a-f]+)(?:\/(?:images|comments|videos)(?:\/.*)?)?\/?$/i);
    if (m) u.pathname = m[1];
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return input;

  try {
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();

    for (const key of [...u.searchParams.keys()]) {
      const lk = key.toLowerCase();
      if (lk.startsWith('utm_') || DROP_PARAMS.has(lk)) u.searchParams.delete(key);
    }

    // 末尾スラッシュ正規化（パスが "/" だけの場合は残す）
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '') || '/';

    let out = u.toString();
    if (out.endsWith('?')) out = out.slice(0, -1);
    return out;
  } catch {
    return input;
  }
}

/** news.google.com 由来のURLかどうか */
export function isGoogleNewsUrl(url) {
  try {
    const h = new URL(String(url)).hostname.toLowerCase();
    return h === 'news.google.com' || h.endsWith('.news.google.com');
  } catch {
    return false;
  }
}

/**
 * Google ニュースの記事IDをオフラインで base64url デコードして実URLを取り出す。
 * 旧形式のIDには実URLがそのまま埋め込まれているため、ネットワークなしで解決できる。
 * 新形式（protobuf化されたもの）では null を返す。
 * @param {string} url
 * @returns {string|null}
 */
export function decodeGoogleNewsUrl(url) {
  try {
    const m = String(url).match(/news\.google\.com\/(?:rss\/)?(?:articles|read)\/([^?/#]+)/i);
    if (!m) return null;

    let b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4 !== 0) b64 += '=';
    const buf = Buffer.from(b64, 'base64');
    if (!buf || buf.length === 0) return null;

    // バイト列を latin1 として見て URL 文字列を抜き出す
    const latin1 = buf.toString('latin1');
    const hit = latin1.match(/https?:\/\/[^\s\x00-\x1f"']+/);
    if (!hit) return null;

    // 長さプレフィックス由来のゴミが末尾に混じるので、印字可能ASCII以外で切る
    let found = hit[0].split(/[^\x21-\x7e]/)[0];
    // 末尾の区切り記号らしきゴミを軽く落とす
    found = found.replace(/[)\]}>,;'"]+$/, '');
    if (!/^https?:\/\/[^/]+/i.test(found)) return null;
    if (isGoogleNewsUrl(found)) return null;

    // 妥当性チェック
    try {
      // eslint-disable-next-line no-new
      new URL(found);
    } catch {
      return null;
    }
    return found;
  } catch {
    return null;
  }
}

/** HTML本文から実URLを抽出する（フォールバック用） */
export function extractRealUrlFromHtml(html) {
  if (!html) return null;
  const text = String(html);

  const au = text.match(/data-n-au="([^"]+)"/i);
  if (au && au[1]) {
    const v = decodeHtmlAttr(au[1]);
    if (v && !isGoogleNewsUrl(v)) return v;
  }

  const meta = text.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["'][^"']*?URL=([^"']+)["']/i);
  if (meta && meta[1]) {
    const v = decodeHtmlAttr(meta[1]);
    if (v && !isGoogleNewsUrl(v)) return v;
  }

  const cwiz = text.match(/<c-wiz[^>]*>[\s\S]*?href="(https?:\/\/(?!news\.google)[^"]+)"/i);
  if (cwiz && cwiz[1]) {
    const v = decodeHtmlAttr(cwiz[1]);
    if (v) return v;
  }

  return null;
}

/**
 * Google ニュースの中間ページには署名付きの解決用パラメータが埋まっている。
 * それを使って DotsSplashUi の batchexecute を叩くと実URLが返る。
 * （2024年以降の `CBM...` 形式IDはオフラインデコードできないため、これが本命の経路）
 * @param {string} html 中間ページのHTML
 * @returns {Promise<string|null>}
 */
export async function resolveViaBatchExecute(html) {
  if (!html) return null;
  const sg = /data-n-a-sg="([^"]+)"/.exec(html);
  const ts = /data-n-a-ts="([^"]+)"/.exec(html);
  const id = /data-n-a-id="([^"]+)"/.exec(html);
  if (!sg || !ts || !id) return null;

  const inner = JSON.stringify([
    'garturlreq',
    [
      ['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1],
      'X',
      'X',
      1,
      [1, 1, 1],
      1,
      1,
      null,
      0,
      0,
      null,
      0,
    ],
    id[1],
    Number(ts[1]),
    sg[1],
  ]);
  const freq = JSON.stringify([[['Fbv4je', inner, null, 'generic']]]);

  try {
    const res = await fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
      method: 'POST',
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      headers: {
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'user-agent': USER_AGENT,
      },
      body: `f.req=${encodeURIComponent(freq)}`,
    });
    if (!res.ok) return null;
    const text = await res.text();
    const hit = /garturlres[\\"',\s]+(https?:\/\/[^\\"']+)/.exec(text);
    if (!hit) return null;
    const found = hit[1];
    if (isGoogleNewsUrl(found)) return null;
    return found;
  } catch {
    return null;
  }
}

function decodeHtmlAttr(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&#x2f;/gi, '/')
    .replace(/&#47;/g, '/')
    .replace(/&quot;/g, '"')
    .trim();
}

/** 解決結果のメモ化（同時実行制御は呼び出し側の責務） */
const resolveCache = new Map();

/** テスト・運用用にキャッシュをクリアする */
export function clearResolveCache() {
  resolveCache.clear();
}

/**
 * Google ニュースのリダイレクトリンクを実URLへ解決する。
 * 1) オフライン base64 デコード → 2) リダイレクト追跡 → 3) HTML解析 の順に試す。
 * すべて失敗しても入力をそのまま返す（絶対に throw しない）。
 * @param {string} url
 * @returns {Promise<string>}
 */
export async function resolveUrl(url) {
  const input = String(url == null ? '' : url).trim();
  if (!input) return input;
  if (resolveCache.has(input)) return resolveCache.get(input);

  // Googleニュース以外は正規化だけ
  if (!isGoogleNewsUrl(input)) {
    const c = canonicalizeUrl(input);
    resolveCache.set(input, c);
    return c;
  }

  let result = null;

  // 1) オフラインデコード
  try {
    const offline = decodeGoogleNewsUrl(input);
    if (offline) result = offline;
  } catch {
    /* noop */
  }

  // 2) リダイレクト追跡 + 3) HTML解析
  if (!result) {
    try {
      const res = await fetch(input, {
        redirect: 'follow',
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        headers: {
          'user-agent': USER_AGENT,
          'accept-language': 'ja,en;q=0.8',
        },
      });

      if (res.url && !isGoogleNewsUrl(res.url)) {
        result = res.url;
      } else {
        let html = '';
        try {
          html = await res.text();
        } catch {
          html = '';
        }
        // 3) HTML内の直接リンク
        const fromHtml = extractRealUrlFromHtml(html);
        if (fromHtml) {
          result = fromHtml;
        } else {
          // 4) 署名付きパラメータ経由で batchexecute に問い合わせる
          result = await resolveViaBatchExecute(html);
        }
      }
    } catch {
      /* ネットワーク失敗は無視して入力にフォールバック */
    }
  }

  const finalUrl = canonicalizeUrl(result || input);
  resolveCache.set(input, finalUrl);
  return finalUrl;
}
