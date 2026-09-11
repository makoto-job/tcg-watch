/**
 * src/collect.js — 収集オーケストレーション
 *
 * config/sources.json の feeds + googleNews.queries + X を並列に取得し、
 * IPキーワードでフィルタして RawItem[] を返す。
 */

import { createHash } from 'node:crypto';
import { fetchFeed, decodeDisplayText } from './rss.js';
import { canonicalizeUrl, resolveUrl } from './resolve.js';
import { fetchXItems } from './sources/xlists.js';
import { fetchOfficialItems } from './sources/official.js';
import { fetchShopItems } from './sources/shops.js';

/**
 * タイトル末尾の媒体名サフィックスを除去する。
 * 「〜 - GameWith」「〜｜ファミ通.com」のように、区切り記号のあとが sourceName と一致する場合のみ剥がす。
 * 一致判定に限定しているので、記事タイトル本来のハイフンを誤って切ることがない。
 * @param {string} title
 * @param {string} sourceName
 * @returns {string}
 */
export function stripSourceSuffix(title, sourceName) {
  const t = String(title || '').trim();
  const src = String(sourceName || '').trim();
  if (!t || !src) return t;
  const norm = (v) => v.normalize('NFKC').toLowerCase().replace(/[\s.]/g, '');
  const target = norm(src);
  if (!target) return t;
  // 末尾から順に区切り記号を探し、その後ろが媒体名と一致すれば切る（最大2回）
  let out = t;
  for (let i = 0; i < 2; i += 1) {
    const m = out.match(/^([\s\S]*\S)\s*[-–—|｜]\s*([^-–—|｜]{1,40})$/);
    if (!m) break;
    const tail = norm(m[2]);
    // 媒体名そのもの、または媒体名を含む短い断片（例: "ORICON NEWS"）
    if (tail && (tail === target || target.includes(tail) || tail.includes(target))) {
      if (m[1].trim().length >= 8) {
        out = m[1].trim();
        continue;
      }
    }
    break;
  }
  return out;
}

/**
 * 要約がタイトルの焼き直しかを判定する。
 * Googleニュースの description は「タイトル + 媒体名」でしかないことが多く、
 * ツイートに載せると文字数の無駄になるため落とす。
 * @param {string} summary
 * @param {string} title
 * @returns {boolean}
 */
export function isRedundantSummary(summary, title) {
  const norm = (v) =>
    String(v || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
  const sm = norm(summary);
  const tt = norm(title);
  if (!sm) return true;
  if (!tt) return false;
  // 要約がタイトルに包含される／タイトルが要約をほぼ覆う
  if (sm.includes(tt) && sm.length <= tt.length * 1.6) return true;
  if (tt.includes(sm)) return true;
  return false;
}

/**
 * カードゲーム一般を指す語。
 * Googleニュース検索は関連の薄い記事も返すため、IPキーワードに自然マッチしない記事は
 * これらのいずれかを含む場合にだけ「クエリのIP最低保証」を適用する。
 * （例:「アークテリクスの抽選まとめ」が ワンピカード扱いされるのを防ぐ）
 */
export const GENERIC_TCG_HINTS = [
  'カード',
  'トレカ',
  'tcg',
  'ocg',
  'パック',
  'デッキ',
  'box',
  'ボックス',
  'レアリティ',
  '収録',
  'シングル',
  '新弾',
];

/**
 * カードゲーム関連の記事らしいか（一般語ベース）。
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeTcg(text) {
  const n = normalizeForMatch(text);
  return GENERIC_TCG_HINTS.some((h) => n.includes(normalizeForMatch(h)));
}

/** 抽選系の横断タグ判定に使う語 */
export const LOTTERY_HINTS = ['抽選', '予約', '受注', '再販', '応募', '当選'];

/** 抽選タグのIPキー */
export const LOTTERY_IP = 'lottery';

const GOOGLE_NEWS_TEMPLATE = 'https://news.google.com/rss/search?q={query}&hl=ja&gl=JP&ceid=JP:ja';

/* ------------------------------------------------------------------ */
/* マッチングロジック（テストから直接叩ける named export）             */
/* ------------------------------------------------------------------ */

/**
 * 比較用の正規化。NFKC で全角半角のゆれを吸収し、小文字化、
 * 記号・約物・空白を除去する。
 * 例: "ポケモンカード＆グッズ" -> "ポケモンカードグッズ"
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
 * 単語境界を判定するための正規化。記号は空白に潰し、空白は1つに畳む。
 * `normalizeForMatch` と違って**空白を残す**のがポイント。
 * @param {string} s
 * @returns {string}
 */
export function normalizeKeepingSpaces(s) {
  return String(s == null ? '' : s)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 短い英数字だけのキーワード（MTG, OCG など）は、部分一致だと誤爆する。
 * 例:「RX78FRGMT GUNDAM」の中の "frgmtgundam" に "mtg" が含まれてしまい、
 * ガンプラがMTG（マジック：ザ・ギャザリング）として判定されていた。
 * こういう語は英数字の連なりの境界で区切って判定する。
 * @param {string} kw
 * @returns {boolean}
 */
export function needsWordBoundary(kw) {
  const k = String(kw || '').trim();
  return k.length > 0 && k.length <= 4 && /^[A-Za-z0-9]+$/.test(k);
}

/**
 * キーワード1件がテキストにマッチするか。
 * 空白を含むキーワードは AND 条件（順不同）として扱う。
 * @param {string} normalizedText normalizeForMatch 済みテキスト
 * @param {string} keyword
 * @returns {boolean}
 */
export function keywordMatches(normalizedText, keyword, spacedText = null) {
  const raw = String(keyword || '')
    .split(/[\s　]+/)
    .filter(Boolean);
  if (raw.length === 0) return false;

  return raw.every((part) => {
    if (needsWordBoundary(part)) {
      // 短い英数字語は英数字の連なりの境界でしか一致させない
      const hay = spacedText != null ? spacedText : normalizedText;
      const re = new RegExp(`(?<![a-z0-9])${part.toLowerCase()}(?![a-z0-9])`, 'i');
      return re.test(hay);
    }
    const n = normalizeForMatch(part);
    return n ? normalizedText.includes(n) : false;
  });
}

/**
 * テキストにマッチするIPキーの配列を返す（lottery は含めない）。
 * @param {string} text
 * @param {Record<string, {keywords?: string[]}>} ipsConfig
 * @returns {string[]}
 */
export function matchIps(text, ipsConfig) {
  const n = normalizeForMatch(text);
  if (!n) return [];
  const spaced = normalizeKeepingSpaces(text);
  const hits = [];
  for (const [key, def] of Object.entries(ipsConfig || {})) {
    if (key === LOTTERY_IP) continue;
    const kws = (def && def.keywords) || [];
    for (const kw of kws) {
      if (keywordMatches(n, kw, spaced)) {
        hits.push(key);
        break;
      }
    }
  }
  return hits;
}

/**
 * 抽選・予約系の意図を含むか（IP横断タグ）。
 * @param {string} text
 * @returns {boolean}
 */
export function hasLotteryIntent(text) {
  const n = normalizeForMatch(text);
  if (!n) return false;
  return LOTTERY_HINTS.some((k) => n.includes(normalizeForMatch(k)));
}

/**
 * 安定ID: sha1(normalizedTitle + '|' + url).slice(0,16)
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
 * Googleニュース検索RSSのURLを組み立てる。
 * @param {string} query
 * @param {string} [template]
 * @returns {string}
 */
export function buildGoogleNewsUrl(query, template = GOOGLE_NEWS_TEMPLATE) {
  return String(template).replace('{query}', encodeURIComponent(String(query || '')));
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
/* 収集タスクの組み立て                                                */
/* ------------------------------------------------------------------ */

/**
 * config から取得タスク一覧を作る。
 * @param {Object} config
 * @returns {Array<Object>}
 */
export function buildFeedTasks(config) {
  const tasks = [];

  for (const f of (config && config.feeds) || []) {
    if (!f || !f.url) continue;
    tasks.push({
      origin: 'feed',
      sourceId: f.id || f.url,
      sourceName: f.name || f.id || 'ニュース',
      url: f.url,
      weight: typeof f.weight === 'number' ? f.weight : 1.0,
      kind: f.kind || 'news',
      forcedIps: Array.isArray(f.ips) ? f.ips : [],
    });
  }

  const gn = (config && config.googleNews) || {};
  if (gn.enabled) {
    const template = gn.urlTemplate || GOOGLE_NEWS_TEMPLATE;
    for (const q of gn.queries || []) {
      if (!q || (!q.query && !q.url)) continue;
      tasks.push({
        origin: 'google',
        sourceId: q.id || `gnews:${q.query}`,
        sourceName: 'Googleニュース',
        url: q.url || buildGoogleNewsUrl(q.query, template),
        weight: typeof q.weight === 'number' ? q.weight : 1.0,
        kind: 'news',
        forcedIps: Array.isArray(q.ips) ? q.ips : [],
        query: q.query || '',
      });
    }
  }

  return tasks;
}

/* ------------------------------------------------------------------ */
/* メイン                                                              */
/* ------------------------------------------------------------------ */

/**
 * 全情報源から RawItem[] を収集する。
 * 個別フィードの失敗はスキップして console.warn。全滅時のみ throw。
 *
 * @param {Object} config config/sources.json 相当（+ xSources 任意）
 * @param {{now?:Date, maxAgeHours?:number, concurrency?:number, verbose?:boolean}} [opts]
 * @returns {Promise<Array<Object>>} RawItem[]
 */
export async function collectAll(config, opts = {}) {
  const {
    now = new Date(),
    maxAgeHours = 48,
    concurrency = 6,
    verbose = false,
    officialConfig = null,
    shopConfig = null,
  } = opts || {};

  const ipsConfig = (config && config.ips) || {};
  const tasks = buildFeedTasks(config);
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const minMs = nowMs - maxAgeHours * 3600 * 1000;

  if (tasks.length === 0) {
    if (verbose) console.log('[collect] フィード定義が0件です');
  }

  /** @type {Array<Object>} */
  const collected = [];
  let okCount = 0;
  let failCount = 0;

  const results = await runPool(tasks, concurrency, async (task) => {
    const feed = await fetchFeed(task.url);
    return { task, feed };
  });

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const task = tasks[i];
    if (!r || !r.ok) {
      failCount++;
      console.warn(`[collect] 取得失敗 ${task.sourceId} (${task.url}): ${r?.error?.message || r?.error}`);
      continue;
    }
    okCount++;

    const { feed } = r.value;
    let accepted = 0;

    for (const entry of feed.items || []) {
      const sourceNameRaw = entry.sourceName || task.sourceName;
      const rawTitle = decodeDisplayText(String(entry.title || '')).trim();
      const title = stripSourceSuffix(rawTitle, sourceNameRaw);
      const link = String(entry.link || '').trim();
      if (!title || !link) continue;

      // 日付フィルタ（日付不明はそのまま通す）
      const publishedAt = entry.pubDate || new Date(nowMs).toISOString();
      const t = new Date(publishedAt).getTime();
      if (Number.isFinite(t) && t < minMs) continue;

      const summaryFull = decodeDisplayText(String(entry.description || ''))
        .replace(/\s+/g, ' ')
        .trim();
      const haystack = `${rawTitle} ${summaryFull}`;

      // IP判定
      const matched = new Set(matchIps(haystack, ipsConfig));
      // Googleニュース由来（およびIP固定フィード）はクエリに紐づくIPを最低保証する。
      // ただし検索ノイズ対策として、IPキーワードに自然マッチしない記事は
      // カード関連の一般語を含む場合にだけ最低保証を認める。
      if (matched.size > 0 || looksLikeTcg(haystack)) {
        for (const ip of task.forcedIps) matched.add(ip);
      }
      if (matched.size === 0) continue; // 汎用ニュースフィード対策：無関係な記事は捨てる

      // lottery は横断タグ。単独では成立しない（TCGのIPに1つもマッチしていない記事は対象外）
      if (matched.size === 1 && matched.has(LOTTERY_IP)) continue;
      if (hasLotteryIntent(haystack)) matched.add(LOTTERY_IP);

      collected.push({
        _origin: task.origin,
        title,
        rawLink: link,
        sourceName: sourceNameRaw,
        sourceId: task.sourceId,
        sourceWeight: task.weight,
        summary: isRedundantSummary(summaryFull, title) ? '' : summaryFull.slice(0, 200),
        publishedAt: new Date(Number.isFinite(t) ? Math.min(t, nowMs) : nowMs).toISOString(),
        ips: [...matched],
        feedUrl: task.url,
        kind: task.kind,
      });
      accepted++;
    }

    if (verbose) {
      console.log(
        `[collect] ${task.sourceId}: 取得 ${(feed.items || []).length}件 / 採用 ${accepted}件` +
          (task.query ? ` (q=${task.query})` : '')
      );
    }
  }

  // 全滅時のみ throw
  if (tasks.length > 0 && okCount === 0) {
    throw new Error(`[collect] 全フィードの取得に失敗しました (${failCount}件)`);
  }

  // URL解決（Googleニュース由来のみリダイレクト解決。他は正規化のみ）
  await runPool(collected, concurrency, async (item) => {
    if (item._origin === 'google') {
      item.url = await resolveUrl(item.rawLink);
    } else {
      item.url = canonicalizeUrl(item.rawLink);
    }
  });

  // X（既定無効）
  let xItems = [];
  try {
    xItems = await fetchXItems(config && config.xSources, { verbose });
  } catch (err) {
    console.warn(`[collect] X読み取り失敗: ${err?.message || err}`);
    xItems = [];
  }
  for (const it of xItems) {
    const hay = `${it.title} ${it.summary || ''}`;
    const merged = new Set([...(it.ips || []), ...matchIps(hay, ipsConfig)]);
    if (hasLotteryIntent(hay)) merged.add(LOTTERY_IP);
    if (merged.size === 0) continue;
    it.ips = [...merged];
    const t = new Date(it.publishedAt).getTime();
    if (Number.isFinite(t) && t < minMs) continue;
    collected.push({ ...it, _origin: 'x', rawLink: it.url });
  }

  // ── 公式サイト（一次情報）の取り込み ──
  // メディアより数時間〜数日早いので、抽選に間に合わせるにはここが要。
  if (officialConfig) {
    let officialItems = [];
    try {
      officialItems = await fetchOfficialItems(officialConfig, {
        now,
        maxAgeHours,
        concurrency: Math.min(concurrency, 4),
        verbose,
      });
    } catch (err) {
      console.warn(`[collect] 公式サイトの取得に失敗: ${err.message}`);
      officialItems = [];
    }
    for (const it of officialItems) {
      const hay = `${it.title} ${it.summary || ''}`;
      // タイトルから実際のIPを補う（プレミアムバンダイは ips が lottery だけで来る）
      const merged = new Set([...(it.ips || []), ...matchIps(hay, ipsConfig)]);
      if (hasLotteryIntent(hay)) merged.add(LOTTERY_IP);
      if (merged.size === 0) continue;
      // 公式サイトでも「lottery しか付かない」＝対象IPに1つもマッチしない記事は、
      // カード関連の一般語を含むものだけ通す。
      // プレミアムバンダイの抽選販売はガンプラ・30MS（プラモデル）が大半で、
      // これを素通しすると「【抽選販売】MG 1/100 ガンダム」がフィードを埋める。
      if (merged.size === 1 && merged.has(LOTTERY_IP) && !looksLikeTcg(hay)) continue;
      it.ips = [...merged];
      collected.push({ ...it, _origin: 'official', rawLink: it.url });
    }
    if (verbose) console.log(`[collect] 公式サイト ${officialItems.length}件`);
  }

  // ── 小売店（抽選・予約の実施主体）の取り込み ──
  // ニュースにならない抽選（楽天ブックスのDBフュージョンワールド等）はここでしか取れない。
  if (shopConfig) {
    let shopItems = [];
    try {
      shopItems = await fetchShopItems(shopConfig, {
        now,
        maxAgeHours,
        concurrency: Math.min(concurrency, 3),
        verbose,
      });
    } catch (err) {
      console.warn(`[collect] 小売店の取得に失敗: ${err.message}`);
      shopItems = [];
    }
    for (const it of shopItems) {
      const hay = `${it.title} ${it.summary || ''}`;
      // 店によっては ips が空で来る（複数ジャンルが混在するため）。タイトルから判定する。
      const merged = new Set([...(it.ips || []), ...matchIps(hay, ipsConfig)]);
      if (hasLotteryIntent(hay)) merged.add(LOTTERY_IP);
      // lottery しか付かない＝どのカードゲームか特定できない商品は載せない。
      // 「何のカードか分からない」項目がアプリに並ぶのを防ぐ。
      const real = [...merged].filter((k) => k !== LOTTERY_IP);
      if (real.length === 0) continue;
      it.ips = [...merged];
      collected.push({ ...it, _origin: 'shop', rawLink: it.url });
    }
    if (verbose) console.log(`[collect] 小売店 ${shopItems.length}件`);
  }

  // URL重複排除（先に来たものを優先）
  // 公式サイトの記事を優先したいので、collected の並び順で公式を前に出す
  collected.sort((a, b) => {
    const rank = (x) => (x._origin === 'official' ? 0 : x._origin === 'shop' ? 1 : 2);
    return rank(a) - rank(b);
  });
  const seenUrl = new Set();
  /** @type {Array<Object>} */
  const out = [];
  for (const item of collected) {
    const url = item.url || canonicalizeUrl(item.rawLink);
    if (!url) continue;
    if (seenUrl.has(url)) continue;
    seenUrl.add(url);

    out.push({
      id: makeItemId(item.title, url),
      title: item.title,
      url,
      sourceName: item.sourceName,
      sourceId: item.sourceId,
      sourceWeight: item.sourceWeight,
      summary: item.summary || '',
      publishedAt: item.publishedAt,
      ips: item.ips,
      feedUrl: item.feedUrl,
      kind: item.kind || 'news',
      // 第2フェーズ: 応募導線。区画Gの enrichItems が後から埋める
      tier: item.tier || (item.kind === 'official' ? 'official' : 'news'),
      destUrl: item.destUrl || null,
      destLabel: item.destLabel || null,
      startsAt: item.startsAt || null,
      deadline: item.deadline || null,
      applyVerified: item.applyVerified === true,
      destIsEntry: item.destIsEntry === true,
      prefecture: item.prefecture || '',
      deliveryType: item.deliveryType || '',
      // 掲載日が情報源に書かれていたか。false なら publishedAt は取得時刻。
      publishedAtKnown: item.publishedAtKnown !== false,
      applyStatusUnknown: item.applyStatusUnknown === true,
    });
  }

  if (verbose) {
    console.log(`[collect] 成功 ${okCount}/${tasks.length} フィード、最終 ${out.length}件（重複除去後）`);
  }

  return out;
}
