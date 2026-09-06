// src/format.js
// X(Twitter) への投稿文面を組み立てるモジュール。
// npm依存なし（Node標準のみ / ESM名前付きexport / Node >= 20）。
//
// 契約: CONTRACT.md 区画C
//   export function weightedLength(text)
//   export function buildThread(top, { date, hashtags })  -> Array<{text:string}>
//   export function buildSingle(top, { date, hashtags })  -> string

/** 1ツイートの上限（重み付き文字数） */
export const MAX_TWEET_WEIGHT = 280;

/** URL は実長に関係なく一律この重みで数える（t.co 短縮の仕様） */
export const URL_WEIGHT = 23;

/** URL 検出パターン（グローバルフラグは都度生成して lastIndex 汚染を避ける） */
const URL_SOURCE = 'https?:\\/\\/\\S+';

/**
 * 重み 1 とみなすコードポイント範囲（twitter-text v3 の weightedLength 既定設定）。
 * これ以外はすべて重み 2（CJK・絵文字など）。
 */
const LIGHT_RANGES = [
  [0x0000, 0x10ff],
  [0x2000, 0x200d],
  [0x2010, 0x201f],
  [0x2032, 0x2037],
];

/** IPキー → ツイート内で使う短縮ラベル */
export const IP_LABELS = {
  pokemon: 'ポケカ',
  onepiece: 'ワンピカード',
  dragonball: 'ドラゴンボール',
  gundam: 'ガンダム',
  hololive: 'ホロライブ',
  yugioh: '遊戯王',
  duelmasters: 'デュエマ',
  mtg: 'MTG',
  newtcg: '新作TCG',
  digimon: 'デジモン',
  battlespirits: 'バトスピ',
  aikatsu: 'アイカツ',
  carddass: 'カードダス',
  vanguard: 'ヴァンガード',
  weiss: 'ヴァイス',
  lottery: '抽選',
};

/** 順位マーク。6位以降は「6.」のような数字フォールバック */
const MEDALS = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];

/** 最低限これだけはタイトルに残す（重み） */
const MIN_TITLE_WEIGHT = 20;

// ---------------------------------------------------------------------------
// 重み付き文字数
// ---------------------------------------------------------------------------

/** 1コードポイントの重み */
function codePointWeight(cp) {
  for (const [lo, hi] of LIGHT_RANGES) {
    if (cp >= lo && cp <= hi) return 1;
  }
  return 2;
}

/** URL を含まない素のテキストの重み */
function plainWeight(text) {
  let w = 0;
  // サロゲートペアを1コードポイントとして扱うため [...text] でイテレート
  for (const ch of text) w += codePointWeight(ch.codePointAt(0));
  return w;
}

/**
 * X の重み付き文字数を返す。
 * - 日本語・絵文字などは 2、ASCII などは 1
 * - `https?://...` にマッチする部分は実長に関係なく一律 23
 * @param {string} text
 * @returns {number}
 */
export function weightedLength(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  const re = new RegExp(URL_SOURCE, 'g');
  let total = 0;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    total += plainWeight(text.slice(last, m.index));
    total += URL_WEIGHT;
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++; // 念のための無限ループ防止
  }
  total += plainWeight(text.slice(last));
  return total;
}

/**
 * テキストを「URL 1個」または「1コードポイント」単位のトークン列に分解する。
 * URL は分割不可能な1トークンとして扱う。
 */
function tokenize(text) {
  const re = new RegExp(URL_SOURCE, 'g');
  const tokens = [];
  let last = 0;
  let m;
  const pushPlain = (s) => {
    for (const ch of s) tokens.push({ text: ch, weight: codePointWeight(ch.codePointAt(0)) });
  };
  while ((m = re.exec(text)) !== null) {
    pushPlain(text.slice(last, m.index));
    tokens.push({ text: m[0], weight: URL_WEIGHT });
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  pushPlain(text.slice(last));
  return tokens;
}

/**
 * 重み付き文字数で安全に切り詰める。URL の途中では切らない。
 * @param {string} text
 * @param {number} maxWeight
 * @param {string} [ellipsis='…']
 * @returns {string}
 */
export function truncateToWeight(text, maxWeight, ellipsis = '…') {
  const src = typeof text === 'string' ? text : '';
  if (!Number.isFinite(maxWeight) || maxWeight <= 0) return '';
  if (weightedLength(src) <= maxWeight) return src;

  const ellipsisWeight = weightedLength(ellipsis);
  const budget = maxWeight - ellipsisWeight;
  if (budget <= 0) return '';

  let out = '';
  let used = 0;
  for (const token of tokenize(src)) {
    if (used + token.weight > budget) break;
    out += token.text;
    used += token.weight;
  }
  out = out.replace(/[\s　]+$/u, '');
  if (out === '') return '';
  return out + ellipsis;
}

// ---------------------------------------------------------------------------
// 日付（Asia/Tokyo）
// ---------------------------------------------------------------------------

const JST_MD = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Tokyo',
  month: 'numeric',
  day: 'numeric',
});

const JST_MDHM = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Tokyo',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function partsOf(fmt, date) {
  const out = {};
  for (const p of fmt.formatToParts(date)) out[p.type] = p.value;
  return out;
}

/** Asia/Tokyo の `M/D` */
export function formatDateJst(value) {
  const d = toDate(value);
  if (!d) return '';
  const p = partsOf(JST_MD, d);
  return `${p.month}/${p.day}`;
}

/** Asia/Tokyo の `M/D HH:mm` */
export function formatDateTimeJst(value) {
  const d = toDate(value);
  if (!d) return '';
  const p = partsOf(JST_MDHM, d);
  return `${p.month}/${p.day} ${p.hour}:${p.minute}`;
}

// ---------------------------------------------------------------------------
// 小道具
// ---------------------------------------------------------------------------

/** 順位マーク（0始まりのindex） */
export function medal(index) {
  return MEDALS[index] ?? `${index + 1}.`;
}

/**
 * RankedItem の主IPラベルを返す（lottery は主IPから除外）。
 * @param {object} item
 * @returns {string}
 */
export function ipLabel(item) {
  const ips = Array.isArray(item?.ips) ? item.ips.filter((v) => typeof v === 'string') : [];
  const primary =
    ips.find((ip) => ip !== 'lottery' && IP_LABELS[ip]) ?? ips.find((ip) => IP_LABELS[ip]);
  return primary ? IP_LABELS[primary] : '';
}

/** 開きカッコで始まるタイトルはラベルと直結、それ以外は半角スペースを挟む */
const OPEN_BRACKET = /^[「『【〈《（(\[［"“”'']/u;

function joinLabelTitle(label, title) {
  if (!label) return title;
  if (!title) return label;
  if (title.startsWith(label)) return title; // 二重表記を避ける
  return OPEN_BRACKET.test(title) ? `${label}${title}` : `${label} ${title}`;
}

/** ハッシュタグを正規化: `#` 付与・重複除去・最大4個 */
export function normalizeHashtags(hashtags, max = 4) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(hashtags) ? hashtags : []) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim().replace(/\s+/gu, '');
    if (trimmed === '' || trimmed === '#') continue;
    const tag = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= max) break;
  }
  return out;
}

/** top 引数を配列に正規化 */
function normalizeTop(top) {
  const arr = Array.isArray(top) ? top : top ? [top] : [];
  return arr.filter((it) => it && typeof it === 'object');
}

function cleanText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n\t]+/gu, ' ').replace(/[ 　]{2,}/gu, ' ').trim();
}

/** summary は本文と重複しがちなので、タイトルと被る場合は落とす */
function cleanSummary(item) {
  const summary = cleanText(item?.summary);
  if (!summary) return '';
  const title = cleanText(item?.title);
  if (title && (summary === title || summary.startsWith(title))) return '';
  return summary;
}

function itemUrl(item) {
  const url = typeof item?.url === 'string' ? item.url.trim() : '';
  return /^https?:\/\/\S+$/u.test(url) ? url : '';
}

// ---------------------------------------------------------------------------
// 第2フェーズ: 応募導線（destUrl / destLabel / deadline）
// すべて任意フィールド。無ければ従来と完全に同じ出力になる。
// ---------------------------------------------------------------------------

/** 応募ページの直リンク（http(s) のみ許可）。無ければ空文字 */
function destUrl(item) {
  const url = typeof item?.destUrl === 'string' ? item.destUrl.trim() : '';
  return /^https?:\/\/\S+$/u.test(url) ? url : '';
}

/** 店名。長すぎるものは切り詰める（280weight保証のため） */
function destLabel(item) {
  return truncateToWeight(cleanText(item?.destLabel), 30);
}

/** 締切のエポックms。無効なら null */
function deadlineMs(item) {
  const t = Date.parse(typeof item?.deadline === 'string' ? item.deadline : '');
  return Number.isFinite(t) ? t : null;
}

function toMs(value, fallback) {
  const d = toDate(value);
  return d ? d.getTime() : fallback;
}

/**
 * 「いま応募できる」か。destUrl があり、かつ締切切れでないこと。
 * @param {object} item
 * @param {Date|string|number} [now]
 * @returns {boolean}
 */
export function isApplyOpen(item, now = new Date()) {
  if (!destUrl(item)) return false;
  const nowMs = toMs(now, Date.now());
  // 「受付中だと言える根拠」があるものだけを対象にする。根拠は2つのどちらか。
  //   1. 店が公表している受付情報を取得できた（applyVerified）
  //   2. 締切日時が明示されていて、まだ過ぎていない
  // 根拠が無いもの（店の商品一覧に載っているだけ）は対象外。
  // 楽天の販売期間内の商品が店側で「エントリー期間外」と表示された事例があるため。
  const hasStatedDeadline = Number.isFinite(deadlineMs(item));
  if (item && item.applyVerified !== true && !hasStatedDeadline) return false;
  // 受付開始前のものを「応募できる」と扱わない。
  // 開始前にリンクを踏むと店側で「エントリー期間外」と表示され、
  // 応募できたつもりで取り逃す。締切切れと同じくらい有害。
  const st = startsAtMs(item);
  if (st !== null && st > nowMs) return false;
  const dl = deadlineMs(item);
  if (dl === null) return true;
  return dl > nowMs;
}

/**
 * 受付開始前か（開始日時が未来）。
 * @param {object} item
 * @param {Date|number} [now]
 * @returns {boolean}
 */
export function isApplyUpcoming(item, now = new Date()) {
  const st = startsAtMs(item);
  if (st === null) return false;
  return st > toMs(now, Date.now());
}

/** startsAt のエポックms（無ければ null） */
function startsAtMs(item) {
  const t = Date.parse(item && item.startsAt);
  return Number.isFinite(t) ? t : null;
}

/**
 * 詳細ツイートに載せる応募情報の行（⏰ 締切 / 🛒 店名）。
 * 締切切れのものは載せない（上流で除外される想定だが防御的に）。
 */
function applyLines(item, nowMs) {
  const lines = [];
  const st = startsAtMs(item);
  const dl = deadlineMs(item);
  if (st !== null && st > nowMs) {
    // 開始前は「いつから応募できるか」が知りたい情報。締切だけ書くと今応募できると誤解される
    lines.push(`⏳ ${formatDateTimeJst(item.startsAt)} 受付開始`);
  } else if (dl !== null && dl > nowMs) {
    lines.push(`⏰ ${formatDateTimeJst(item.deadline)}まで`);
  }
  const label = destLabel(item);
  if (destUrl(item) && label) lines.push(`🛒 ${label}`);
  return lines;
}

// ---------------------------------------------------------------------------
// 1本目（見出し）
// ---------------------------------------------------------------------------

function headlineText(item) {
  return joinLabelTitle(ipLabel(item), cleanText(item?.title));
}

function buildHeader(items, date, hashtags, nowMs) {
  const head = `【${formatDateJst(date) || formatDateJst(new Date())} TCG注目ニュース TOP${items.length}】`;
  // 応募できるものが含まれるなら、リプ欄に直リンクがあることを明示する
  const canApply = items.some((it) => isApplyOpen(it, new Date(nowMs)));
  const cta = canApply ? '※リプ欄から直接応募できます👇' : 'くわしくはリプ欄に👇';
  const tags = normalizeHashtags(hashtags);

  const assemble = (titleCap, tagList) => {
    const lines = items.map((it, i) => {
      const t = titleCap === Infinity ? headlineText(it) : truncateToWeight(headlineText(it), titleCap);
      return `${medal(i)} ${t}`.trimEnd();
    });
    const footer = tagList.length ? [cta, tagList.join(' ')] : [cta];
    return [head, '', ...lines, '', ...footer].join('\n');
  };

  // タイトルを段階的に短くしながら 280weight 以内を目指す
  for (const tagList of [tags, tags.slice(0, 2), []]) {
    for (let cap = Infinity; ; cap = cap === Infinity ? 120 : cap - 4) {
      const text = assemble(cap, tagList);
      if (weightedLength(text) <= MAX_TWEET_WEIGHT) return text;
      if (cap !== Infinity && cap <= MIN_TITLE_WEIGHT) break;
    }
  }
  // それでも入らない極端なケース（順位数が多すぎる等）は最終手段でハードに切る
  return truncateToWeight(assemble(MIN_TITLE_WEIGHT, []), MAX_TWEET_WEIGHT);
}

// ---------------------------------------------------------------------------
// 2本目以降（各順位 + リンク）
// ---------------------------------------------------------------------------

function buildDetail(item, index, nowMs) {
  const label = ipLabel(item);
  const head = `${medal(index)}${label ? ` ${label}` : ''}`;
  const title = cleanText(item?.title);
  const summary = cleanSummary(item);
  // URLは重み23。応募ページがあるなら記事URLは載せず、応募ページ「だけ」を載せる。
  const dest = destUrl(item);
  const url = dest || itemUrl(item);
  const apply = applyLines(item, nowMs);

  // メタ行（後ろから削れるように優先度順で並べる）
  const metaLines = [];
  const when = formatDateTimeJst(item?.publishedAt);
  const source = cleanText(item?.sourceName);
  if (when || source) metaLines.push(`📅 ${[when, source].filter(Boolean).join(' ／ ')}`);
  const tags = (Array.isArray(item?.intentTags) ? item.intentTags : [])
    .map((t) => cleanText(t))
    .filter(Boolean)
    .slice(0, 3);
  if (tags.length) metaLines.push(`🏷 ${tags.join(' ')}`);
  const clusterSize = Number(item?.clusterSize);
  if (Number.isFinite(clusterSize) && clusterSize >= 2) {
    metaLines.push(`📰 他${clusterSize - 1}媒体が報道`);
  }

  const assemble = (t, s, metaCount) => {
    const blocks = [head + (t ? `\n${t}` : '')];
    if (s) blocks.push(s);
    // 応募情報（締切・店名）はメタ行より優先して残す
    if (apply.length) blocks.push(apply.join('\n'));
    const meta = metaLines.slice(0, metaCount);
    if (meta.length) blocks.push(meta.join('\n'));
    if (url) blocks.push(url);
    return blocks.join('\n\n');
  };

  const titleCaps = [Infinity, 200, 160, 140, 120, 100, 80, 60, 40, MIN_TITLE_WEIGHT];
  const summaryCaps = [Infinity, 140, 120, 100, 80, 60, 40, 0];

  // 優先度: メタ行を残す > タイトルを長く残す > summary を残す
  for (let metaCount = metaLines.length; metaCount >= 0; metaCount--) {
    for (const titleCap of titleCaps) {
      const t = titleCap === Infinity ? title : truncateToWeight(title, titleCap);
      for (const summaryCap of summaryCaps) {
        const s =
          summaryCap === Infinity ? summary : summaryCap === 0 ? '' : truncateToWeight(summary, summaryCap);
        const text = assemble(t, s, metaCount);
        if (weightedLength(text) <= MAX_TWEET_WEIGHT) return text;
        if (!summary) break; // summary が無いなら回す意味がない
      }
    }
  }
  // 保険: 応募情報とURLだけは残す形で強制的に収める
  for (const withApply of [true, false]) {
    const blocks = [head];
    if (withApply && apply.length) blocks.push(apply.join('\n'));
    if (url) blocks.push(url);
    const fallback = blocks.join('\n\n');
    if (weightedLength(fallback) <= MAX_TWEET_WEIGHT) return fallback;
  }
  return truncateToWeight(url ? `${head}\n\n${url}` : head, MAX_TWEET_WEIGHT);
}

// ---------------------------------------------------------------------------
// 公開API
// ---------------------------------------------------------------------------

/**
 * スレッド形式のツイート配列を組み立てる。
 * 1本目 = ランキング見出し（リンクなし）、2本目以降 = 各順位 + リンク。
 * すべてのツイートが 280weight 以内であることを保証する。
 *
 * @param {Array<object>} top RankedItem[]（1〜5件想定）
 * @param {{date?:Date|string|number, hashtags?:string[]}} [opts]
 * @returns {Array<{text:string}>}
 */
export function buildThread(top, { date = new Date(), hashtags = [] } = {}) {
  const items = normalizeTop(top);
  if (items.length === 0) return [];
  const nowMs = toMs(date, Date.now());
  const tweets = [{ text: buildHeader(items, date, hashtags, nowMs) }];
  items.forEach((item, i) => {
    tweets.push({ text: buildDetail(item, i, nowMs) });
  });
  return tweets;
}

/**
 * 1ツイート完結版。TOP N のタイトル（超短縮）+ 1位のリンクのみ。
 * @param {Array<object>} top
 * @param {{date?:Date|string|number, hashtags?:string[]}} [opts]
 * @returns {string}
 */
export function buildSingle(top, { date = new Date(), hashtags = [] } = {}) {
  const items = normalizeTop(top);
  if (items.length === 0) return '';
  const head = `【${formatDateJst(date) || formatDateJst(new Date())} TCG注目ニュース TOP${items.length}】`;
  // 1位に応募ページがあるなら記事URLではなくそちらを載せる
  const dest = isApplyOpen(items[0], date) ? destUrl(items[0]) : '';
  const url = dest || itemUrl(items[0]);
  const urlCaption = dest ? '▼1位の応募ページ' : '▼1位の記事';
  const tags = normalizeHashtags(hashtags);

  const assemble = (titleCap, tagList, withUrl) => {
    const lines = items.map((it, i) => `${medal(i)} ${truncateToWeight(headlineText(it), titleCap)}`.trimEnd());
    const blocks = [[head, ...lines].join('\n')];
    if (withUrl && url) blocks.push(`${urlCaption}\n${url}`);
    if (tagList.length) blocks.push(tagList.join(' '));
    return blocks.join('\n\n');
  };

  for (const tagList of [tags, tags.slice(0, 2), []]) {
    for (let cap = 100; cap >= MIN_TITLE_WEIGHT; cap -= 4) {
      const text = assemble(cap, tagList, true);
      if (weightedLength(text) <= MAX_TWEET_WEIGHT) return text;
    }
  }
  const bare = assemble(MIN_TITLE_WEIGHT, [], true);
  return truncateToWeight(bare, MAX_TWEET_WEIGHT);
}
