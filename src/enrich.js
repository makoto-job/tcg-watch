/**
 * src/enrich.js — 区画G: 応募ページ抽出・締切抽出
 *
 * 目的は「最短で抽選ページに飛んで、締切に間に合って応募すること」。
 * 記事HTMLから「実際の応募ページの直リンク」と「いつまでに応募すればよいか」を取り出す。
 *
 * 設計方針:
 *   - npm依存なし。Node標準の fetch / fs / url のみ。
 *   - 絶対に throw しない。ネットワーク失敗・パース失敗は握りつぶして元のitemを返す。
 *   - **誤った締切を出すのは、締切を出さないより有害**。確信が持てなければ null を返す。
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { USER_AGENT, decodeDisplayText, stripTags, collapseWhitespace } from './rss.js';
import { canonicalizeUrl } from './resolve.js';

/* ================================================================== */
/* 設定の読み込み                                                      */
/* ================================================================== */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOPS_PATH = path.join(HERE, '..', 'config', 'shops.json');

const EMPTY_SHOPS_CONFIG = { shops: [], blockedDomains: [], anchorBoostWords: [] };

let shopsConfigCache = null;

/**
 * config/shops.json を読む。失敗しても throw せず空設定を返す。
 * @returns {Promise<{shops:Array, blockedDomains:string[], anchorBoostWords:string[]}>}
 */
export async function loadShopsConfig() {
  if (shopsConfigCache) return shopsConfigCache;
  try {
    const raw = await readFile(SHOPS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    shopsConfigCache = {
      shops: Array.isArray(parsed.shops) ? parsed.shops : [],
      blockedDomains: Array.isArray(parsed.blockedDomains) ? parsed.blockedDomains : [],
      anchorBoostWords: Array.isArray(parsed.anchorBoostWords) ? parsed.anchorBoostWords : [],
    };
    return shopsConfigCache;
  } catch {
    return EMPTY_SHOPS_CONFIG;
  }
}

/** テスト用: 設定キャッシュを捨てる */
export function clearShopsConfigCache() {
  shopsConfigCache = null;
}

/* ================================================================== */
/* URL ユーティリティ                                                  */
/* ================================================================== */

/** パースできなければ null（throwしない） */
function parseUrl(u, base) {
  try {
    const parsed = base ? new URL(u, base) : new URL(u);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** ホストが domain 自身かそのサブドメインか */
function hostMatches(host, domain) {
  if (!host || !domain) return false;
  const h = String(host).toLowerCase().replace(/^www\./, '');
  const d = String(domain).toLowerCase().replace(/^www\./, '');
  return h === d || h.endsWith('.' + d);
}

/**
 * ショップ定義を1つ返す。より具体的（長い）ドメイン定義を優先する。
 * 例: books.rakuten.co.jp は「楽天ブックス」に、それ以外の rakuten.co.jp は「楽天」に。
 */
function findShop(host, shops) {
  let best = null;
  for (const shop of shops) {
    if (!shop || !shop.domain) continue;
    if (!hostMatches(host, shop.domain)) continue;
    if (!best || String(shop.domain).length > String(best.domain).length) best = shop;
  }
  return best;
}

function isBlockedHost(host, blockedDomains) {
  for (const d of blockedDomains || []) {
    if (hostMatches(host, d)) return true;
  }
  return false;
}

/* ================================================================== */
/* unwrapAffiliate                                                     */
/* ================================================================== */

/**
 * リダイレクト型アフィリエイト。実URLがクエリパラメータに埋まっているもの。
 * 上から順に判定し、最初にマッチしたものを使う。
 */
const AFFILIATE_REDIRECTS = [
  { host: /(^|\.)moshimo\.com$/i, params: ['url', 'u'] },
  { host: /(^|\.)valuecommerce\.com$/i, params: ['vc_url'] },
  { host: /(^|\.)afl\.rakuten\.co\.jp$/i, params: ['pc', 'm'] },
  { host: /(^|\.)linksynergy\.com$/i, params: ['murl', 'RD_PARM1'] },
];

/**
 * 実URLが埋まっていないため解除できないアフィリエイトドメイン。
 * そのまま返す（呼び出し側でショップ許可リストに載っていないので不採用になる）。
 */
const UNRESOLVABLE_AFFILIATES = [
  /(^|\.)a8\.net$/i,
  /(^|\.)accesstrade\.net$/i,
  /(^|\.)felmat\.net$/i,
  /(^|\.)rentracks\.jp$/i,
];

/** Amazon から除去するトラッキングパラメータ */
const AMAZON_DROP_PARAMS = new Set([
  'tag',
  'linkcode',
  'linkid',
  'ascsubtag',
  'ref',
  'ref_',
  'creative',
  'creativeasin',
  'camp',
  'camp_id',
  'adid',
  'psc',
  '_encoding',
  'smid',
  'qid',
  'sr',
  'sprefix',
  'crid',
  'th',
]);

/** 二重エンコードされた値を必要なら1回デコードする */
function decodeMaybe(value) {
  if (!value) return value;
  let v = String(value);
  if (!/^https?:\/\//i.test(v) && /^https?(%3a|%3A)/.test(v)) {
    try {
      v = decodeURIComponent(v);
    } catch {
      /* noop */
    }
  }
  return v;
}

/** Amazon URL からトラッキングを落とす。Amazon以外は入力をそのまま返す。 */
function cleanAmazonUrl(url) {
  const u = parseUrl(url);
  if (!u) return url;
  if (!/(^|\.)amazon\.(co\.jp|com|jp)$/i.test(u.hostname)) return url;
  try {
    for (const key of [...u.searchParams.keys()]) {
      const lk = key.toLowerCase();
      if (AMAZON_DROP_PARAMS.has(lk) || lk.startsWith('pf_rd_') || lk.startsWith('pd_rd_')) {
        u.searchParams.delete(key);
      }
    }
    // `/dp/B0XXXX/ref=xxx` のようなパス中の ref セグメントを落とす
    u.pathname = u.pathname.replace(/\/ref=[^/]*/gi, '');
    u.hash = '';
    let out = u.toString();
    if (out.endsWith('?')) out = out.slice(0, -1);
    return out;
  } catch {
    return url;
  }
}

/** 1段だけ解除する。解除できなければ null。 */
function unwrapOnce(url) {
  const u = parseUrl(url);
  if (!u) return null;
  for (const rule of AFFILIATE_REDIRECTS) {
    if (!rule.host.test(u.hostname)) continue;
    for (const p of rule.params) {
      const raw = u.searchParams.get(p);
      if (!raw) continue;
      const decoded = decodeMaybe(raw);
      const target = parseUrl(decoded);
      if (target) return decoded;
    }
    return null; // アフィリドメインだが実URLが取れない
  }
  return null;
}

/**
 * アフィリエイトリンクを実URLに解除する（純関数）。
 * 解除できないものは**入力をそのまま返す**（採用可否は呼び出し側が判定する）。
 * 二重エンコード・ネストに備えて最大2回まで再帰的に解除する。
 * @param {string} url
 * @returns {string}
 */
export function unwrapAffiliate(url) {
  const input = String(url == null ? '' : url).trim();
  if (!input) return input;

  const parsed = parseUrl(input);
  if (parsed && UNRESOLVABLE_AFFILIATES.some((re) => re.test(parsed.hostname))) {
    return input; // a8.net 等は解除不能。そのまま返す。
  }

  let current = input;
  for (let i = 0; i < 2; i++) {
    const next = unwrapOnce(current);
    if (!next || next === current) break;
    current = next;
    if (UNRESOLVABLE_AFFILIATES.some((re) => re.test(parseUrl(current)?.hostname || ''))) break;
  }

  return cleanAmazonUrl(current);
}

/* ================================================================== */
/* extractDestination                                                  */
/* ================================================================== */

/** タグの属性文字列から属性値を取り出す（HTMLエンティティ復号済み） */
function getAttrValue(attrs, name) {
  if (!attrs) return '';
  const re = new RegExp(`(?:^|[\\s/])${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const m = re.exec(attrs);
  if (!m) return '';
  const raw = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] || '';
  return decodeDisplayText(raw).trim();
}

/** 記事HTML内に現れる全 href を、絶対化→アフィリ解除→正規化して数える */
function countHrefs(html, baseUrl) {
  const counts = new Map();
  const re = /(?:^|[\s/])href\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] || '';
    const norm = normalizeHref(raw, baseUrl);
    if (!norm) continue;
    counts.set(norm, (counts.get(norm) || 0) + 1);
  }
  return counts;
}

function normalizeHref(rawHref, baseUrl) {
  const href = decodeDisplayText(String(rawHref || '')).trim();
  if (!href || href.startsWith('#') || /^(javascript|mailto|tel|data):/i.test(href)) return null;
  const abs = parseUrl(href, baseUrl || undefined);
  if (!abs) return null;
  return canonicalizeUrl(unwrapAffiliate(abs.toString()));
}

/**
 * 記事の見出し（title / og:title / h1）を取り出す。
 * 「駿河屋通販で抽選販売」のように、記事タイトルは応募先の店名を名指ししていることが多い。
 */
function extractHeadline(html) {
  const parts = [];
  const title = /<title\b[^>]*>([\s\S]{0,300}?)<\/title\s*>/i.exec(html);
  if (title) parts.push(title[1]);
  const og = /<meta\b[^>]*property\s*=\s*["']og:title["'][^>]*>/i.exec(html);
  if (og) parts.push(getAttrValue(og[0], 'content'));
  const h1 = /<h1\b[^>]*>([\s\S]{0,300}?)<\/h1\s*>/i.exec(html);
  if (h1) parts.push(h1[1]);
  // 「記事タイトル | サイト名」のサイト名部分を落とす（最も長い区間を採用）
  return parts
    .map((p) => collapseWhitespace(decodeDisplayText(stripTags(p))))
    .map((p) => p.split(/[|｜]/).sort((a, b) => b.length - a.length)[0] || '')
    .join(' ')
    .trim();
}

/** 記事タイトル由来の一般語。これで一致しても「関連している」根拠にならない。 */
const HEADLINE_STOPWORDS = new Set([
  'ゲーム', 'ニュース', 'メディア', 'インサイド', '人生', '情報', '特集', '記事', '公式',
  '販売', '商品', '限定', '発売', '予約', '抽選', '受付', '開始', '記念', '通販', 'セット',
  'キャンペーン', 'オンライン', 'ショップ', 'ストア', 'カード', 'グッズ',
]);

/**
 * 記事タイトルから「その記事を特徴づける語」を抜き出す。
 * カタカナ3文字以上 / 英数3文字以上 / 漢字2文字以上の連続をトークンとする。
 */
function headlineTokens(headline) {
  const out = new Set();
  for (const m of String(headline).matchAll(/[ァ-ヴー]{3,}|[A-Za-z0-9]{3,}|[一-龥々]{2,}/g)) {
    const t = m[0];
    if (HEADLINE_STOPWORDS.has(t)) continue;
    out.add(t.toLowerCase());
  }
  return [...out];
}

/**
 * その候補リンクが記事の話題と関係していそうか。
 * 記事下部のアフィリエイト価格ウィジェット（記事と無関係な商品）を弾くための最終防衛線。
 */
function looksRelevant(tokens, anchorText, url) {
  if (!tokens.length) return true; // 見出しが取れないときは判定しない
  let haystack = `${anchorText} `;
  try {
    haystack += decodeURIComponent(url);
  } catch {
    haystack += url;
  }
  haystack = haystack.toLowerCase();
  return tokens.some((t) => haystack.includes(t));
}

/** 見出しがこの店を名指ししているか */
function headlineNamesShop(headline, shop) {
  if (!headline || !shop) return false;
  const names = [shop.label, ...(Array.isArray(shop.aliases) ? shop.aliases : [])];
  return names.some((n) => n && String(n).length >= 2 && headline.includes(n));
}

/**
 * 記事タイトルがいずれかの店を名指ししているか。
 * 名指しがある記事は「その店で応募する」記事なので、
 * 他店のリンクを応募先にしてはいけない。
 * @param {string} headline
 * @param {Array<{label?:string, aliases?:string[]}>} shops
 * @returns {boolean}
 */
function headlineNamesAnyShop(headline, shops) {
  if (!headline || !Array.isArray(shops)) return false;
  return shops.some((shop) => headlineNamesShop(headline, shop));
}

/** トップページそのものか */
function isTopPage(u) {
  const p = u.pathname || '/';
  return p === '/' || /^\/(index\.(html?|php|aspx?))$/i.test(p);
}

/**
 * 候補の優劣。上の段ほど強い判断材料。
 *   1. 記事タイトルが店を名指ししているか（アフィリ広告リンク対策）
 *   2. アンカーテキストに「抽選/応募/予約/購入/商品ページ」等があるか
 *   3. 採点（ドメイン優先度・パスの深さ・トップページ減点）
 *   4. ドメイン優先度 → HTML中の出現順
 */
function betterCandidate(a, b) {
  if (a.named !== b.named) return a.named > b.named;
  if (a.boost !== b.boost) return a.boost > b.boost;
  if (a.score !== b.score) return a.score > b.score;
  if (a.priority !== b.priority) return a.priority > b.priority;
  return a.order < b.order;
}

/**
 * 記事HTMLから応募・予約・購入ページの直リンクを1つ選ぶ（純関数）。
 *
 * 採点:
 *   priority * 10
 *   + アンカーテキストに anchorBoostWords が含まれれば +15（複数該当でも+15まで）
 *   + URLパスが深い（商品ページらしい）なら +5
 *   - トップページそのものなら -40
 *
 * 同一URLがHTML中に5回以上出現するもの（ヘッダ/フッタの共通リンク）は除外する。
 *
 * @param {string} html
 * @param {string} baseUrl 相対URL解決の基準（記事URL）
 * @param {{shops:Array,blockedDomains:string[],anchorBoostWords:string[]}} shopsConfig
 * @returns {{url:string,label:string,priority:number}|null}
 */
export function extractDestination(html, baseUrl, shopsConfig, opts = {}) {
  try {
    if (!html || typeof html !== 'string') return null;
    const cfg = shopsConfig || EMPTY_SHOPS_CONFIG;
    const shops = Array.isArray(cfg.shops) ? cfg.shops : [];
    if (!shops.length) return null;
    const blocked = Array.isArray(cfg.blockedDomains) ? cfg.blockedDomains : [];
    const boostWords = Array.isArray(cfg.anchorBoostWords) ? cfg.anchorBoostWords : [];

    const counts = countHrefs(html, baseUrl);
    // 本文からの見出し抽出はサイト構造に左右される（Yahoo!ニュース等で取りこぼす）。
    // 呼び出し側が既に確実なタイトルを持っているので、あれば併せて判定に使う。
    const scraped = extractHeadline(html);
    const given = typeof opts.title === 'string' ? opts.title : '';
    const headline = `${scraped} ${given}`.trim();
    const tokens = headlineTokens(headline);

    /** @type {Map<string,object>} */
    const candidates = new Map();
    let order = 0;

    const anchorRe = /<a\b([^>]*)>([\s\S]{0,4000}?)<\/a\s*>/gi;
    let m;
    while ((m = anchorRe.exec(html)) !== null) {
      const attrs = m[1];
      const href = getAttrValue(attrs, 'href');
      if (!href) continue;

      const norm = normalizeHref(href, baseUrl);
      if (!norm) continue;

      // ナビ・フッターの共通リンクを除外
      if ((counts.get(norm) || 0) >= 5) continue;

      const u = parseUrl(norm);
      if (!u) continue;

      if (isBlockedHost(u.hostname, blocked)) continue;

      const shop = findShop(u.hostname, shops);
      if (!shop) continue;

      const anchorText = collapseWhitespace(
        `${decodeDisplayText(stripTags(m[2]))} ${getAttrValue(attrs, 'title')} ${getAttrValue(attrs, 'aria-label')}`
      );

      const priority = Number(shop.priority) || 0;
      const hasBoost = boostWords.some((w) => w && anchorText.includes(w));
      const top = isTopPage(u);

      let score = priority * 10;
      if (hasBoost) score += 15;
      const segments = (u.pathname || '/').split('/').filter(Boolean);
      if (segments.length >= 2) score += 5;
      if (top) score -= 40;

      // 記事タイトルが名指ししている店 = ほぼ確実に応募先。
      // 記事下部のアフィリエイト価格ウィジェット（無関係なAmazon/楽天リンク）に
      // 引っ張られないための最重要シグナル。ただしトップページは対象外。
      const named = !top && headlineNamesShop(headline, shop);

      // 店名の名指しも購入導線の文言も無い最下位の候補は、記事の話題と
      // 無関係なら採用しない（別商品のアフィリエイト広告であることが多い）。
      if (!named && !hasBoost && !looksRelevant(tokens, anchorText, norm)) continue;

      const cand = {
        url: norm,
        label: String(shop.label || shop.domain),
        priority,
        score,
        named: named ? 1 : 0,
        boost: hasBoost ? 1 : 0,
        order: order,
      };

      const prev = candidates.get(norm);
      if (!prev || betterCandidate(cand, prev)) {
        cand.order = prev ? prev.order : order++;
        candidates.set(norm, cand);
      }
    }

    let best = null;
    for (const c of candidates.values()) {
      if (!best || betterCandidate(c, best)) best = c;
    }
    if (!best) return null;

    // 記事が特定の店を名指ししているのに、その店へのリンクが記事内に無い場合、
    // 別の店のリンクを応募先として返してはいけない。
    // 例:「ヨドバシで抽選販売」という記事から、記事下部にあった
    //     ポケモンセンターのリンクを拾ってしまう事故を防ぐ。
    // 違う店に飛ばすのは、リンクを出さないことより有害
    //（応募したつもりで応募できていない状態になる）。
    if (!best.named && headlineNamesAnyShop(headline, shops)) return null;

    return { url: best.url, label: best.label, priority: best.priority };
  } catch {
    return null;
  }
}

/** タイトルが一覧ページ側で切り詰められているか（末尾が省略記号） */
export function isTruncatedTitle(title) {
  return /(?:\.{3}|…|‥)\s*$/.test(String(title || '').trim());
}

/**
 * 商品ページ等から正式なタイトルを取り出す。
 * 一覧ページは商品名を20字程度で切ってしまうため、
 * 「デジモンカードゲーム リミテッ...」のままだと何の商品か分からない。
 * og:title → <title> の順に探し、取れなければ空文字。
 * @param {string} html
 * @returns {string}
 */
export function extractPageTitle(html) {
  const s = String(html || '');
  const og =
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(s) ||
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i.exec(s);
  let t = og ? og[1] : '';
  if (!t) {
    const m = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(s);
    t = m ? m[1] : '';
  }
  t = collapseWhitespace(decodeDisplayText(stripTags(t)));
  // 「商品名｜プレミアムバンダイ」のようなサイト名サフィックスを落とす
  t = t.replace(/\s*[|｜]\s*[^|｜]{1,30}$/, '').trim();
  return t;
}

/* ================================================================== */
/* 本文の切り出し                                                      */
/* ================================================================== */

/** 本文コンテナによく使われる class / id */
const BODY_CONTAINER_RE =
  /<div\b[^>]*(?:class|id)\s*=\s*["'][^"']*(?:entry-content|entry_content|article-body|article_body|articleBody|post-content|post_content|post-body|arti-body|news-body|news_body|main-text|maintext|story-body)[^"']*["'][^>]*>/i;

/**
 * 開始タグの直後から、対応する終了タグまでを切り出す（入れ子の深さを数える）。
 * 見つからなければ null。
 */
function sliceBalancedTag(s, startIndex, tagName) {
  const re = new RegExp(`<${tagName}\\b[^>]*>|</${tagName}\\s*>`, 'gi');
  re.lastIndex = startIndex;
  let depth = 1;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m[0][1] === '/') {
      depth--;
      if (depth === 0) return s.slice(startIndex, m.index);
    } else {
      depth++;
    }
    if (re.lastIndex - startIndex > 500000) break;
  }
  return null;
}

/**
 * 記事HTMLから**本文だけ**をプレーンテキストで取り出す（純関数）。
 *
 * ニュースサイトのページには「関連記事」「ランキング」「注目記事」が同居していて、
 * そこには**別の抽選の締切**が書かれている。ページ全体から日付を拾うと
 * 「ドンキの抽選は8月31日まで」を今読んでいるAmazon抽選の締切として出してしまう。
 * 誤った締切は出さない方がマシなので、本文領域に絞ってから日付を探す。
 *
 * @param {string} html
 * @returns {string} 本文のプレーンテキスト（本文領域が特定できなければ空文字）
 */
export function extractMainText(html) {
  try {
    if (!html || typeof html !== 'string') return '';

    // スクリプト・スタイル・ナビ・サイドバー・フッターを丸ごと落とす
    let s = html
      .replace(/<(script|style|noscript|template|svg|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<(nav|aside|footer|header)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');

    const toText = (fragment) => collapseWhitespace(decodeDisplayText(stripTags(fragment)));

    // <article> のうち最も本文らしい（テキストが長い）ものを本文とみなす。
    // 関連記事カードも <article> であることが多いが、本文より遥かに短い。
    let best = '';
    for (const m of s.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article\s*>/gi)) {
      const t = toText(m[1]);
      if (t.length > best.length) best = t;
    }
    if (best.length >= 200) return best;

    // <article> が無いサイト（4Gamer の div.entry-content 等）向けのフォールバック。
    // 開始タグから対応する終了タグまでを深さを数えて切り出す。
    const container = BODY_CONTAINER_RE.exec(s);
    if (container) {
      const inner = sliceBalancedTag(s, container.index + container[0].length, 'div');
      if (inner) {
        const t = toText(inner);
        if (t.length > best.length) best = t;
      }
    }
    if (best.length >= 200) return best;

    const main = /<main\b[^>]*>([\s\S]*?)<\/main\s*>/i.exec(s);
    if (main) {
      const t = toText(main[1]);
      if (t.length >= 200) return t;
    }
    return best;
  } catch {
    return '';
  }
}

/* ================================================================== */
/* extractSchedule                                                     */
/* ================================================================== */

const JST_OFFSET_HOURS = 9;

/** 全角数字・記号を半角に寄せる */
function normalizeScheduleText(text) {
  return String(text)
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[：]/g, ':')
    .replace(/[／]/g, '/')
    .replace(/[～~]/g, '〜')
    .replace(/[‐-―−－]/g, '-')
    .replace(/[ 　]/g, ' ');
}

// --- 正規表現の部品（グループ番号に依存するので順序を変えないこと） ---
// DATE: 6グループ  1:年(和) 2:月(和) 3:日(和) / 4:年(斜線) 5:月(斜線) 6:日(斜線)
const DATE_SRC =
  '(?:(?:(\\d{4})\\s*年\\s*)?(\\d{1,2})\\s*月\\s*(\\d{1,2})\\s*日' +
  '|(?:(\\d{4})\\s*\\/\\s*)?(\\d{1,2})\\s*\\/\\s*(\\d{1,2}))';
// 曜日カッコ: グループなし
const WEEKDAY_SRC = '(?:\\s*[（(]\\s*[月火水木金土日祝][^）)]{0,3}\\s*[）)])?';
// TIME: 4グループ  1:時(コロン) 2:分(コロン) / 3:時(和) 4:分(和)
const TIME_SRC = '(?:(\\d{1,2})\\s*:\\s*(\\d{1,2})|(\\d{1,2})\\s*時\\s*(?:(\\d{1,2})\\s*分)?)';
// DATETIME: 10グループ（DATE 6 + TIME 4）
const DT_SRC = DATE_SRC + WEEKDAY_SRC + '(?:\\s*(?:' + TIME_SRC + '))?';

const SEPARATOR = '(?:〜|-|–|—|から|より|to)';
const SEP_ONLY_RE = new RegExp('^\\s*' + SEPARATOR + '\\s*$');
const TIME_ONLY_TAIL_RE = new RegExp('^\\s*' + SEPARATOR + '\\s*(?:' + TIME_SRC + ')');

/**
 * 「これは応募締切ではない」文脈のキーワード。
 * 発売日・発送日はもちろん、当選発表日や支払期間も応募締切ではない
 * （これらを締切として出すと「まだ間に合う」と誤解させ、応募を落とす）。
 */
const EXCLUDE_RE =
  /(発売|発送|出荷|入荷|再入荷|お届け|配送|納品|更新|公開|掲載|投稿|配信開始日|支払|支払い|お支払|当選|抽選結果|結果発表|発表日)/;
/** 締切を示すキーワード（日時の直前） */
const DEADLINE_BEFORE_RE = /(締切|締め切り|〆切|〆|期限|終了|最終|ラスト|まで)/;
/** 締切を示すキーワード（日時の直後） */
const DEADLINE_AFTER_RE = /^\s*(?:まで|迄|に締|締切|締め切り|〆切|終了|一杯|いっぱい)/;
/** 開始を示すキーワード（日時の直前） */
const START_BEFORE_RE = /(開始|受付|応募|抽選|予約|エントリー|申込|申し込み|開催|スタート|発売開始)/;
/** 開始を示すキーワード（日時の直後） */
const START_AFTER_RE = /^\s*(?:から|より|スタート|開始|受付開始)/;

/**
 * 正規化済みテキストから日時トークンを全て拾う。
 * @param {string} s
 * @returns {Array<{start:number,end:number,y:number|null,mo:number,d:number,h:number|null,mi:number|null}>}
 */
function scanDateTimes(s) {
  const re = new RegExp(DT_SRC, 'g');
  const out = [];
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m[0] === '') {
      re.lastIndex++;
      continue;
    }
    const tok = parseDtGroups(m, 1);
    if (!tok) continue;
    tok.start = m.index;
    tok.end = m.index + m[0].length;
    out.push(tok);
  }
  return out;
}

/** DT_SRC のグループ（base から10個）を読む */
function parseDtGroups(m, base) {
  const yRaw = m[base + 0] !== undefined ? m[base + 0] : m[base + 3];
  const moRaw = m[base + 1] !== undefined ? m[base + 1] : m[base + 4];
  const dRaw = m[base + 2] !== undefined ? m[base + 2] : m[base + 5];
  if (moRaw === undefined || dRaw === undefined) return null;

  const mo = Number(moRaw);
  const d = Number(dRaw);
  if (!(mo >= 1 && mo <= 12) || !(d >= 1 && d <= 31)) return null;

  const time = parseTimeGroups(m, base + 6);
  return {
    y: yRaw !== undefined ? Number(yRaw) : null,
    mo,
    d,
    h: time ? time.h : null,
    mi: time ? time.mi : null,
    start: 0,
    end: 0,
  };
}

/** TIME_SRC のグループ（base から4個）を読む */
function parseTimeGroups(m, base) {
  const hRaw = m[base + 0] !== undefined ? m[base + 0] : m[base + 2];
  if (hRaw === undefined) return null;
  const miRaw = m[base + 0] !== undefined ? m[base + 1] : m[base + 3];
  let h = Number(hRaw);
  const mi = miRaw !== undefined ? Number(miRaw) : 0;
  if (!(mi >= 0 && mi <= 59)) return null;
  if (h === 24 && mi === 0) h = 24; // 24:00 は翌0時として後段で処理
  if (!(h >= 0 && h <= 24)) return null;
  return { h, mi };
}

/** JSTのY/M/D H:M を UTC の ms に変換。存在しない日付なら null。 */
function jstToMs(y, mo, d, h, mi) {
  let hour = h;
  let day = d;
  if (hour === 24) {
    hour = 0;
    day = d + 1;
  }
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    return null;
  }
  return Date.UTC(y, mo - 1, day, hour - JST_OFFSET_HOURS, mi, 0, 0);
}

/** now の JST 年 */
function jstYear(now) {
  const shifted = new Date(now.getTime() + JST_OFFSET_HOURS * 3600 * 1000);
  return shifted.getUTCFullYear();
}

/**
 * トークンをISO文字列にする。年が無ければ推定（それだと過去になる場合は翌年）。
 * @param {object} tok
 * @param {'start'|'deadline'} role
 * @param {number} anchorMs これより前になるなら翌年とみなす基準時刻
 * @param {Date} now
 */
function tokenToIso(tok, role, anchorMs, now) {
  const h = tok.h !== null ? tok.h : role === 'deadline' ? 23 : 0;
  const mi = tok.h !== null ? tok.mi : role === 'deadline' ? 59 : 0;

  if (tok.y !== null) {
    const ms = jstToMs(tok.y, tok.mo, tok.d, h, mi);
    return ms === null ? null : new Date(ms).toISOString();
  }

  const baseYear = jstYear(now);
  for (const y of [baseYear, baseYear + 1]) {
    const ms = jstToMs(y, tok.mo, tok.d, h, mi);
    if (ms === null) continue;
    if (ms >= anchorMs) return new Date(ms).toISOString();
  }
  // どの年でも anchor 以降にならない（= 2月30日など不正日付）
  const fallback = jstToMs(baseYear + 1, tok.mo, tok.d, h, mi);
  return fallback === null ? null : new Date(fallback).toISOString();
}

/**
 * 期間の「開始」側を、締切以前になるように年を決める。
 * 例: now=12月、「12/28〜1/5」なら 締切=翌年1/5、開始=今年12/28。
 */
function tokenToIsoBeforeDeadline(tok, deadlineIso) {
  const h = tok.h !== null ? tok.h : 0;
  const mi = tok.h !== null ? tok.mi : 0;
  const deadlineMs = new Date(deadlineIso).getTime();

  if (tok.y !== null) {
    const ms = jstToMs(tok.y, tok.mo, tok.d, h, mi);
    return ms === null ? null : new Date(ms).toISOString();
  }

  const deadlineYear = new Date(new Date(deadlineIso).getTime() + JST_OFFSET_HOURS * 3600 * 1000).getUTCFullYear();
  for (const y of [deadlineYear, deadlineYear - 1]) {
    const ms = jstToMs(y, tok.mo, tok.d, h, mi);
    if (ms === null) continue;
    if (ms <= deadlineMs) return new Date(ms).toISOString();
  }
  return null;
}

/** 文の区切り。文をまたいだキーワードを誤って拾わないために使う。 */
const SENTENCE_BREAK = /[。！？\n\r]/;

/** 日時の直前の文脈。直近の文区切りより手前は見ない。 */
function contextBefore(s, index, len = 22) {
  const raw = s.slice(Math.max(0, index - len), index);
  const parts = raw.split(SENTENCE_BREAK);
  return parts[parts.length - 1];
}

/** 日時の直後の文脈。最初の文区切りまで。 */
function contextAfter(s, index, len = 14) {
  const raw = s.slice(index, index + len);
  return raw.split(SENTENCE_BREAK)[0];
}

/**
 * 日時に**直接くっついている**修飾語だけを見る（空白・箇条書き記号で切る）。
 * 「11月20日発送予定」は発送日だが、「16:59 ・お届け時期…」の 16:59 は
 * 直後の箇条書き項目とは無関係なので、そこまで見てはいけない。
 */
function adjacentAfter(s, index, len = 8) {
  const raw = s.slice(index, index + len);
  return raw.split(/[\s・、,／/|)）】]/)[0].split(SENTENCE_BREAK)[0];
}

/**
 * 日本語の日時表現から応募の開始と締切を取り出す（純関数）。
 * 判断がつかないものは null。**推測で埋めない**。
 *
 * @param {string} text
 * @param {{now?:Date}} [opts]
 * @returns {{startsAt:string|null, deadline:string|null}}
 */
export function extractSchedule(text, { now = new Date() } = {}) {
  const result = { startsAt: null, deadline: null };
  try {
    if (!text || typeof text !== 'string') return result;
    const s = normalizeScheduleText(text);
    const tokens = scanDateTimes(s);
    if (!tokens.length) return result;

    const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();

    /* --- 1) 期間（開始〜締切）を探す ---
     * 同じ記事に「応募は8月20日から9月6日」（要約）と
     * 「応募期間は8月20日20時〜9月6日まで」（本文）が両方あることが多い。
     * 時刻まで明記されている方が正確なので、時刻の明記が多い期間を優先する。 */
    let bestRange = null;
    for (let i = 0; i < tokens.length; i++) {
      const a = tokens[i];
      let b = null;
      let rangeEnd = 0;

      const next = tokens[i + 1];
      if (next && next.start - a.end <= 8 && SEP_ONLY_RE.test(s.slice(a.end, next.start))) {
        b = next;
        rangeEnd = next.end;
      } else if (a.h !== null) {
        // 「8/28 12:00〜23:59」のように右辺が時刻だけのケース
        const tail = TIME_ONLY_TAIL_RE.exec(s.slice(a.end, a.end + 24));
        if (tail) {
          const t = parseTimeGroups(tail, 1);
          if (t) {
            b = { y: a.y, mo: a.mo, d: a.d, h: t.h, mi: t.mi, start: a.end, end: a.end + tail[0].length };
            rangeEnd = b.end;
          }
        }
      }
      if (!b) continue;

      // 発売日・発送日の期間は締切ではない
      const before = contextBefore(s, a.start);
      const after = adjacentAfter(s, rangeEnd);
      if (EXCLUDE_RE.test(before) && !START_BEFORE_RE.test(before)) continue;
      if (EXCLUDE_RE.test(after) && !DEADLINE_AFTER_RE.test(after)) continue;

      // 締切を先に確定（now基準で年を推定）し、開始は締切以前になるよう年を決める
      const deadline = tokenToIso(b, 'deadline', nowMs, now);
      if (!deadline) continue;
      const startsAt = tokenToIsoBeforeDeadline(a, deadline);
      if (!startsAt) continue;

      const explicitness = (a.h !== null ? 1 : 0) + (b.h !== null ? 1 : 0);
      if (!bestRange || explicitness > bestRange.explicitness) {
        bestRange = { startsAt, deadline, explicitness };
      }
    }
    if (bestRange) {
      result.startsAt = bestRange.startsAt;
      result.deadline = bestRange.deadline;
      return result;
    }

    /* --- 2) 単独の開始 / 単独の締切 --- */
    for (const tok of tokens) {
      const before = contextBefore(s, tok.start);
      const after = contextAfter(s, tok.end);

      if (EXCLUDE_RE.test(before) || EXCLUDE_RE.test(after)) continue;

      const isDeadline =
        DEADLINE_AFTER_RE.test(after) || DEADLINE_BEFORE_RE.test(before) || /[〜]\s*$/.test(before);
      const isStart = START_AFTER_RE.test(after) || START_BEFORE_RE.test(before);

      if (isDeadline && !result.deadline) {
        result.deadline = tokenToIso(tok, 'deadline', nowMs, now);
      } else if (isStart && !result.startsAt) {
        result.startsAt = tokenToIso(tok, 'start', nowMs, now);
      }
      if (result.startsAt && result.deadline) break;
    }

    // 開始が締切より後になっていたら信用できない → 開始を捨てる
    if (result.startsAt && result.deadline && result.startsAt > result.deadline) {
      result.startsAt = null;
    }

    return result;
  } catch {
    return { startsAt: null, deadline: null };
  }
}

/* ================================================================== */
/* enrichItems                                                         */
/* ================================================================== */

/** 抽選・予約系かどうかの判定に使う語 */
const TARGET_RE = /(抽選|予約|受付|応募|受注|lottery|preorder|pre-order)/i;

function isTargetItem(item) {
  if (!item) return false;
  const bag = []
    .concat(Array.isArray(item.intentTags) ? item.intentTags : [])
    .concat(Array.isArray(item.ips) ? item.ips : [])
    .join(' ');
  return TARGET_RE.test(bag);
}

/** 同時実行数を制限した簡易プール */
async function runPool(tasks, concurrency) {
  const n = Math.max(1, Math.min(Number(concurrency) || 1, tasks.length));
  let cursor = 0;
  const workers = [];
  for (let i = 0; i < n; i++) {
    workers.push(
      (async () => {
        while (cursor < tasks.length) {
          const task = tasks[cursor++];
          try {
            await task();
          } catch {
            /* 絶対に throw しない */
          }
        }
      })()
    );
  }
  await Promise.all(workers);
}

/** HTMLを取得する。失敗は null（throwしない）。 */
async function fetchHtml(url, timeoutMs, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    try {
      controller.abort();
    } catch {
      /* noop */
    }
  }, Math.max(1, Number(timeoutMs) || 12000));
  try {
    const res = await fetchImpl(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'ja,en;q=0.8',
      },
    });
    if (!res || res.ok === false) return null;
    const ct = (res.headers && typeof res.headers.get === 'function' && res.headers.get('content-type')) || '';
    if (ct && !/(html|xml|text)/i.test(ct)) return null;
    const body = await res.text();
    return typeof body === 'string' ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 抽選・予約系のアイテムだけ本文を取得し、応募ページ直リンクと開始/締切を付与する。
 * **絶対に throw しない**。失敗したアイテムは何も付与せずそのまま返る。
 *
 * @param {Array<object>} items
 * @param {object} [opts]
 * @param {number} [opts.concurrency=4]
 * @param {number} [opts.timeoutMs=12000]
 * @param {object} [opts.shopsConfig]  省略時は config/shops.json を読む
 * @param {number} [opts.maxFetch=60]  本文を取得する最大件数
 * @param {boolean} [opts.verbose=false]
 * @param {Function} [opts.fetchImpl]  テスト用のfetch差し替え
 * @returns {Promise<Array<object>>} 入力と同じ配列
 */
export async function enrichItems(items, opts = {}) {
  if (!Array.isArray(items)) return items;

  const {
    concurrency = 4,
    timeoutMs = 12000,
    maxFetch = 60,
    verbose = false,
    fetchImpl,
  } = opts || {};

  let cfg = opts && opts.shopsConfig;
  try {
    if (!cfg) cfg = await loadShopsConfig();
  } catch {
    cfg = EMPTY_SHOPS_CONFIG;
  }
  const shops = Array.isArray(cfg && cfg.shops) ? cfg.shops : [];
  const blocked = Array.isArray(cfg && cfg.blockedDomains) ? cfg.blockedDomains : [];

  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  const now = new Date();

  /** 既存フィールドを壊さずに null 既定値を入れる */
  const targets = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if (item.destUrl === undefined) item.destUrl = null;
    if (item.destLabel === undefined) item.destLabel = null;
    if (item.startsAt === undefined) item.startsAt = null;
    if (item.deadline === undefined) item.deadline = null;

    if (!isTargetItem(item)) continue;

    // 記事URL自体がショップドメインなら、応募先はそれで確定
    if (!item.destUrl) {
      const own = parseUrl(unwrapAffiliate(String(item.url || '')));
      if (own && !isBlockedHost(own.hostname, blocked)) {
        const shop = findShop(own.hostname, shops);
        if (shop) {
          item.destUrl = canonicalizeUrl(own.toString());
          item.destLabel = String(shop.label || shop.domain);
          if (!item.tier) item.tier = 'shop';
        }
      }
    }

    // 応募先と締切の両方が分かっていれば取得不要。
    // 応募先が分かっていても締切が未取得なら取りに行く。
    // 小売店由来のアイテムは最初から応募先を持っているが、
    // 「いつまでに応募すればよいか」はページを見ないと分からないため。
    if (item.destUrl && item.deadline) continue;
    if (!item.url) continue;
    targets.push(item);
  }

  // 取得予算が限られるので、成果が出やすい順に処理する。
  // 1) 応募先が確定していて締切だけ欠けているもの（小売店の抽選ページ）
  //    → 商品ページには受付期間が明記されていることが多く、成功率が高い。
  //      しかもこの欄は「間に合うか」を判断する要なので価値が大きい。
  // 2) 応募先が未確定のもの（ニュース記事）
  //    → 本文構造がサイトごとにばらばらで、抽出に失敗することも多い。
  targets.sort((a, b) => (a.destUrl ? 0 : 1) - (b.destUrl ? 0 : 1));
  const limit = Math.max(0, Number(maxFetch) || 0);
  const fetchTargets = targets.slice(0, limit);

  if (verbose && targets.length > fetchTargets.length) {
    console.warn(
      `[enrich] 対象 ${targets.length} 件のうち上位 ${fetchTargets.length} 件のみ取得します（maxFetch=${limit}）`
    );
  }

  if (typeof doFetch !== 'function' || fetchTargets.length === 0) return items;

  const tasks = fetchTargets.map((item) => async () => {
    const html = await fetchHtml(item.url, timeoutMs, doFetch);
    if (!html) {
      if (verbose) console.warn(`[enrich] 本文取得に失敗: ${item.url}`);
      return;
    }

    try {
      const dest = extractDestination(html, item.url, cfg, { title: item.title || '' });
      if (dest && !item.destUrl) {
        item.destUrl = dest.url;
        item.destLabel = dest.label;
      }
    } catch {
      /* noop */
    }

    try {
      // 一覧ページで切り詰められたタイトルを、商品ページの正式名称で補う
      if (isTruncatedTitle(item.title)) {
        const full = extractPageTitle(html);
        if (full && full.length > String(item.title).length) item.title = full;
      }
    } catch {
      /* noop */
    }

    try {
      // 本文領域が特定できないページでは締切を出さない。
      // ページ全体から拾うと関連記事の別の締切を掴んでしまうため。
      const plain = extractMainText(html);
      if (plain) {
        // 年が省略された日付（「8月28日まで」）は、記事の掲載日を基準に解釈する。
        // 現在時刻を基準にすると、8/25の記事にある「8月28日」が
        // 今日（9/4）より過去という理由で「来年の8月28日」になり、
        // 締切が1年先に見えてしまう。
        const published = Date.parse(item.publishedAt);
        const base = Number.isFinite(published) ? new Date(published) : now;
        const sched = extractSchedule(plain, { now: base });
        if (sched.startsAt && !item.startsAt) item.startsAt = sched.startsAt;
        if (sched.deadline && !item.deadline) item.deadline = sched.deadline;
        // 告知文から受付期間を読み取れた場合だけ「確認済み」とする。
        // 店の商品一覧の日付は受付期間とは限らないため信用しない。
        if (sched.startsAt || sched.deadline) item.applyVerified = true;
      } else if (verbose) {
        console.warn(`[enrich] 本文領域を特定できず締切抽出をスキップ: ${item.url}`);
      }
    } catch {
      /* noop */
    }

    if (!item.tier) item.tier = item.destUrl ? 'shop' : 'news';
  });

  try {
    await runPool(tasks, concurrency);
  } catch {
    /* 絶対に throw しない */
  }

  return items;
}
