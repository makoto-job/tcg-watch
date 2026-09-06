/**
 * 区画D: フィードAPI出力（public/feed.json）
 *
 * モバイルアプリ（PWA）はこのJSONだけを読む。
 * スキーマは CONTRACT.md の `FeedItem` / feed.json を厳守すること。
 *
 * npm依存ゼロ / Node標準のみ。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveFromRoot } from './config.js';

/** feed.json のスキーマバージョン */
export const FEED_VERSION = 1;

/** summary の最大文字数 */
export const SUMMARY_MAX = 200;

/**
 * 情報の出所種別を判定する。
 *  - sourceId が `x-` で始まる                       -> 'x'
 *  - sourceName に「公式」を含む / sourceId が `official-` で始まる -> 'official'
 *  - それ以外                                        -> 'news'
 * @param {{sourceId?:string, sourceName?:string}} item
 * @returns {'news'|'official'|'x'}
 */
export function detectKind(item) {
  const sourceId = typeof item?.sourceId === 'string' ? item.sourceId : '';
  const sourceName = typeof item?.sourceName === 'string' ? item.sourceName : '';

  if (sourceId.startsWith('x-')) return 'x';
  if (sourceName.includes('公式') || sourceId.startsWith('official-')) return 'official';
  return 'news';
}

/**
 * 文字列を最大長で切る（超過時は末尾を「…」に）。
 * @param {unknown} text
 * @param {number} [max=SUMMARY_MAX]
 * @returns {string}
 */
export function truncate(text, max = SUMMARY_MAX) {
  const s = typeof text === 'string' ? text : '';
  const chars = Array.from(s); // サロゲートペアを壊さない
  if (chars.length <= max) return s;
  return chars.slice(0, max - 1).join('') + '…';
}

/**
 * ISO8601 に正規化する。パースできなければ空文字。
 * @param {unknown} value
 * @returns {string}
 */
function toIso(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  if (typeof value !== 'string' || value === '') return '';
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : '';
}

/**
 * RankedItem を FeedItem に変換する。
 * @param {any} rankedItem RankedItem（RawItem の全プロパティ + score など）
 * @param {{isRanked?:boolean, rank?:number|null}} [opts]
 * @returns {import('./feed.js').FeedItem}
 */
export function toFeedItem(rankedItem, opts = {}) {
  const { isRanked = false, rank = null } = opts;
  const it = rankedItem || {};

  return {
    id: typeof it.id === 'string' ? it.id : '',
    title: typeof it.title === 'string' ? it.title : '',
    url: typeof it.url === 'string' ? it.url : '',
    sourceName: typeof it.sourceName === 'string' ? it.sourceName : '',
    publishedAt: toIso(it.publishedAt),
    summary: truncate(it.summary, SUMMARY_MAX),
    ips: Array.isArray(it.ips) ? it.ips.filter((v) => typeof v === 'string') : [],
    intentTags: Array.isArray(it.intentTags) ? it.intentTags.filter((v) => typeof v === 'string') : [],
    score: Number.isFinite(it.score) ? it.score : 0,
    // OGP画像の取得は現時点では行わない（将来拡張のためフィールドだけ用意）
    thumbnail: typeof it.thumbnail === 'string' && it.thumbnail !== '' ? it.thumbnail : null,
    isRanked: Boolean(isRanked),
    rank: isRanked && Number.isFinite(rank) ? rank : null,
    kind: detectKind(it),
    // 第2フェーズ: 応募導線。区画Gの enrichItems が埋める。無ければ null
    tier: it.tier === 'official' || it.tier === 'shop' || it.tier === 'news' ? it.tier : detectKind(it),
    destUrl: isHttpUrl(it.destUrl) ? it.destUrl : null,
    destLabel: typeof it.destLabel === 'string' && it.destLabel !== '' ? it.destLabel : null,
    startsAt: toIso(it.startsAt) || null,
    deadline: toIso(it.deadline) || null,
    // 受付中だと確認できているか（店の一覧由来は false）
    applyVerified: it.applyVerified === true,
    // 商品ページではなく店の入口ページか（bot拒否等で商品ページを取得できない場合）
    destIsEntry: it.destIsEntry === true,
  };
}

/** http(s) のURLかどうか。javascript: 等をフィードに載せないための防御 */
export function isHttpUrl(v) {
  return typeof v === 'string' && /^https?:\/\//i.test(v);
}

/**
 * 各IPに最低枠を確保したうえで、最新順の一覧を組み立てる。
 *
 * 最新順に上位N件で切るだけだと、記事数の多いIP（ポケカ・ワンピ）が枠を占有し、
 * 記事数の少ないIP（ドラゴンボール等）がアプリから丸ごと消えてしまう。
 * 利用者から見ると「自分の推しの情報が無いアプリ」になるため、
 * まず各IPの最新 minPerIp 件を確保し、残り枠を全体の新しい順で埋める。
 *
 * @param {Array<object>} all       publishedAt 降順に並んだ全件
 * @param {Array<object>} base      単純に上位を切ったもの（最低限これを尊重する）
 * @param {{maxItems:number, minPerIp:number}} opts
 * @returns {Array<object>} publishedAt 降順
 */
export function ensureIpCoverage(all, base, { maxItems = 50, minPerIp = 4 } = {}) {
  const list = Array.isArray(all) ? all : [];
  const cap = Math.max(0, maxItems);
  if (list.length <= cap) return list.slice();
  if (minPerIp <= 0) return list.slice(0, cap);

  const picked = new Map();
  const add = (it) => {
    if (it && !picked.has(it.id)) picked.set(it.id, it);
  };

  // 1) 各IPの最新 minPerIp 件を確保する（lottery は横断タグなので対象外）
  const perIp = new Map();
  for (const it of list) {
    for (const ip of Array.isArray(it.ips) ? it.ips : []) {
      if (ip === 'lottery') continue;
      const n = perIp.get(ip) || 0;
      if (n >= minPerIp) continue;
      perIp.set(ip, n + 1);
      add(it);
    }
    if (picked.size >= cap) break;
  }

  // 2) 残り枠を全体の新しい順で埋める
  for (const it of list) {
    if (picked.size >= cap) break;
    add(it);
  }

  // 3) 確保のために入れた古い記事があるので、最後に必ず新しい順へ戻す
  return [...picked.values()]
    .slice(0, cap)
    .sort((a, b) => {
      const ta = Date.parse(a.publishedAt);
      const tb = Date.parse(b.publishedAt);
      const va = Number.isFinite(ta) ? ta : -Infinity;
      const vb = Number.isFinite(tb) ? tb : -Infinity;
      if (vb !== va) return vb - va;
      return (b.score || 0) - (a.score || 0);
    });
}

/**
 * 指定タイムゾーンでの YYYY-MM-DD。
 * @param {Date} date
 * @param {string} [tz='Asia/Tokyo']
 * @returns {string}
 */
export function localDateString(date, tz = 'Asia/Tokyo') {
  try {
    // 'sv-SE' ロケールは YYYY-MM-DD 形式
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/**
 * feed.json のオブジェクトを組み立てる。
 *
 * @param {{
 *   ranked: any[],
 *   top?: any[],
 *   tweetUrl?: string|null,
 *   now?: Date,
 *   maxItems?: number,
 *   tz?: string
 * }} params
 * @returns {{version:number, generatedAt:string, ranking:{date:string, tweetUrl:string|null, top:any[]}, items:any[]}}
 */
export function buildFeedJson({ ranked = [], top = [], tweetUrl = null, now = new Date(), maxItems = 50, minPerIp = 4, tz = 'Asia/Tokyo' } = {}) {
  const nowDate = now instanceof Date ? now : new Date(now);

  // TOP N のランク表（id 優先、無ければ URL で突き合わせ）
  /** @type {Map<string, number>} */
  const rankById = new Map();
  /** @type {Map<string, number>} */
  const rankByUrl = new Map();
  const topList = Array.isArray(top) ? top : [];
  topList.forEach((it, i) => {
    const rank = i + 1;
    if (it && typeof it.id === 'string' && it.id !== '') rankById.set(it.id, rank);
    if (it && typeof it.url === 'string' && it.url !== '') rankByUrl.set(it.url, rank);
  });

  /**
   * そのアイテムのランク（TOP外なら null）
   * @param {any} it
   * @returns {number|null}
   */
  const rankOf = (it) => {
    if (it && typeof it.id === 'string' && rankById.has(it.id)) return rankById.get(it.id);
    if (it && typeof it.url === 'string' && rankByUrl.has(it.url)) return rankByUrl.get(it.url);
    return null;
  };

  // items: publishedAt 降順（最新が先頭）。同着は score 降順。
  const allItems = (Array.isArray(ranked) ? ranked : [])
    .map((it) => {
      const rank = rankOf(it);
      return toFeedItem(it, { isRanked: rank !== null, rank });
    })
    .sort((a, b) => {
      const ta = Date.parse(a.publishedAt);
      const tb = Date.parse(b.publishedAt);
      const va = Number.isFinite(ta) ? ta : -Infinity;
      const vb = Number.isFinite(tb) ? tb : -Infinity;
      if (vb !== va) return vb - va;
      return (b.score || 0) - (a.score || 0);
    });
  const items = allItems.slice(0, Math.max(0, maxItems));

  // 最新順に切るだけだと、記事数の多いIP（ポケカ・ワンピ）が枠を埋めてしまい、
  // 記事数の少ないIP（ドラゴンボール等）がアプリから消える。
  // 「自分の好きなTCGの情報が無い」状態を防ぐため、各IPに最低枠を確保する。
  const selected = ensureIpCoverage(allItems, items, { maxItems, minPerIp });

  // ranking.top: rank 昇順
  const rankingTop = topList
    .map((it, i) => toFeedItem(it, { isRanked: true, rank: i + 1 }))
    .sort((a, b) => (a.rank || 0) - (b.rank || 0));

  return {
    version: FEED_VERSION,
    generatedAt: nowDate.toISOString(),
    ranking: {
      date: localDateString(nowDate, tz),
      tweetUrl: typeof tweetUrl === 'string' && tweetUrl !== '' ? tweetUrl : null,
      top: rankingTop,
    },
    items: selected,
  };
}

/**
 * feed.json を書き出す（ディレクトリが無ければ作成）。
 * @param {object} feedObj
 * @param {string} [filePath='public/feed.json'] 相対パスはプロジェクトルート基準
 * @returns {Promise<{path:string, bytes:number, itemCount:number}>}
 */
export async function writeFeedJson(feedObj, filePath = 'public/feed.json') {
  const target = resolveFromRoot(filePath);
  await mkdir(path.dirname(target), { recursive: true });
  const payload = JSON.stringify(feedObj, null, 2) + '\n';
  await writeFile(target, payload, 'utf8');
  return {
    path: target,
    bytes: Buffer.byteLength(payload, 'utf8'),
    itemCount: Array.isArray(feedObj?.items) ? feedObj.items.length : 0,
  };
}
