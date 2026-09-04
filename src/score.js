/**
 * 区画B: スコアリングとTOP選定。
 *
 * 依存パッケージなし / Node標準のみ / ESM名前付きexport。
 * 重み・キーワード等の数値は全て config/scoring.json 側で調整する。
 */

import { clusterItems, DEFAULT_CLUSTER_THRESHOLD } from './cluster.js';

/**
 * config/scoring.json が渡されなかった場合のフォールバック。
 * 実運用では必ず config/scoring.json を読み込んで渡すこと（区画D の loadConfig）。
 */
export const DEFAULT_SCORING = {
  weights: { recency: 40, intent: 30, ip: 15, source: 10, cluster: 5 },
  recency: { halfLifeHours: 12, maxAgeHours: 48 },
  intent: { rawMax: 15, secondaryFactor: 0.3 },
  intentKeywords: {
    抽選: { score: 10, tag: '抽選', patterns: ['抽選販売', '抽選予約', '抽選受付', '抽選'] },
    予約: { score: 9, tag: '予約', patterns: ['予約受付', '予約開始', '予約解禁', '予約'] },
    再販: { score: 8, tag: '再販', patterns: ['再販', '再入荷', '再受注', '再出荷'] },
    新弾: { score: 8, tag: '新弾', patterns: ['新弾', '新セット', '新シリーズ', '新商品', '新パック', '拡張パック'] },
    発売日: { score: 7, tag: '発売', patterns: ['発売日', '発売決定', '発売開始', '本日発売'] },
    受付: { score: 7, tag: '受付', patterns: ['受注', '応募受付', '受付開始', 'エントリー'] },
    当選: { score: 6, tag: '当選', patterns: ['当選発表', '当選者', '当落'] },
    収録: { score: 5, tag: '収録', patterns: ['収録カード', '収録内容', 'カードリスト', '新規カード'] },
    コラボ: { score: 5, tag: 'コラボ', patterns: ['コラボ', 'タイアップ', '限定'] },
    相場: { score: 4, tag: '相場', patterns: ['高額', '買取', '相場', '値上がり'] },
    大会: { score: 3, tag: '大会', patterns: ['大会', 'チャンピオンシップ', '世界大会', '公式大会'] },
  },
  negativeKeywords: {
    patterns: ['詐欺', '転売ヤー 逮捕', 'まとめ', '5ch', 'なんJ', 'アフィリエイト', 'PR:'],
    penalty: 15,
  },
  // ドメイン単位の減点。転売・リセール系はニュース性が低く件数だけ多いため抑制する。
  // キーはホスト名の部分一致（サブドメイン込みで判定）。
  domainPenalties: {
    'snkrdunk.com': 25,
    'fril.jp': 20,
    'mercari.com': 20,
    'aucfan.com': 20,
    'page.auctions.yahoo.co.jp': 20,
  },
  ipWeightRange: { min: 0.9, max: 1.3 },
  sourceWeightRange: { min: 0.5, max: 1.5 },
  clusterThreshold: DEFAULT_CLUSTER_THRESHOLD,
  clusterBonusPerSource: 2,
  clusterBonusMax: 10,
  selection: { maxPerIp: 2 },
};

/** 部分的な設定でも動くよう、セクション単位で既定値を補う。 */
function withDefaults(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const d = DEFAULT_SCORING;
  return {
    ...d,
    ...c,
    weights: { ...d.weights, ...(c.weights || {}) },
    recency: { ...d.recency, ...(c.recency || {}) },
    intent: { ...d.intent, ...(c.intent || {}) },
    intentKeywords: c.intentKeywords || d.intentKeywords,
    negativeKeywords: { ...d.negativeKeywords, ...(c.negativeKeywords || {}) },
    domainPenalties: { ...d.domainPenalties, ...(c.domainPenalties || {}) },
    ipWeightRange: { ...d.ipWeightRange, ...(c.ipWeightRange || {}) },
    sourceWeightRange: { ...d.sourceWeightRange, ...(c.sourceWeightRange || {}) },
    selection: { ...d.selection, ...(c.selection || {}) },
  };
}

const round2 = (v) => Math.round(v * 100) / 100;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** min〜max を 0〜1 に線形正規化（範囲外はクランプ）。 */
function normalizeRange(value, min, max) {
  if (!Number.isFinite(value)) return 0;
  if (!(max > min)) return 0;
  return clamp01((value - min) / (max - min));
}

/** キーワード照合用テキスト（NFKC + 小文字化 + 空白圧縮）。 */
function matchText(...parts) {
  return parts
    .filter(Boolean)
    .join(' ')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s 　]+/g, ' ')
    .trim();
}

/** パターン側も同じ前処理をかけてから includes 判定する。 */
function normPattern(p) {
  return String(p).normalize('NFKC').toLowerCase().replace(/[\s 　]+/g, ' ').trim();
}

/**
 * IPキーの重み。区画Aの sources.json 由来（cfg.ips[key].weight もしくは cfg.ipWeights[key]）。
 * 渡されなければ 1.0。
 */
function ipWeightOf(cfg, key) {
  const fromIps = cfg?.ips?.[key];
  if (fromIps && typeof fromIps === 'object' && Number.isFinite(fromIps.weight)) return fromIps.weight;
  if (Number.isFinite(fromIps)) return fromIps;
  const fromMap = cfg?.ipWeights?.[key];
  if (Number.isFinite(fromMap)) return fromMap;
  if (fromMap && typeof fromMap === 'object' && Number.isFinite(fromMap.weight)) return fromMap.weight;
  return 1.0;
}

/**
 * intentKeywords を照合し、タグとスコアを返す。
 * @returns {{tags: string[], raw: number}}
 */
function matchIntent(text, cfg) {
  /** @type {Map<string, number>} tag -> 最大スコア */
  const hits = new Map();
  const table = cfg.intentKeywords || {};
  for (const key of Object.keys(table)) {
    const entry = table[key];
    if (!entry) continue;
    const tag = entry.tag ?? key;
    const score = Number.isFinite(entry.score) ? entry.score : 0;
    const patterns = Array.isArray(entry.patterns) ? entry.patterns : [key];
    const matched = patterns.some((p) => p && text.includes(normPattern(p)));
    if (!matched) continue;
    if (!hits.has(tag) || hits.get(tag) < score) hits.set(tag, score);
  }
  const sorted = [...hits.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (sorted.length === 0) return { tags: [], raw: 0 };

  const factor = Number.isFinite(cfg.intent?.secondaryFactor) ? cfg.intent.secondaryFactor : 0.3;
  const rawMax = Number.isFinite(cfg.intent?.rawMax) ? cfg.intent.rawMax : 15;
  let raw = sorted[0][1];
  for (let i = 1; i < sorted.length; i++) raw += sorted[i][1] * factor;
  raw = Math.min(raw, rawMax);
  return { tags: sorted.map(([tag]) => tag), raw };
}

/**
 * 1件分のスコアを計算する。
 *
 * @param {object} item RawItem
 * @param {object} cfg config/scoring.json（部分指定可）
 * @param {Date|number|string} [now]
 * @param {number} [clusterSize] 同一ネタを報じた件数（自身含む・最小1）
 * @returns {{score:number, breakdown:{recency:number,intent:number,ip:number,source:number,cluster:number,negative:number}, intentTags:string[]}}
 */
export function scoreItem(item, cfg, now = new Date(), clusterSize = 1) {
  const c = withDefaults(cfg);
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const w = c.weights;

  // --- recency: 半減期モデル。maxAgeHours 超過は 0 ---
  const pubMs = Date.parse(item?.publishedAt ?? '');
  let recencyFactor = 0;
  if (Number.isFinite(pubMs)) {
    const ageHours = Math.max(0, (nowMs - pubMs) / 3600000); // 未来日付は age=0 扱い
    if (ageHours <= c.recency.maxAgeHours) {
      recencyFactor = clamp01(Math.pow(0.5, ageHours / c.recency.halfLifeHours));
    }
  }
  const recency = recencyFactor * w.recency;

  // --- intent: タイトル + summary のキーワード照合 ---
  const text = matchText(item?.title, item?.summary);
  const { tags, raw } = matchIntent(text, c);
  const rawMax = Number.isFinite(c.intent?.rawMax) ? c.intent.rawMax : 15;
  const intent = clamp01(rawMax > 0 ? raw / rawMax : 0) * w.intent;

  // --- ip: 対象IPのうち最大重みを 0.9〜1.3 → 0〜1 ---
  const ips = Array.isArray(item?.ips) ? item.ips : [];
  let maxIpWeight = ips.length ? -Infinity : 1.0;
  for (const key of ips) maxIpWeight = Math.max(maxIpWeight, ipWeightOf(c, key));
  if (!Number.isFinite(maxIpWeight)) maxIpWeight = 1.0;
  const ip = normalizeRange(maxIpWeight, c.ipWeightRange.min, c.ipWeightRange.max) * w.ip;

  // --- source: sourceWeight 0.5〜1.5 → 0〜1 ---
  const sw = Number.isFinite(item?.sourceWeight) ? item.sourceWeight : 1.0;
  const source = normalizeRange(sw, c.sourceWeightRange.min, c.sourceWeightRange.max) * w.source;

  // --- cluster: 複数メディアが報じているほど加点（頭打ちあり） ---
  const size = Number.isFinite(clusterSize) && clusterSize >= 1 ? clusterSize : 1;
  const bonus = Math.min(c.clusterBonusPerSource * (size - 1), c.clusterBonusMax);
  const cluster = (c.clusterBonusMax > 0 ? clamp01(bonus / c.clusterBonusMax) : 0) * w.cluster;

  const breakdown = {
    recency: round2(recency),
    intent: round2(intent),
    ip: round2(ip),
    source: round2(source),
    cluster: round2(cluster),
    negative: 0,
  };

  // --- negative: ノイズ記事の減点（下限0） ---
  const positive =
    breakdown.recency + breakdown.intent + breakdown.ip + breakdown.source + breakdown.cluster;
  const negPatterns = Array.isArray(c.negativeKeywords?.patterns) ? c.negativeKeywords.patterns : [];
  const hasNegative = negPatterns.some((p) => p && text.includes(normPattern(p)));
  let penalty = 0;
  if (hasNegative) {
    penalty += Number.isFinite(c.negativeKeywords.penalty) ? c.negativeKeywords.penalty : 0;
  }
  penalty += domainPenalty(item.url, c.domainPenalties);
  if (penalty > 0) {
    breakdown.negative = -round2(Math.min(penalty, positive)); // 実際に引かれた分だけ記録
  }

  const score = round2(Math.max(0, positive + breakdown.negative));
  return { score, breakdown, intentTags: tags };
}

/**
 * URL のホスト名に対するドメイン減点を返す。該当なしは0。
 * @param {string} url
 * @param {Record<string,number>|undefined} table
 * @returns {number}
 */
export function domainPenalty(url, table) {
  if (!url || !table) return 0;
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 0;
  }
  let worst = 0;
  for (const [needle, value] of Object.entries(table)) {
    if (!Number.isFinite(value)) continue;
    const n = String(needle).toLowerCase();
    // ホストが needle と一致、または needle をドメインサフィックスとして含む
    if (host === n || host.endsWith('.' + n) || host.includes(n)) {
      if (value > worst) worst = value;
    }
  }
  return worst;
}

/** publishedAt を数値化（不正値は0）。 */
function ts(item) {
  const t = Date.parse(item?.publishedAt ?? '');
  return Number.isNaN(t) ? 0 : t;
}

/**
 * クラスタの代表1件を選ぶ。
 * sourceWeight最大 → publishedAt最新 → titleが短い方。
 * @param {object[]} cluster
 */
function pickRepresentative(cluster) {
  return cluster.slice().sort((a, b) => {
    const sw = (Number.isFinite(b.sourceWeight) ? b.sourceWeight : 1) -
      (Number.isFinite(a.sourceWeight) ? a.sourceWeight : 1);
    if (sw !== 0) return sw;
    const t = ts(b) - ts(a);
    if (t !== 0) return t;
    return String(a.title ?? '').length - String(b.title ?? '').length;
  })[0];
}

/**
 * RawItem[] をクラスタリング → 代表選出 → スコア付与 → score降順ソート。
 *
 * @param {object[]} items RawItem[]
 * @param {object} [scoringConfig] config/scoring.json
 * @param {Date} [now]
 * @returns {object[]} RankedItem[]
 */
export function rankItems(items, scoringConfig, now = new Date()) {
  const cfg = withDefaults(scoringConfig);
  // 応募リンクの引き継ぎ判定に使う店名一覧（config/shops.json 由来。無ければ判定しない）
  const shopLabels = Array.isArray(scoringConfig && scoringConfig.shopLabels)
    ? scoringConfig.shopLabels
    : [];
  const list = (Array.isArray(items) ? items : []).filter(Boolean);
  const clusters = clusterItems(list, { threshold: cfg.clusterThreshold });

  const ranked = clusters.map((cluster) => {
    const rep = pickRepresentative(cluster);
    const clusterSize = cluster.length;
    const dupUrls = [
      ...new Set(cluster.filter((it) => it !== rep).map((it) => it.url).filter(Boolean)),
    ].filter((u) => u !== rep.url);

    // クラスタ内の誰かが応募リンクや締切を持っていれば代表に引き継ぐ。
    // 同じ抽選を複数媒体が報じたとき、代表に選ばれた記事（例: Yahoo!ニュース）が
    // 外部リンクを削っていても、別媒体から取れた応募先を活かせる。
    const apply = inheritApplyInfo(rep, cluster, shopLabels);

    const { score, breakdown, intentTags } = scoreItem(rep, cfg, now, clusterSize);
    return { ...rep, ...apply, score, breakdown, intentTags, clusterSize, dupUrls };
  });

  ranked.sort((a, b) => (b.score - a.score) || (ts(b) - ts(a)));
  return ranked;
}

/**
 * 店名がタイトルに出てくるか。「ヨドバシ.com」のような表記ゆれを吸収するため、
 * ラベルの記号以降を落とした主要部分でも判定する。
 * @param {string} title
 * @param {string} label
 * @returns {boolean}
 */
export function titleMentionsLabel(title, label) {
  const t = String(title || '');
  const raw = String(label || '').trim();
  if (!t || raw.length < 2) return false;
  if (t.includes(raw)) return true;
  // 「ヨドバシ.com」→「ヨドバシ」、「HMV&BOOKS online」→「HMV」
  const head = raw.split(/[.．・\s&（(]/)[0];
  return head.length >= 2 && t.includes(head);
}

/**
 * タイトルがいずれかの店を名指ししているか。
 * @param {string} title
 * @param {string[]} shopLabels
 * @returns {boolean}
 */
export function titleNamesAnyShop(title, shopLabels) {
  if (!Array.isArray(shopLabels) || shopLabels.length === 0) return false;
  return shopLabels.some((l) => titleMentionsLabel(title, l));
}

/**
 * クラスタ内の他記事から応募導線を引き継ぐ。
 * 代表自身が持っている値は上書きしない。
 * @param {object} rep
 * @param {object[]} cluster
 * @returns {{destUrl?:string, destLabel?:string, startsAt?:string, deadline?:string}}
 */
export function inheritApplyInfo(rep, cluster, shopLabels = []) {
  const out = {};
  if (!rep.destUrl) {
    // 優先度: 公式サイト由来 > それ以外。同条件なら先に見つかったもの
    let donors = (cluster || []).filter((it) => it !== rep && it.destUrl);

    // 記事タイトルが特定の店を名指ししている場合、その店のリンクしか引き継がない。
    // 「ヨドバシで抽選販売」という記事に、同じ話題の別記事から拾った
    // ポケモンセンターのリンクを付けてしまう事故を防ぐ。
    // 違う店に飛ばすのはリンクを出さないことより有害（応募したつもりで応募できていない）。
    const title = String(rep.title || '');
    if (titleNamesAnyShop(title, shopLabels)) {
      donors = donors.filter((d) => d.destLabel && titleMentionsLabel(title, d.destLabel));
    }

    donors.sort((a, b) => {
      const rank = (x) => (x.tier === 'official' || x.kind === 'official' ? 0 : 1);
      return rank(a) - rank(b);
    });
    const donor = donors[0];
    if (donor) {
      out.destUrl = donor.destUrl;
      out.destLabel = donor.destLabel || null;
    }
  }
  if (!rep.deadline) {
    const d = (cluster || []).find((it) => it !== rep && it.deadline);
    if (d) out.deadline = d.deadline;
  }
  if (!rep.startsAt) {
    const st = (cluster || []).find((it) => it !== rep && it.startsAt);
    if (st) out.startsAt = st.startsAt;
  }
  return out;
}

/**
 * 主IP（lottery を除いた最初のIP）。lotteryしか無ければ 'lottery'。
 * @param {object} item
 * @returns {string}
 */
function primaryIp(item) {
  const ips = Array.isArray(item?.ips) ? item.ips : [];
  const main = ips.find((k) => k && k !== 'lottery');
  return main || ips[0] || '__none__';
}

/**
 * 同一IPに偏らないようTOP N を選ぶ。
 * 制約付きで貪欲に選び、候補が尽きたら制約を無視して埋める。
 *
 * @param {object[]} rankedItems score降順ソート済みの RankedItem[]
 * @param {number} [n]
 * @param {{maxPerIp?: number}} [opts]
 * @returns {object[]} 最大 n 件
 */
/**
 * アイテムのドメイン（www は無視）。取れなければ空文字。
 * @param {{url?:string}} item
 * @returns {string}
 */
export function itemDomain(item) {
  try {
    return new URL(item.url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function selectTop(rankedItems, n = 3, { maxPerIp = 2, maxPerDomain = 1 } = {}) {
  const list = (Array.isArray(rankedItems) ? rankedItems : []).filter(Boolean);
  const limit = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  if (limit === 0) return [];
  const cap = Number.isFinite(maxPerIp) && maxPerIp > 0 ? maxPerIp : Infinity;
  const domCap = Number.isFinite(maxPerDomain) && maxPerDomain > 0 ? maxPerDomain : Infinity;

  const picked = [];
  const used = new Set();
  const counts = new Map();
  const domCounts = new Map();

  /**
   * 制約を段階的に緩めながら埋める。
   * pass1: IP分散 + 同一サイト制限（理想）
   * pass2: IP分散のみ（同一サイトを許容）
   * pass3: 制約なし（とにかく limit 件そろえる）
   * @param {boolean} useIpCap
   * @param {boolean} useDomCap
   */
  const fill = (useIpCap, useDomCap) => {
    for (const item of list) {
      if (picked.length >= limit) break;
      if (used.has(item)) continue;
      const key = primaryIp(item);
      const dom = itemDomain(item);
      if (useIpCap && (counts.get(key) || 0) >= cap) continue;
      if (useDomCap && dom && (domCounts.get(dom) || 0) >= domCap) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
      if (dom) domCounts.set(dom, (domCounts.get(dom) || 0) + 1);
      picked.push(item);
      used.add(item);
    }
  };

  // 同一サイトの記事でランキングが埋まるのを防ぐ
  // （同じサービスの類似プレスリリースが1位と3位に並ぶ、といった事故を避ける）
  fill(true, true);
  if (picked.length < limit) fill(true, false);
  if (picked.length < limit) fill(false, false);

  return picked;
}
