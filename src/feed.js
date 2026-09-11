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
import { normalizePrefecture } from './prefecture.js';

/** feed.json のスキーマバージョン */
export const FEED_VERSION = 1;

/** summary の最大文字数 */
export const SUMMARY_MAX = 200;

/**
 * 「今日締切」とみなす時間。
 * この時間内に締切を迎える受付中の案件は、他の何よりも優先して枠を確保する。
 * ここを削ると「間に合わせる」というアプリの目的そのものが崩れる。
 */
export const URGENT_KEEP_HOURS = 24;

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
    // false のとき publishedAt は「取得した時刻」であって掲載日ではない。
    // 情報源が日付を持たないカタログ型の一覧が該当する。
    // これを無視すると、7月に終わった抽選を「新着9分前」と出してしまう。
    publishedAtKnown: it.publishedAtKnown !== false,
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
    // 遠方の実店舗を勧めないための判別材料
    // prefecture: '全国'（場所を問わない＝通販）または '東京都' 等の正式名。
    //   情報源はローマ字（'tokyo' / 'all'）で持っているが、ここで正式名に揃える。
    //   アプリ側は正式名で突き合わせるので、変換を忘れると所在地が全部「不明」になる。
    // deliveryType: 'store'（店頭受取）/ 'online' / 'all'
    prefecture: normalizePrefecture(it.prefecture),
    deliveryType: typeof it.deliveryType === 'string' ? it.deliveryType : '',
    // 同じ商品を扱う他の店（抽選は多くの店に応募するほど当たる）
    otherShops: Array.isArray(it.otherShops)
      ? it.otherShops
          .filter((o) => o && typeof o.label === 'string' && isHttpUrl(o.url))
          .map((o) => ({ label: o.label, url: o.url }))
          .slice(0, 12)
      : [],
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
 * 選ぶ順番（先に入れたものが必ず残る）:
 *   0. 24時間以内に締切を迎える受付中の案件 … このアプリの存在意義。無条件で確保
 *   1. 各ジャンル1件 … ジャンルが丸ごと消えるのを防ぐ。可能なら締切付きの案件を充てる
 *   2. 残りの受付中案件（締切が近い順）
 *   3. 各ジャンル minPerIp 件まで
 *   4. 残り枠を全体の新しい順で
 * 1件確保に使う枠は最大でもジャンル数（17）なので、締切案件の枠を大きく削らない。
 *
 * @param {Array<object>} all       publishedAt 降順に並んだ全件
 * @param {Array<object>} base      単純に上位を切ったもの（最低限これを尊重する）
 * @param {{maxItems:number, minPerIp:number, mustKeep?:Array<object>, perSourceCap?:number, now?:Date|number}} opts
 * @returns {Array<object>} publishedAt 降順
 */
/**
 * 同じ商品を1件にまとめる。
 * 抽選は「多くの店に応募するほど当たる」ので他店の情報も価値があるが、
 * 一覧に同じ商品名が並ぶと読めなくなる。
 * 代表を1件だけ残し、他店は otherShops として持たせる。
 *
 * 代表の選び方: 締切が近いもの → 締切が明示されているもの → 新しいもの
 *
 * @param {Array<object>} items publishedAt 降順に並んだ一覧
 * @returns {Array<object>}
 */
export function mergeSameProduct(items) {
  const list = Array.isArray(items) ? items : [];
  const keyOf = (it) =>
    String(it.title || '')
      .normalize('NFKC')
      .replace(/[\s\p{P}\p{S}]/gu, '')
      .toLowerCase();

  const groups = new Map();
  for (const it of list) {
    const k = keyOf(it);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }

  const out = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      out.push(group[0]);
      continue;
    }
    // 締切が近い順 → 締切がある順 → 新しい順
    const sorted = group.slice().sort((a, b) => {
      const da = Date.parse(a.deadline);
      const db = Date.parse(b.deadline);
      const va = Number.isFinite(da) ? da : Infinity;
      const vb = Number.isFinite(db) ? db : Infinity;
      if (va !== vb) return va - vb;
      return (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0);
    });
    const rep = sorted[0];
    const others = sorted.slice(1);
    out.push({
      ...rep,
      // 他にも応募できる店があることを示す（アプリ側で「他N店」と出せる）
      otherShops: others
        .map((o) => ({ label: o.destLabel || o.sourceName || '', url: o.destUrl || o.url || '' }))
        .filter((o) => o.label && /^https?:\/\//i.test(o.url))
        .slice(0, 12),
    });
  }

  // publishedAt 降順に戻す
  return out.sort((a, b) => {
    const ta = Date.parse(a.publishedAt);
    const tb = Date.parse(b.publishedAt);
    const va = Number.isFinite(ta) ? ta : -Infinity;
    const vb = Number.isFinite(tb) ? tb : -Infinity;
    if (vb !== va) return vb - va;
    return (b.score || 0) - (a.score || 0);
  });
}

export function ensureIpCoverage(all, base, {
  maxItems = 50,
  minPerIp = 4,
  mustKeep = [],
  perSourceCap = 0,
  now = Date.now(),
} = {}) {
  const list = Array.isArray(all) ? all : [];
  const cap = Math.max(0, maxItems);
  if (list.length <= cap) return list.slice();

  const nowMs = now instanceof Date ? now.getTime() : Number(now) || Date.now();
  const picked = new Map();

  // 1つの情報源が枠を占領しないための実測カウンタ。
  // ただし「今日締切」と「ジャンル1件確保」だけは、この上限より優先する
  // （その情報源にしか無いジャンルを、上限のせいで丸ごと落とさないため）。
  const limit = perSourceCap > 0 ? perSourceCap : Infinity;
  const usedBySource = new Map();
  const sourceOf = (it) => (it && typeof it.sourceName === 'string' ? it.sourceName : '');
  const sourceIsFull = (it) => (usedBySource.get(sourceOf(it)) || 0) >= limit;

  /**
   * @param {object} it
   * @param {{ignoreSourceCap?:boolean}} [o]
   * @returns {boolean} 実際に追加したら true
   */
  const add = (it, o = {}) => {
    if (!it || picked.has(it.id)) return false;
    if (picked.size >= cap) return false;
    if (!o.ignoreSourceCap && sourceIsFull(it)) return false;
    picked.set(it.id, it);
    const key = sourceOf(it);
    usedBySource.set(key, (usedBySource.get(key) || 0) + 1);
    return true;
  };

  const ipsOf = (it) => (Array.isArray(it?.ips) ? it.ips : []).filter((ip) => ip !== 'lottery');

  // 受付中の案件（締切が近い順）
  const keep = (Array.isArray(mustKeep) ? mustKeep : [])
    .slice()
    .sort((a, b) => (Date.parse(a.deadline) || 0) - (Date.parse(b.deadline) || 0));

  // 0) 24時間以内が締切のものは無条件で確保する。
  //    「間に合わせること」が目的なので、ここだけは他の都合より優先する。
  const urgentUntil = nowMs + URGENT_KEEP_HOURS * 3600 * 1000;
  for (const it of keep) {
    const dl = Date.parse(it && it.deadline);
    if (!Number.isFinite(dl) || dl > urgentUntil) continue;
    add(it, { ignoreSourceCap: true });
  }

  if (minPerIp <= 0) {
    for (const it of keep) add(it);
    for (const it of list) {
      if (picked.size >= cap) break;
      add(it);
    }
    if (picked.size < cap) for (const it of list) { if (picked.size >= cap) break; add(it, { ignoreSourceCap: true }); }
    return sortByPublished([...picked.values()].slice(0, cap));
  }

  // 1) 各ジャンル最低1件。ジャンルが丸ごと消えると「壊れている」ように見える。
  //    代表は「締切がある受付中のもの」を優先し、無ければそのジャンルの最新記事。
  const rep = new Map();
  for (const it of picked.values()) {
    for (const ip of ipsOf(it)) if (!rep.has(ip)) rep.set(ip, it);
  }
  for (const source of [keep, list]) {
    for (const it of source) {
      for (const ip of ipsOf(it)) if (!rep.has(ip)) rep.set(ip, it);
    }
  }
  for (const it of rep.values()) add(it, { ignoreSourceCap: true });

  // 2) 残りの受付中案件（締切が近い順）
  for (const it of keep) {
    if (picked.size >= cap) break;
    add(it);
  }

  // 3) 各ジャンル minPerIp 件まで
  const perIp = new Map();
  for (const it of picked.values()) {
    for (const ip of ipsOf(it)) perIp.set(ip, (perIp.get(ip) || 0) + 1);
  }
  for (const it of list) {
    if (picked.size >= cap) break;
    if (!ipsOf(it).some((ip) => (perIp.get(ip) || 0) < minPerIp)) continue;
    if (add(it)) {
      for (const ip of ipsOf(it)) perIp.set(ip, (perIp.get(ip) || 0) + 1);
    }
  }

  // 4) 残り枠を全体の新しい順で埋める
  for (const it of list) {
    if (picked.size >= cap) break;
    add(it);
  }

  // 5) 情報源の上限で埋めきれなかった分は、上限を外して補う。
  //    件数が減るくらいなら同じ情報源から足すほうがましなので、最後の手段として。
  if (picked.size < cap) {
    for (const it of list) {
      if (picked.size >= cap) break;
      add(it, { ignoreSourceCap: true });
    }
  }

  // 6) 確保のために入れた古い記事があるので、最後に必ず新しい順へ戻す
  return sortByPublished([...picked.values()].slice(0, cap));
}

/** publishedAt 降順（同着は score 降順） */
function sortByPublished(items) {
  return items.sort((a, b) => {
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
  // 同じ商品が複数の店に出ている場合は先に1件へ集約する。
  // これを後回しにすると、受付中の抽選を優先確保する処理が
  // 重複したまま枠を埋めてしまう。
  const merged = mergeSameProduct(allItems);
  const items = merged.slice(0, Math.max(0, maxItems));

  // 最新順に切るだけだと、記事数の多いIP（ポケカ・ワンピ）が枠を埋めてしまい、
  // 記事数の少ないIP（ドラゴンボール等）がアプリから消える。
  // 「自分の好きなTCGの情報が無い」状態を防ぐため、各IPに最低枠を確保する。
  // 締切があって、まだ受付中のものは必ず残す。
  // 「最新順に50件」で切ると、今日締切の抽選が新着記事に押し出されて消える。
  // このアプリの目的は「間に合わせること」なので、そこを最優先で確保する。
  const nowMs = now instanceof Date ? now.getTime() : Date.now();
  // ただし1つの情報源だけで枠を埋めない。
  // まとめサイトは同じ商品の別店舗が何十件も並ぶので、
  // 無制限に通すと他ジャンル（遊戯王・デュエマ等）が全部消える。
  const perSourceCap = Math.max(1, Math.floor(maxItems * 0.4));
  const bySource = new Map();
  const openNow = merged
    .filter((it) => {
      const dl = Date.parse(it.deadline);
      return Number.isFinite(dl) && dl > nowMs && it.destUrl;
    })
    .sort((a, b) => (Date.parse(a.deadline) || 0) - (Date.parse(b.deadline) || 0))
    .filter((it) => {
      const key = it.sourceName || '';
      const n = bySource.get(key) || 0;
      if (n >= perSourceCap) return false;
      bySource.set(key, n + 1);
      return true;
    });
  const selected = ensureIpCoverage(merged, items, {
    maxItems,
    minPerIp,
    mustKeep: openNow,
    perSourceCap,
    now: nowMs,
  });

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
