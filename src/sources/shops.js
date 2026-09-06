/**
 * src/sources/shops.js — 区画I: 小売店の抽選・予約ページ直接監視
 *
 * 目的は「抽選予約に最短で飛んで締切に間に合うこと」。
 * これまで見ていたのはニュース記事とメーカー公式だけで、実際に抽選を開催している
 * 小売店（楽天ブックス・カードラボ等）のページを一切見ていなかった。
 * このモジュールはそこを埋める。小売店由来なので destUrl / destLabel を最初から埋められる。
 *
 * npm依存なし。Node標準の fetch / node:crypto と、区画Fの official.js の純関数だけを使う。
 * 取得ロジック（URL・正規表現）は全て config/shop-sources.json に外出ししてある。
 *
 * 【bot対策の回避は一切しない】
 *   UAは常に TCGNewsBot 固定。403 / JSチャレンジ / 無応答に当たったサイトは
 *   config 側で enabled:false にして理由を note に書き、それ以上追わない。
 *   robots.txt で Disallow されているパスは config に入れない（調査時に全件確認済み）。
 */

import { createHash } from 'node:crypto';
import {
  USER_AGENT,
  cleanTitle,
  absolutizeUrl,
  normalizeForMatch,
  toRegExp,
  parseNewsList,
  pickPath,
  extractDate,
  fetchText,
  runPool,
  hasLotteryIntent,
  LOTTERY_HINTS,
  LOTTERY_IP,
} from './official.js';
import { canonicalizeUrl } from '../resolve.js';
import { parseFeed } from '../rss.js';

export { USER_AGENT, LOTTERY_HINTS, LOTTERY_IP };

export const DEFAULT_TIMEOUT_MS = 20000;
/** 小売店は一次情報に近いので高め（メーカー公式の1.4より少し下） */
export const DEFAULT_WEIGHT = 1.35;
export const DEFAULT_MAX_ITEMS = 40;

/** 相手サーバに負荷をかけないための上限（設定で増やされても超えない） */
export const HARD_CONCURRENCY_LIMIT = 3;
export const HARD_RETRY_LIMIT = 1;
/** 同一ワーカー内で連続リクエストする際の最低待ち時間 */
export const DEFAULT_DELAY_MS = 800;

/* ------------------------------------------------------------------ */
/* 小物                                                                */
/* ------------------------------------------------------------------ */

/**
 * 安定ID: sha1(正規化タイトル + '|' + url).slice(0,16)
 * official.js の makeItemId と同じ方式（他情報源と重複判定できるように）。
 * @param {string} title
 * @param {string} url
 * @returns {string}
 */
export function makeItemId(title, url) {
  return createHash('sha1')
    .update(`${normalizeForMatch(title)}|${String(url || '')}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * url 中の `{env:NAME}` を環境変数で置換する。
 * 未設定の変数が1つでもあれば null を返す（＝そのサイトはスキップ）。
 * APIキーが要るサイトを、キー無しの環境でも壊さずに config に置いておくため。
 *
 * @param {string} url
 * @param {Record<string,string|undefined>} [env]
 * @returns {{url:string|null, missing:string[]}}
 */
export function resolveUrlTemplate(url, env = process.env) {
  const raw = String(url == null ? '' : url);
  const missing = [];
  const out = raw.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
    const v = env && env[name];
    if (v === undefined || v === null || v === '') {
      missing.push(name);
      return '';
    }
    return encodeURIComponent(String(v));
  });
  return { url: missing.length > 0 ? null : out, missing };
}

/**
 * ISO8601 / Date が解釈できる文字列を ISO文字列にする。
 * @param {string|number|Date} value
 * @returns {string} 不正なら空文字
 */
export function toIsoDate(value) {
  if (value === undefined || value === null || value === '') return '';
  const d = value instanceof Date ? value : new Date(value);
  const t = d.getTime();
  if (!Number.isFinite(t)) return '';
  return d.toISOString();
}

/* ------------------------------------------------------------------ */
/* パース（純関数・テストの主対象）                                    */
/* ------------------------------------------------------------------ */

/**
 * 小売店の商品一覧HTMLから商品の配列を取り出す。ネットワークには出ない。
 *
 * 区画Fの parseNewsList と同じ考え方・同じ設定キーを使う（official.js は書き換えない）。
 * 日付を持たない一覧ページが大半なので、その場合 pubDate は空文字のままになり、
 * 呼び出し側（fetchShopItems）が現在時刻を入れる。
 *
 * @param {string} html
 * @param {Object} siteConfig config/shop-sources.json の sites[] の1要素
 * @returns {Array<{title:string, link:string, pubDate:string}>}
 */
export function parseShopList(html, siteConfig) {
  const site = siteConfig || {};
  if (!site.itemPattern) return [];
  const maxItems = Number(site.maxItemsPerSite) > 0 ? Number(site.maxItemsPerSite) : DEFAULT_MAX_ITEMS;
  return parseNewsList(html, { ...site, maxItemsPerSite: maxItems });
}

/**
 * 小売店のJSON APIのレスポンスを商品配列にする。純関数。
 *
 * official.js の parseJsonList は path + linkTemplate 前提だが、
 * 楽天のように商品URLがフルで入っている API もあるので、
 * 「linkTemplate があれば差し込み、無ければそのまま絶対化」という形にしてある。
 * dateFormat:'iso' なら Date でそのまま解釈（UTC混じりでも正しく扱える）。
 *
 * @param {any} json
 * @param {Object} siteConfig
 * @returns {Array<{title:string, link:string, pubDate:string}>}
 */
export function parseShopJson(json, siteConfig) {
  const site = siteConfig || {};
  const list = pickPath(json, site.listKey || 'items');
  if (!Array.isArray(list)) return [];

  const base = site.baseUrl || site.url || '';
  const titleKey = site.titleKey || 'title';
  const pathKey = site.pathKey || 'url';
  const dateKey = site.dateKey || '';
  const dateFormat = String(site.dateFormat || '').toLowerCase();
  const template = site.linkTemplate || '';
  const titleFilter = toRegExp(site.titleFilter);
  const titleExclude = toRegExp(site.titleExclude);
  const dateRe = toRegExp(site.datePattern);
  const maxItems = Number(site.maxItemsPerSite) > 0 ? Number(site.maxItemsPerSite) : DEFAULT_MAX_ITEMS;

  /** @type {Array<{title:string, link:string, pubDate:string}>} */
  const out = [];
  const seen = new Set();

  for (const row of list) {
    if (!row || typeof row !== 'object') continue;

    const title = cleanTitle(row[titleKey]);
    const path = String(row[pathKey] == null ? '' : row[pathKey]).trim();
    if (!title || !path) continue;
    if (titleFilter && !titleFilter.test(title)) continue;
    if (titleExclude && titleExclude.test(title)) continue;

    const link = absolutizeUrl(template ? template.replace('{path}', path) : path, base);
    if (!link) continue;

    const key = `${normalizeForMatch(title)}|${canonicalizeUrl(link)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    let pubDate = '';
    if (dateKey) {
      const rawDate = row[dateKey];
      pubDate = dateFormat === 'iso' ? toIsoDate(rawDate) : extractDate(String(rawDate == null ? '' : rawDate), dateRe);
    }

    // 受付期間。楽天ブックスのAPIは sales_start_time / sales_end_time を返す。
    // 商品ページ自体はbotから取得できないため、締切を得られるのはここだけ。
    const startsAt = site.startsAtKey ? toIsoDate(row[site.startsAtKey]) : '';
    const deadline = site.deadlineKey ? toIsoDate(row[site.deadlineKey]) : '';

    // 発売予定日。「まだ発売されていないが予約受付中」を判別できるようにする。
    // 楽天ブックスAPIは release_date_text（例「2026年12月11日」）を返す。
    // 在庫状態。「ご注文できない商品」「売り切れ」を応募先として出すと、
    // クリックした先で買えず、時間を無駄にさせる。
    if (site.stockTextKey) {
      const stockText = String(row[site.stockTextKey] == null ? '' : row[site.stockTextKey]);
      const stockExclude = toRegExp(site.stockExclude);
      if (stockExclude && stockExclude.test(stockText)) continue;
    }

    const releaseText = site.releaseTextKey
      ? String(row[site.releaseTextKey] == null ? '' : row[site.releaseTextKey]).trim()
      : '';

    out.push({
      title,
      link,
      pubDate,
      startsAt: startsAt || '',
      deadline: deadline || '',
      releaseText,
    });
    if (out.length >= maxItems) break;
  }

  return out;
}

/**
 * RSS/Atom を読んで一覧に変換する。
 * 小売店のお知らせがWordPressのRSSで出ている場合に使う。
 * `src/rss.js` の自前パーサを通すので、英語月名の日付も正しく解釈できる。
 * @param {string} xml
 * @param {Object} siteConfig
 * @returns {Array<{title:string, link:string, pubDate:string, deadline:string}>}
 */
export function parseShopFeed(xml, siteConfig) {
  const site = siteConfig || {};
  const titleFilter = toRegExp(site.titleFilter);
  const titleExclude = toRegExp(site.titleExclude);
  const maxItems = Number(site.maxItemsPerSite) > 0 ? Number(site.maxItemsPerSite) : DEFAULT_MAX_ITEMS;

  let feed;
  try {
    feed = parseFeed(String(xml || ''));
  } catch {
    return [];
  }

  const out = [];
  const seen = new Set();
  for (const item of (feed && feed.items) || []) {
    const title = cleanTitle(item.title);
    const link = absolutizeUrl(String(item.link || ''), site.baseUrl || site.url || '');
    if (!title || !link) continue;
    if (titleFilter && !titleFilter.test(title)) continue;
    if (titleExclude && titleExclude.test(title)) continue;
    const key = `${normalizeForMatch(title)}|${canonicalizeUrl(link)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title, link, pubDate: item.pubDate || '', deadline: '' });
    if (out.length >= maxItems) break;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 取得                                                                */
/* ------------------------------------------------------------------ */

/** 1回だけリトライする（相手サーバに優しく） */
async function withRetry(fn, retry) {
  const attempts = Math.min(Math.max(Number(retry) || 0, 0), HARD_RETRY_LIMIT) + 1;
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i < attempts - 1) await sleep(1000);
    }
  }
  throw lastError;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));

/**
 * サイト1件分の商品を取得する（型ごとの分岐）。
 * @param {Object} site
 * @param {Object} [defaults]
 * @returns {Promise<Array<{title:string, link:string, pubDate:string}>>}
 */
export async function fetchSiteEntries(site, defaults = {}) {
  const timeoutMs =
    Number(site.timeoutMs) > 0 ? Number(site.timeoutMs) : Number(defaults.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const url = site.resolvedUrl || site.url;

  if (site.type === 'json') {
    const text = await fetchText(url, {
      charset: site.charset,
      timeoutMs,
      accept: 'application/json, text/javascript, */*;q=0.8',
    });
    return parseShopJson(JSON.parse(text), site);
  }

  if (site.type === 'rss') {
    // 正規表現でRSSを無理に読むと日付（英語月名のRFC822）を落とす。
    // 既存の自前パーサを使えば正しく解釈できる。
    const xml = await fetchText(url, {
      charset: site.charset,
      timeoutMs,
      accept: 'application/rss+xml, application/xml, text/xml, */*;q=0.8',
    });
    return parseShopFeed(xml, site);
  }

  const html = await fetchText(url, { charset: site.charset, timeoutMs });
  return parseShopList(html, site);
}

/* ------------------------------------------------------------------ */
/* メイン                                                              */
/* ------------------------------------------------------------------ */

/**
 * 小売店の抽選・予約ページ群から RawItem[] を収集する。
 *
 * - enabled:false のサイトはスキップ（bot対策で諦めたサイトはここに入っている）
 * - `{env:NAME}` が解決できないサイトもスキップ（APIキー未設定）
 * - 各サイトの失敗は console.warn してスキップ。全滅でも空配列を返し throw しない
 * - 取得0件でも warn するだけ（サイト構造変更の早期発見のため）
 *
 * 返す RawItem には必ず kind:'shop' / tier:'shop' / destUrl / destLabel が入る。
 * 小売店由来は最初から応募先が分かるので、区画Gの enrich を待たずにここで埋めてしまう。
 *
 * @param {Object} config config/shop-sources.json の中身
 * @param {{now?:Date, maxAgeHours?:number, concurrency?:number, verbose?:boolean, env?:Object}} [opts]
 * @returns {Promise<Array<Object>>} RawItem[]
 */
export async function fetchShopItems(config, opts = {}) {
  const { now = new Date(), maxAgeHours = 168, concurrency = 3, verbose = false, env = process.env } = opts || {};

  const defaults = (config && config.defaults) || {};
  const enabled = ((config && config.sites) || []).filter((s) => s && s.url && s.enabled !== false);

  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const minMs = Number.isFinite(maxAgeHours) && maxAgeHours > 0 ? nowMs - maxAgeHours * 3600 * 1000 : -Infinity;
  const nowIso = new Date(nowMs).toISOString();

  /** {env:NAME} を解決できたサイトだけ残す */
  const sites = [];
  for (const site of enabled) {
    const { url, missing } = resolveUrlTemplate(site.url, env);
    if (!url) {
      console.warn(`[shops] スキップ ${site.id}: 環境変数が未設定 (${missing.join(', ')})`);
      continue;
    }
    sites.push({ ...site, resolvedUrl: url });
  }

  if (sites.length === 0) {
    console.warn('[shops] 有効な小売店サイト設定が0件です');
    return [];
  }

  const width = Math.min(Math.max(Number(concurrency) || 1, 1), HARD_CONCURRENCY_LIMIT);
  const retry = defaults.retry === undefined ? HARD_RETRY_LIMIT : defaults.retry;
  const delayMs = defaults.delayMs === undefined ? DEFAULT_DELAY_MS : Number(defaults.delayMs) || 0;

  const results = await runPool(sites, width, async (site, index) => {
    // 同じワーカーが連続で叩く時に間隔を空ける（相手サーバへの配慮）
    if (index >= width && delayMs > 0) await sleep(delayMs);
    return withRetry(() => fetchSiteEntries(site, defaults), retry);
  });

  /** @type {Array<Object>} */
  const items = [];
  const seenIds = new Set();
  /** @type {Record<string, number>} サイトごとの採用件数（verboseと報告用） */
  const counts = {};

  for (let i = 0; i < sites.length; i += 1) {
    const site = sites[i];
    const r = results[i];
    counts[site.id] = 0;

    if (!r || !r.ok) {
      console.warn(`[shops] 取得失敗 ${site.id} (${site.resolvedUrl}): ${r?.error?.message || r?.error}`);
      continue;
    }

    const entries = Array.isArray(r.value) ? r.value : [];
    if (entries.length === 0) {
      // 対象商品が無い日が普通にあるサイト（抽選一覧など）は警告しない。
      // 毎日warnが出ると、本物の構造変更を見逃すようになる。
      if (site.expectEmpty) {
        if (verbose) console.log(`[shops] ${site.id}: 対象0件（このサイトでは正常）`);
      } else {
        console.warn(`[shops] 取得0件 ${site.id} (${site.resolvedUrl}) — サイト構造が変わった可能性`);
      }
      continue;
    }

    const weight = typeof site.weight === 'number' ? site.weight : Number(defaults.weight) || DEFAULT_WEIGHT;
    const baseIps = Array.isArray(site.ips) ? site.ips.filter(Boolean) : [];
    const destLabel = site.destLabel || site.name || site.id;
    let accepted = 0;

    for (const entry of entries) {
      const title = String(entry.title || '').trim();
      const rawUrl = String(entry.link || '').trim();
      if (!title || !rawUrl) continue;

      const publishedAt = entry.pubDate || nowIso;
      const t = new Date(publishedAt).getTime();
      // 日付が取れているサイトだけ鮮度で足切りする（取れないサイトは常に通す）
      if (entry.pubDate && Number.isFinite(t) && t < minMs) continue;

      const url = canonicalizeUrl(rawUrl);

      // 設定に ips があればそれ。無ければ空配列のまま（親の collect.js がタイトルから判定する）
      const ips = baseIps.slice();
      if (hasLotteryIntent(title) && !ips.includes(LOTTERY_IP)) ips.push(LOTTERY_IP);

      const id = makeItemId(title, url);
      if (seenIds.has(id)) continue; // 楽天のジャンル横断feedと個別IP feedの重複を落とす
      seenIds.add(id);

      items.push({
        id,
        title,
        url,
        sourceName: site.name || site.id,
        sourceId: site.id,
        sourceWeight: weight,
        // 発売日が分かるものは要約に出す（「予約はできるが発売はまだ先」が一目で分かる）
        summary: entry.releaseText ? `発売予定 ${entry.releaseText}` : '',
        publishedAt: Number.isFinite(t) ? new Date(t).toISOString() : nowIso,
        ips,
        feedUrl: site.resolvedUrl,
        // 第2フェーズの拡張フィールド
        kind: 'shop',
        tier: 'shop',
        // 小売店由来なので応募先は最初から分かっている
        destUrl: url,
        // 項目ごとに応募先が違うサイト（まとめサイト等）は、その店名を優先する。
        // サイト名を出すと『まとめサイトで確認』と表示しながら別の店へ飛ばすことになる。
        destLabel: entry.destLabel || destLabel,
        startsAt: entry.startsAt || null,
        deadline: entry.deadline || null,
        // 店の商品一覧から作った項目は、受付中かどうかを確認できていない。
        // 一覧に載っていても、抽選エントリーが既に締め切られていることがある。
        // 「応募できる」と断定せず、確認を促す表示にするための印。
        applyVerified: site.applyVerified === true,
      });
      accepted += 1;
    }

    counts[site.id] = accepted;
    if (verbose) {
      console.log(`[shops] ${site.id}: 抽出${entries.length}件 / 採用${accepted}件`);
    }
    if (accepted === 0) {
      if (site.dateKey) {
        // 日付を持つサイトは「今週は新着が無かった」だけなので異常ではない
        if (verbose) console.log(`[shops] ${site.id}: ${maxAgeHours}時間以内の新着なし（抽出は${entries.length}件）`);
      } else {
        console.warn(`[shops] ${site.id}: 採用0件（抽出は${entries.length}件・フィルタ/重複で全て落ちた）`);
      }
    }
  }

  if (verbose) {
    console.log(`[shops] 合計 ${items.length}件 / 有効サイト ${sites.length}件`);
    console.log(`[shops] 内訳 ${JSON.stringify(counts)}`);
  }
  return items;
}
