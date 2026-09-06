/**
 * src/sources/official.js — 区画F: 公式サイト直接監視スクレイパー
 *
 * 目的は「抽選予約に最短で飛んで締切に間に合うこと」。
 * ニュースメディアが記事にする頃には抽選が始まっているので、公式サイトの
 * ニュース一覧を直接見て数時間〜数日早く気づくのがこのモジュールの存在意義。
 *
 * npm依存なし。Node標準の fetch / node:crypto と、区画Aの src/rss.js だけを使う。
 * 取得ロジック（URL・正規表現）は全て config/official-sites.json に外出ししてある。
 */

import { createHash } from 'node:crypto';
import { fetchFeed, decodeDisplayText, stripTags } from '../rss.js';
import { canonicalizeUrl } from '../resolve.js';

export const USER_AGENT = 'Mozilla/5.0 (compatible; TCGNewsBot/1.0)';
export const DEFAULT_TIMEOUT_MS = 15000;
export const DEFAULT_WEIGHT = 1.4;
export const DEFAULT_MAX_ITEMS = 40;

/** 相手サーバに負荷をかけないための上限（設定で増やされても超えない） */
export const HARD_CONCURRENCY_LIMIT = 4;
export const HARD_RETRY_LIMIT = 1;

/** 抽選系の横断タグ。src/collect.js の LOTTERY_HINTS と同じ語を使う */
export const LOTTERY_HINTS = ['抽選', '予約', '受注', '再販', '応募', '当選'];
export const LOTTERY_IP = 'lottery';

/** 日本のサイトの日付は JST として解釈する */
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* 小物ユーティリティ                                                  */
/* ------------------------------------------------------------------ */

/**
 * 比較用の正規化。src/collect.js の normalizeForMatch と同じ実装。
 * （区画Dのファイルを import して結合を強めたくないので同じロジックを持つ）
 * @param {string} s
 * @returns {string}
 */
export function normalizeForMatch(s) {
  return String(s == null ? '' : s)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, '')
    .replace(/[\s　]+/g, '');
}

/**
 * 安定ID: sha1(正規化タイトル + '|' + url).slice(0,16)
 * src/collect.js の makeItemId と同じ方式（他情報源と重複判定できるように）。
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
 * 設定の文字列を正規表現にする。壊れたパターンは null（呼び出し側でスキップ）。
 * @param {string|RegExp|undefined|null} pattern
 * @param {string} flags
 * @returns {RegExp|null}
 */
export function toRegExp(pattern, flags = '') {
  if (!pattern) return null;
  if (pattern instanceof RegExp) {
    return new RegExp(pattern.source, flags || pattern.flags);
  }
  try {
    return new RegExp(String(pattern), flags);
  } catch {
    return null;
  }
}

/**
 * タグ除去 → エンティティ復号 → 空白畳み。
 * @param {string} raw
 * @returns {string}
 */
export function cleanTitle(raw) {
  const once = stripTags(String(raw == null ? '' : raw));
  const decoded = decodeDisplayText(once);
  // 復号で現れたタグをもう一度剥がす（&lt;br&gt; のような二重エスケープ対策）
  const twice = decoded === once ? decoded : stripTags(decoded);
  return twice.replace(/[\s　]+/g, ' ').trim();
}

/**
 * 相対URLを絶対URLに解決する。解決できなければ空文字。
 * @param {string} href
 * @param {string} base
 * @returns {string}
 */
export function absolutizeUrl(href, base) {
  const raw = String(href == null ? '' : href).trim();
  if (!raw) return '';
  if (/^(?:javascript|mailto|tel):/i.test(raw)) return '';
  if (raw.startsWith('#')) return '';
  try {
    const u = base ? new URL(raw, base) : new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.toString();
  } catch {
    return '';
  }
}

/**
 * y/m/d(+h/m) を JST として ISO8601 にする。
 * @param {Array<string|number|undefined>} parts [年, 月, 日, 時?, 分?]
 * @returns {string} 不正なら空文字
 */
export function partsToIso(parts) {
  const [y, mo, d, h, mi] = parts || [];
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return '';
  if (year < 1990 || year > 2100) return '';
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  const hour = Number.isFinite(Number(h)) && h !== undefined ? Number(h) : 0;
  const minute = Number.isFinite(Number(mi)) && mi !== undefined ? Number(mi) : 0;
  if (hour > 23 || minute > 59) return '';
  const ms = Date.UTC(year, month - 1, day, hour, minute, 0) - JST_OFFSET_MS;
  const dt = new Date(ms);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toISOString();
}

/**
 * 断片から日付を取り出して ISO8601 に。取れなければ空文字。
 * @param {string} fragment
 * @param {RegExp|null} dateRe
 * @returns {string}
 */
export function extractDate(fragment, dateRe) {
  if (!dateRe) return '';
  const m = dateRe.exec(String(fragment == null ? '' : fragment));
  if (!m) return '';
  return partsToIso([m[1], m[2], m[3], m[4], m[5]]);
}

/** ネストしたキー（'data.article_list'）を辿る */
export function pickPath(obj, path) {
  if (!obj || !path) return undefined;
  let cur = obj;
  for (const key of String(path).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

/* ------------------------------------------------------------------ */
/* パース（純関数・テストの主対象）                                    */
/* ------------------------------------------------------------------ */

/**
 * ニュース一覧HTMLから記事の配列を取り出す。ネットワークには出ない。
 *
 * itemPattern はグローバルで走査し、キャプチャグループがあれば group1、
 * 無ければマッチ全体を「1件分の断片」として扱う。
 * 日付が取れなければ pubDate は空文字（呼び出し側が現在時刻を入れる）。
 *
 * @param {string} html
 * @param {Object} siteConfig config/official-sites.json の sites[] の1要素
 * @returns {Array<{title:string, link:string, pubDate:string}>}
 */
export function parseNewsList(html, siteConfig) {
  const site = siteConfig || {};
  const text = String(html == null ? '' : html);
  if (!text) return [];

  const base = site.baseUrl || site.url || '';
  const maxItems = Number(site.maxItemsPerSite) > 0 ? Number(site.maxItemsPerSite) : DEFAULT_MAX_ITEMS;
  const titleFilter = toRegExp(site.titleFilter);
  const titleExclude = toRegExp(site.titleExclude);
  const dateRe = toRegExp(site.datePattern);

  /** @type {Array<{title:string, link:string, pubDate:string}>} */
  const out = [];
  const seen = new Set();

  const deadlineRe = toRegExp(site.deadlinePattern);

  /**
   * 商品一覧に埋め込まれた受付締切を取り出す。
   * プレミアムバンダイは <input ... name="...TimerEnd" value="2026/09/06 23:59:59">
   * の形で正式な締切を持っている。記事本文には締切が書かれていないことが多いので、
   * ここで取れる締切は貴重（「間に合う」ための核心情報）。
   * @param {string} fragment
   * @returns {string} ISO8601。取れなければ空文字
   */
  const pickDeadline = (fragment) => {
    if (!deadlineRe || !fragment) return '';
    deadlineRe.lastIndex = 0;
    const m = deadlineRe.exec(String(fragment));
    if (!m) return '';
    const raw = (m[1] || m[0]).trim();
    // 「2026/09/06 23:59:59」を日本時間として解釈する
    const p = /(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(raw);
    if (!p) return '';
    const [, y, mo, d, hh = '23', mi = '59', ss = '59'] = p;
    const ms = Date.UTC(+y, +mo - 1, +d, +hh - 9, +mi, +ss);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
  };

  const push = (rawTitle, rawLink, pubDate, fragment) => {
    const title = cleanTitle(rawTitle);
    const link = absolutizeUrl(rawLink, base);
    if (!title || !link) return;
    if (titleFilter && !titleFilter.test(title)) return;
    if (titleExclude && titleExclude.test(title)) return;
    const key = `${normalizeForMatch(title)}|${canonicalizeUrl(link)}`;
    if (seen.has(key)) return; // 同じ記事がタブごとに重複出力されるサイト対策
    seen.add(key);
    out.push({ title, link, pubDate: pubDate || '', deadline: pickDeadline(fragment) });
  };

  const itemRe = toRegExp(site.itemPattern, 'g');
  if (!itemRe) return out;

  if (site.type === 'html-grouped') {
    // 日付が見出し側にまとまっているサイト（遊戯王トップの「更新情報」など）
    const entryRe = toRegExp(site.entryPattern, 'g');
    if (!entryRe) return out;
    for (const block of iterateMatches(itemRe, text)) {
      const fragment = block[1] !== undefined ? block[1] : block[0];
      const pubDate = extractDate(block[0], dateRe);
      entryRe.lastIndex = 0;
      for (const entry of iterateMatches(entryRe, fragment)) {
        push(entry[2], entry[1], pubDate, entry[0]);
        if (out.length >= maxItems) return out;
      }
    }
    return out;
  }

  const linkRe = toRegExp(site.linkPattern);
  const titleRe = toRegExp(site.titlePattern);

  for (const m of iterateMatches(itemRe, text)) {
    const fragment = m[1] !== undefined ? m[1] : m[0];
    const linkHit = linkRe ? linkRe.exec(fragment) : null;
    const titleHit = titleRe ? titleRe.exec(fragment) : null;
    push(
      titleHit ? titleHit[1] : '',
      linkHit ? linkHit[1] : '',
      extractDate(fragment, dateRe),
      fragment
    );
    if (out.length >= maxItems) break;
  }

  return out;
}

/** 無限ループしない global 正規表現の走査 */
function* iterateMatches(re, text) {
  re.lastIndex = 0;
  let m;
  let guard = 0;
  while ((m = re.exec(text)) !== null) {
    yield m;
    if (m.index === re.lastIndex) re.lastIndex += 1;
    guard += 1;
    if (guard > 5000) return; // 壊れたパターンで暴走しない保険
  }
}

/**
 * JSON API（バンダイ系の article_list.php）のレスポンスを記事配列にする。純関数。
 * @param {any} json
 * @param {Object} siteConfig
 * @returns {Array<{title:string, link:string, pubDate:string}>}
 */
export function parseJsonList(json, siteConfig) {
  const site = siteConfig || {};
  const list = pickPath(json, site.listKey || 'data.article_list');
  if (!Array.isArray(list)) return [];

  const dateRe = toRegExp(site.datePattern);
  const titleKey = site.titleKey || 'title';
  const dateKey = site.dateKey || 'dspdate';
  const pathKey = site.pathKey || 'path';
  const template = site.linkTemplate || '';
  const base = site.baseUrl || site.url || '';
  const titleFilter = toRegExp(site.titleFilter);
  const maxItems = Number(site.maxItemsPerSite) > 0 ? Number(site.maxItemsPerSite) : DEFAULT_MAX_ITEMS;

  const out = [];
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const title = cleanTitle(row[titleKey]);
    const path = String(row[pathKey] == null ? '' : row[pathKey]).trim();
    if (!title || !path) continue;
    if (titleFilter && !titleFilter.test(title)) continue;
    const rawLink = template ? template.replace('{path}', path) : path;
    const link = absolutizeUrl(rawLink, base);
    if (!link) continue;
    out.push({ title, link, pubDate: extractDate(String(row[dateKey] || ''), dateRe) });
    if (out.length >= maxItems) break;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 取得                                                                */
/* ------------------------------------------------------------------ */

/**
 * charset を見てデコードしながらテキストを取得する。
 * p-bandai は Shift_JIS なので TextDecoder が必要（metaタグは UTF-8 と嘘をつく）。
 * @param {string} url
 * @param {{charset?:string, timeoutMs?:number, accept?:string}} [opts]
 * @returns {Promise<string>}
 */
export async function fetchText(url, opts = {}) {
  const { charset, timeoutMs = DEFAULT_TIMEOUT_MS, accept } = opts || {};
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'user-agent': USER_AGENT,
      accept: accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'ja,en;q=0.8',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const headerCharset = (res.headers.get('content-type') || '').match(/charset=([\w-]+)/i);
  const enc = String(charset || (headerCharset ? headerCharset[1] : '') || 'utf-8').toLowerCase();
  if (enc === 'utf-8' || enc === 'utf8') return res.text();

  const buf = await res.arrayBuffer();
  try {
    return new TextDecoder(enc).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

/** 1回だけリトライする（相手サーバに優しく） */
async function withRetry(fn, retry) {
  const attempts = Math.min(Math.max(Number(retry) || 0, 0), HARD_RETRY_LIMIT) + 1;
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 800));
    }
  }
  throw lastError;
}

/**
 * サイト1件分の記事を取得する（型ごとの分岐）。
 * @param {Object} site
 * @param {Object} defaults
 * @returns {Promise<Array<{title:string, link:string, pubDate:string}>>}
 */
export async function fetchSiteEntries(site, defaults = {}) {
  const timeoutMs = Number(site.timeoutMs) > 0 ? Number(site.timeoutMs) : Number(defaults.timeoutMs) || DEFAULT_TIMEOUT_MS;

  if (site.type === 'rss') {
    const feed = await fetchFeed(site.url, { timeoutMs });
    const base = site.baseUrl || site.url || '';
    const titleFilter = toRegExp(site.titleFilter);
    const out = [];
    for (const entry of (feed && feed.items) || []) {
      const title = cleanTitle(entry.title);
      const link = absolutizeUrl(entry.link, base);
      if (!title || !link) continue;
      if (titleFilter && !titleFilter.test(title)) continue;
      out.push({ title, link, pubDate: entry.pubDate || '' });
    }
    return out;
  }

  if (site.type === 'json') {
    const text = await fetchText(site.url, {
      charset: site.charset,
      timeoutMs,
      accept: 'application/json, text/javascript, */*;q=0.8',
    });
    return parseJsonList(JSON.parse(text), site);
  }

  const html = await fetchText(site.url, { charset: site.charset, timeoutMs });
  return parseNewsList(html, site);
}

/* ------------------------------------------------------------------ */
/* 同時実行プール（自前実装・依存なし）                                */
/* ------------------------------------------------------------------ */

/**
 * 最大 limit 本の並列で items を処理する。worker が throw しても全体は止めない。
 * @template T,R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item:T, index:number)=>Promise<R>} worker
 * @returns {Promise<Array<{ok:boolean, value?:R, error?:any}>>}
 */
export async function runPool(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  const width = Math.max(1, Math.min(Number(limit) || 1, list.length || 1));
  let cursor = 0;

  const runners = Array.from({ length: width }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= list.length) return;
      try {
        results[i] = { ok: true, value: await worker(list[i], i) };
      } catch (error) {
        results[i] = { ok: false, error };
      }
    }
  });

  await Promise.all(runners);
  return results;
}

/* ------------------------------------------------------------------ */
/* メイン                                                              */
/* ------------------------------------------------------------------ */

/**
 * タイトルに抽選/予約/受注/再販/応募/当選 が含まれるか。
 * @param {string} text
 * @returns {boolean}
 */
export function hasLotteryIntent(text) {
  const n = normalizeForMatch(text);
  if (!n) return false;
  return LOTTERY_HINTS.some((k) => n.includes(normalizeForMatch(k)));
}

/**
 * 公式サイト群から RawItem[] を収集する。
 *
 * - enabled:false のサイトはスキップ
 * - 各サイトの失敗は console.warn してスキップ。全滅でも空配列を返し throw しない
 *   （公式サイトが落ちても他の情報源で動き続けるべきなので）
 * - 取得0件でも warn するだけ（サイト構造変更の早期発見のため）
 *
 * @param {Object} config config/official-sites.json の中身
 * @param {{now?:Date, maxAgeHours?:number, concurrency?:number, verbose?:boolean}} [opts]
 * @returns {Promise<Array<Object>>} RawItem[]
 */
export async function fetchOfficialItems(config, opts = {}) {
  const { now = new Date(), maxAgeHours = 168, concurrency = 4, verbose = false } = opts || {};

  const defaults = (config && config.defaults) || {};
  const sites = ((config && config.sites) || []).filter((s) => s && s.url && s.enabled !== false);

  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const minMs = Number.isFinite(maxAgeHours) && maxAgeHours > 0 ? nowMs - maxAgeHours * 3600 * 1000 : -Infinity;
  const nowIso = new Date(nowMs).toISOString();

  if (sites.length === 0) {
    console.warn('[official] 有効な公式サイト設定が0件です');
    return [];
  }

  const width = Math.min(Math.max(Number(concurrency) || 1, 1), HARD_CONCURRENCY_LIMIT);
  const retry = defaults.retry === undefined ? HARD_RETRY_LIMIT : defaults.retry;

  const results = await runPool(sites, width, (site) =>
    withRetry(() => fetchSiteEntries(site, defaults), retry)
  );

  /** @type {Array<Object>} */
  const items = [];
  const seenIds = new Set();

  for (let i = 0; i < sites.length; i += 1) {
    const site = sites[i];
    const r = results[i];

    if (!r || !r.ok) {
      console.warn(`[official] 取得失敗 ${site.id} (${site.url}): ${r?.error?.message || r?.error}`);
      continue;
    }

    const entries = Array.isArray(r.value) ? r.value : [];
    if (entries.length === 0) {
      console.warn(`[official] 取得0件 ${site.id} (${site.url}) — サイト構造が変わった可能性`);
      continue;
    }

    const weight = typeof site.weight === 'number' ? site.weight : Number(defaults.weight) || DEFAULT_WEIGHT;
    const baseIps = Array.isArray(site.ips) ? site.ips.filter(Boolean) : [];
    let accepted = 0;

    for (const entry of entries) {
      const title = String(entry.title || '').trim();
      const rawUrl = String(entry.link || '').trim();
      if (!title || !rawUrl) continue;

      const publishedAt = entry.pubDate || nowIso;
      const t = new Date(publishedAt).getTime();
      if (Number.isFinite(t) && t < minMs) continue;

      const url = canonicalizeUrl(rawUrl);
      const ips = baseIps.slice();
      if (hasLotteryIntent(title) && !ips.includes(LOTTERY_IP)) ips.push(LOTTERY_IP);
      if (ips.length === 0) ips.push(LOTTERY_IP);

      const id = makeItemId(title, url);
      if (seenIds.has(id)) continue;
      seenIds.add(id);

      items.push({
        id,
        title,
        url,
        sourceName: site.name || site.id,
        sourceId: site.id,
        sourceWeight: weight,
        summary: '',
        publishedAt: Number.isFinite(t) ? new Date(t).toISOString() : nowIso,
        ips,
        feedUrl: site.url,
        // 第2フェーズの拡張フィールド（区画Gが後から付与する）
        kind: 'official',
        tier: 'official',
        destUrl: null,
        destLabel: null,
        startsAt: null,
        // 一覧に締切が埋まっているサイト（プレミアムバンダイ等）から取れた正式な締切。
        // 記事本文には締切が書かれていないことが多いため、これは貴重な情報。
        deadline: entry.deadline || null,
        // 店が公表している締切なので「受付中と確認できた」扱いにできる
        applyVerified: Boolean(entry.deadline),
      });
      accepted += 1;
    }

    if (verbose) {
      console.log(`[official] ${site.id}: 抽出${entries.length}件 / 採用${accepted}件`);
    }
    if (accepted === 0) {
      console.warn(`[official] ${site.id}: ${maxAgeHours}時間以内の記事が0件（抽出は${entries.length}件）`);
    }
  }

  if (verbose) console.log(`[official] 合計 ${items.length}件`);
  return items;
}
