/**
 * 区画B: 同一ネタ（複数メディアが報じた同じニュース）のクラスタリング。
 *
 * 依存パッケージなし / Node標準のみ / ESM名前付きexport。
 *
 * @typedef {import('./collect.js').RawItem} RawItem  ※区画A担当（未存在でも型注釈のみなので影響なし）
 */

/** クラスタ判定の既定しきい値（config/scoring.json の clusterThreshold から注入可能） */
export const DEFAULT_CLUSTER_THRESHOLD = 0.55;

/**
 * メディア名サフィックスの区切り文字。NFKC後は全角｜も | になるが保険で両方入れる。
 * 例: 「... - 4Gamer.net」「...｜ファミ通.com」「... — 電ファミ」
 */
const SUFFIX_SEP = '\\-\u2013\u2014\\|\uFF5C';

/** サフィックスとみなす末尾の最大文字数 */
const MAX_SUFFIX_LEN = 20;

/** サフィックスを剥がした後に残る本文の最小長（剥がしすぎ防止） */
const MIN_HEAD_LEN = 4;

/**
 * 記号・約物。NFKC適用後を前提にしつつ、変換されない全角記号も明示的に含める。
 * 【】「」『』［］（）() ! ? ！？ 、。・… 引用符 |｜ /／ - — – ー ~ 〜 :： ;； #＃ *＊
 */
const PUNCT_RE = new RegExp(
  '[' +
    '\u3010\u3011' + // 【】
    '\u300C\u300D\u300E\u300F' + // 「」『』
    '\uFF3B\uFF3D\\[\\]' + // ［］[]
    '\uFF08\uFF09()' + // （）()
    '!?\uFF01\uFF1F' + // !?！？
    '\u3001\u3002\u30FB\u2026\u2025.' + // 、。・…‥ / … は NFKC で "..." に分解されるため半角ピリオドも対象
    '"\'\u201C\u201D\u2018\u2019\u301D\u301F' + // 各種引用符
    '\\|\uFF5C' + // |｜
    '/\uFF0F' + // /／
    '\\-\u2014\u2013\u30FC\uFF0D' + // - — – ー －
    '~\u301C\uFF5E' + // ~ 〜 ～
    ':\uFF1A;\uFF1B' + // :：;；
    '#\uFF03' + // #＃
    '*\uFF0A' + // *＊
  ']',
  'g',
);

/** 各種空白（半角/全角/NBSP/タブ/改行）をまとめて1つにするための正規表現 */
const SPACE_RE = /[\s\u00A0\u3000\u2000-\u200B\uFEFF]+/g;

/**
 * メディア名の定型サフィックスを末尾から剥がす。
 * 「[-–—|｜] 以降が MAX_SUFFIX_LEN 文字以内」なら末尾サフィックスとみなす。
 * 「... - 4Gamer.net｜ニュース」のような二重サフィックスに備えて数回繰り返す。
 * @param {string} s
 * @returns {string}
 */
function stripMediaSuffix(s) {
  let out = s;
  const re = new RegExp(`^([\\s\\S]*)[${SUFFIX_SEP}]([^${SUFFIX_SEP}]{0,${MAX_SUFFIX_LEN}})$`);
  for (let i = 0; i < 3; i++) {
    const m = re.exec(out);
    if (!m) break;
    const head = m[1].trim();
    if (head.length < MIN_HEAD_LEN) break; // 本文が消えるなら剥がさない
    out = head;
  }
  return out;
}

/**
 * 比較用にタイトルを正規化する。
 * NFKC → 小文字化 → 空白正規化 → メディアサフィックス除去 → 記号除去 → 空白圧縮/trim。
 * 冪等（2回かけても結果は同じ）。
 * @param {string} title
 * @returns {string}
 */
export function normalizeTitle(title) {
  if (title == null) return '';
  let s = String(title);
  s = s.normalize('NFKC');
  s = s.toLowerCase();
  s = s.replace(SPACE_RE, ' ').trim();
  s = stripMediaSuffix(s);
  s = s.replace(PUNCT_RE, '');
  s = s.replace(SPACE_RE, ' ').trim();
  return s;
}

/**
 * 正規化済み文字列から文字bigramのSetを作る。
 * 長さ0なら空Set、長さ1ならその1文字だけのSet（1文字同士の同一比較を1.0にするため）。
 * @param {string} s 正規化済み文字列
 * @returns {Set<string>}
 */
export function bigrams(s) {
  const out = new Set();
  if (!s) return out;
  if (s.length === 1) {
    out.add(s);
    return out;
  }
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/**
 * bigram集合のJaccard係数。
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {number} 0〜1
 */
function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const g of small) if (large.has(g)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * 2タイトルの類似度（bigram Jaccard係数）。
 * 引数は生タイトル・正規化済みどちらでもよい（normalizeTitleは冪等）。
 * @param {string} a
 * @param {string} b
 * @returns {number} 0〜1。どちらかが空なら0
 */
export function similarity(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  return jaccard(bigrams(na), bigrams(nb));
}

/**
 * 比較コスト削減のための早期スキップ判定。
 * 「先頭2文字が全く共通しない」かつ「長さ比が2倍以上違う」なら比較しない。
 * @param {string} a 正規化済み
 * @param {string} b 正規化済み
 * @returns {boolean} true ならスキップしてよい
 */
function shouldSkip(a, b) {
  const headA = new Set(a.slice(0, 2));
  const headB = new Set(b.slice(0, 2));
  let shares = false;
  for (const c of headA) {
    if (headB.has(c)) {
      shares = true;
      break;
    }
  }
  if (shares) return false;
  const lo = Math.min(a.length, b.length);
  const hi = Math.max(a.length, b.length);
  if (lo === 0) return true;
  return hi / lo >= 2;
}

/**
 * URL比較用キー（末尾スラッシュ・大文字小文字のゆれのみ吸収。本格的な正規化は区画A担当）。
 * @param {string} url
 * @returns {string}
 */
function urlKey(url) {
  if (!url) return '';
  return String(url).trim().toLowerCase().replace(/\/+$/, '');
}

/**
 * publishedAt を数値化（不正値は0）。
 * @param {{publishedAt?: string}} item
 * @returns {number}
 */
function ts(item) {
  const t = Date.parse(item?.publishedAt ?? '');
  return Number.isNaN(t) ? 0 : t;
}

/**
 * 類似タイトルの記事を貪欲法でグルーピングする。
 * - 同一URLは無条件で同一クラスタ
 * - similarity >= threshold で既存クラスタに追加
 * - 各クラスタ内は publishedAt 昇順（最初に報じた順）
 *
 * @param {RawItem[]} items
 * @param {{threshold?: number}} [opts]
 * @returns {Array<RawItem[]>}
 */
export function clusterItems(items, opts = {}) {
  const threshold =
    typeof opts.threshold === 'number' && Number.isFinite(opts.threshold)
      ? opts.threshold
      : DEFAULT_CLUSTER_THRESHOLD;

  const list = Array.isArray(items) ? items : [];
  /** @type {Array<{items: RawItem[], keys: string[], grams: Array<Set<string>>, urls: Set<string>}>} */
  const clusters = [];

  for (const item of list) {
    if (!item) continue;
    const norm = normalizeTitle(item.title);
    const grams = bigrams(norm);
    const uk = urlKey(item.url);

    let target = null;
    for (const c of clusters) {
      if (uk && c.urls.has(uk)) {
        target = c;
        break;
      }
      if (!norm) continue;
      for (let i = 0; i < c.keys.length; i++) {
        const k = c.keys[i];
        if (!k) continue;
        if (norm === k) {
          target = c;
          break;
        }
        if (shouldSkip(norm, k)) continue;
        if (jaccard(grams, c.grams[i]) >= threshold) {
          target = c;
          break;
        }
      }
      if (target) break;
    }

    if (target) {
      target.items.push(item);
      target.keys.push(norm);
      target.grams.push(grams);
      if (uk) target.urls.add(uk);
    } else {
      clusters.push({
        items: [item],
        keys: [norm],
        grams: [grams],
        urls: new Set(uk ? [uk] : []),
      });
    }
  }

  return clusters.map((c) => c.items.slice().sort((a, b) => ts(a) - ts(b)));
}
