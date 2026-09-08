/* ==========================================================================
   TCGウォッチ — app.js
   素の Vanilla JS (ESM)。ビルドツール・npm依存・外部CDN 一切なし。
   ========================================================================== */

import {
  FEED_URL,
  FALLBACK_FEED_URL,
  APP_NAME,
  APP_VERSION,
  REFRESH_INTERVAL_MS,
  STORAGE_KEY_FEED,
  STORAGE_KEY_FILTERS,
  STORAGE_KEY_A2HS,
  IP_LABELS,
  IP_ORDER,
  LOTTERY_TAGS,
  PAGE_SIZE,
  STALE_HOURS,
  freshnessLevel,
  SHOPS_URL,
  SHOPS_CONFIG,
} from './config.js';

import {
  PROFILE_FIELDS,
  PROFILE_GROUPS,
  loadProfile,
  saveProfile,
  clearProfile,
  hasProfile,
  normalizeProfile,
  derivedRows,
  profileSummaryText,
  loadShopStatus,
  saveShopStatus,
  normalizeShopStatus,
  normalizeShopList,
  categoryLabels,
  shopStatusSummary,
  unregisteredShopsFor,
  safeShopUrl,
} from './profile.js';

import { encryptJson, decryptJson, isEncryptedBackup } from './crypto.js';

/* ---------------------------------------------------------------
   DOM 参照
   --------------------------------------------------------------- */
const $ = (id) => document.getElementById(id);

const el = {
  hdr: $('hdr'),
  appName: $('appName'),
  hdrUpdated: $('hdrUpdated'),
  btnRefresh: $('btnRefresh'),
  ptr: $('ptr'),

  a2hs: $('a2hs'),
  a2hsText: $('a2hsText'),
  a2hsInstall: $('a2hsInstall'),
  a2hsClose: $('a2hsClose'),

  secApply: $('secApply'),
  applyCount: $('applyCount'),
  applyList: $('applyList'),

  secRanking: $('secRanking'),
  rankDate: $('rankDate'),
  rankList: $('rankList'),
  rankTweet: $('rankTweet'),

  secFeed: $('secFeed'),
  filters: $('filters'),
  hdrChips: document.querySelector('.hdr__chips'),
  ipChips: $('ipChips'),
  lotteryOnly: $('lotteryOnly'),
  showExpired: $('showExpired'),
  sortLatest: $('sortLatest'),
  sortDeadline: $('sortDeadline'),
  btnClearFilters: $('btnClearFilters'),

  feedCount: $('feedCount'),
  skeleton: $('skeleton'),
  cards: $('cards'),
  empty: $('empty'),
  emptyText: $('emptyText'),
  btnEmptyClear: $('btnEmptyClear'),
  btnMore: $('btnMore'),

  errorBox: $('errorBox'),
  errorMsg: $('errorMsg'),
  btnRetry: $('btnRetry'),

  ftrUpdated: $('ftrUpdated'),
  ftrVer: $('ftrVer'),
  toast: $('toast'),

  // 未登録ショップの警告
  btnProfile: $('btnProfile'),
  profileDot: $('profileDot'),
  secWarn: $('secWarn'),
  warnList: $('warnList'),
  btnWarnOpen: $('btnWarnOpen'),

  // ボトムシート
  sheet: $('sheet'),
  sheetScrim: $('sheetScrim'),
  sheetClose: $('sheetClose'),
  sheetBody: $('sheetBody'),
  tabShops: $('tabShops'),
  tabProfile: $('tabProfile'),
  paneShops: $('paneShops'),
  paneProfile: $('paneProfile'),

  // 登録チェックリスト
  shopCount: $('shopCount'),
  shopUnregOnly: $('shopUnregOnly'),
  shopList: $('shopList'),

  // マイ情報
  profileForm: $('profileForm'),
  btnProfileSave: $('btnProfileSave'),
  btnProfileCopyAll: $('btnProfileCopyAll'),
  btnProfileClear: $('btnProfileClear'),
  derivedList: $('derivedList'),

  // 暗号化バックアップ
  bkPass1: $('bkPass1'),
  bkPass2: $('bkPass2'),
  btnExport: $('btnExport'),
  bkExportMsg: $('bkExportMsg'),
  bkOutWrap: $('bkOutWrap'),
  bkOutNote: $('bkOutNote'),
  bkOut: $('bkOut'),
  btnExportCopy: $('btnExportCopy'),
  bkFile: $('bkFile'),
  bkIn: $('bkIn'),
  bkPass3: $('bkPass3'),
  btnImport: $('btnImport'),
  bkImportMsg: $('bkImportMsg'),
  bkConfirm: $('bkConfirm'),
  bkPreview: $('bkPreview'),
  btnImportApply: $('btnImportApply'),
  btnImportCancel: $('btnImportCancel'),
};

/* ---------------------------------------------------------------
   アプリ状態
   --------------------------------------------------------------- */
const state = {
  /** @type {object|null} feed.json 全体 */
  feed: null,
  /** @type {Array<object>} publishedAt 降順の items */
  items: [],
  /** @type {Set<string>} 選択中のIPキー */
  selectedIps: new Set(),
  /** @type {{visible:Map<string,number>, total:Map<string,number>}|null} ジャンル別の件数 */
  ipCounts: null,
  lotteryOnly: false,
  /** 'latest'（既定） | 'deadline' */
  sortMode: 'latest',
  /** 締切切れを一覧に出すか（既定は非表示） */
  showExpired: false,
  visibleCount: PAGE_SIZE,
  loading: false,
  /** 最後に取得に成功した時刻(ms) */
  lastFetchedAt: 0,
  /** データの出所表示用 */
  origin: '',

  /** チェックリスト用のショップ一覧（config/shops.json 由来） */
  shops: [],
  /** カテゴリキー → 表示名 */
  shopCategories: {},
  /** { [shopId]: true } 登録済みの店 */
  shopStatus: {},
  /** マイ情報（端末内のみ） */
  profile: {},
  /** 「未登録のみ」表示 */
  shopUnregOnly: false,
  /** 復元待ちのバックアップ内容（ユーザーの確認前） */
  pendingRestore: null,
};

/* ---------------------------------------------------------------
   ユーティリティ
   --------------------------------------------------------------- */

/** HTMLエスケープ（innerHTML を使う箇所は必ずここを通す） */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 相対時刻を日本語で返す（「3分前」「2時間前」「昨日」「8/21」） */
export function formatRelative(iso, now = new Date()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';

  const then = new Date(t);
  const diffSec = Math.floor((now.getTime() - t) / 1000);

  // 未来（時計ズレ等）
  if (diffSec < -60) return formatShortDate(then);
  if (diffSec < 60) return 'たった今';

  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}分前`;

  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}時間前`;

  // 暦日ベースで「昨日」を判定
  const dayDiff = daysBetween(then, now);
  if (dayDiff === 1) return '昨日';
  if (dayDiff === 2) return '一昨日';

  return formatShortDate(then, now);
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function daysBetween(a, b) {
  return Math.round((startOfDay(b) - startOfDay(a)) / 86400000);
}

function formatShortDate(d, now = new Date()) {
  const sameYear = d.getFullYear() === now.getFullYear();
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  return sameYear ? md : `${d.getFullYear()}/${md}`;
}

/** 「2026/8/23 18:05」形式 */
function formatDateTime(value) {
  const t = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(t)) return '—';
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ---------------------------------------------------------------
   締切の見せ方（src/report.js の deadlineBadge と同じルール）
   --------------------------------------------------------------- */
const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * 締切までの残り時間を1語にする。deadline が無ければ null（=バッジを出さない）。
 * @returns {{state:'expired'|'urgent'|'soon'|'near'|'far', text:string}|null}
 */
export function deadlineBadge(deadline, now = new Date()) {
  const t = Date.parse(deadline);
  if (!Number.isFinite(t)) return null;
  const diff = t - now.getTime();
  if (diff <= 0) return { state: 'expired', text: '受付終了' };
  if (diff < HOUR_MS) return { state: 'urgent', text: 'まもなく締切' };
  if (diff < DAY_MS) return { state: 'soon', text: `あと${Math.max(1, Math.floor(diff / HOUR_MS))}時間` };
  if (diff < 7 * DAY_MS) return { state: 'near', text: `あと${Math.max(1, Math.floor(diff / DAY_MS))}日` };
  const d = new Date(t);
  return { state: 'far', text: `${d.getMonth() + 1}/${d.getDate()}まで` };
}

/** 締切切れか（deadline が無ければ false） */
function isExpired(item, now = new Date()) {
  const b = deadlineBadge(item && item.deadline, now);
  return b ? b.state === 'expired' : false;
}

/** 応募ページがあり、締切切れでない */
function isApplyOpen(item, now = new Date()) {
  if (!safeUrl(item && item.destUrl)) return false;
  // 「受付中だと言える根拠」があるものだけを出す。根拠は2つのどちらか。
  //   1. 店が公表している受付情報を取得できた（applyVerified）
  //   2. 締切日時が明示されていて、まだ過ぎていない
  // 根拠が無いもの（店の一覧に載っているだけ）は出さない。
  const hasStatedDeadline = Number.isFinite(Date.parse(item.deadline));
  if (item.applyVerified !== true && !hasStatedDeadline) return false;
  // 受付開始前は「いま応募できる」ではない。
  // 開始前にリンクを踏むと店側で「エントリー期間外」と出て、応募できたつもりで取り逃す。
  if (isApplyUpcoming(item, now)) return false;
  return !isExpired(item, now);
}

/** 受付開始前か（開始日時が未来） */
function isApplyUpcoming(item, now = new Date()) {
  const t = Date.parse(item && item.startsAt);
  if (!Number.isFinite(t)) return false;
  return t > (now instanceof Date ? now.getTime() : Number(now) || Date.now());
}

/** 締切のエポックms（無効なら Infinity＝末尾） */
function deadlineValue(item) {
  const t = Date.parse(item && item.deadline);
  return Number.isFinite(t) ? t : Infinity;
}

/** 「8/28 12:00」 */
function formatShortDateTime(value) {
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 飛び先の表示名。destLabel が無ければドメイン */
function destinationName(item) {
  const label = String((item && item.destLabel) || '').trim();
  if (label) return label;
  const url = safeUrl(item && item.destUrl);
  if (!url) return '応募ページ';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '応募ページ';
  }
}

/** 主リンク先: 応募ページがあればそちら、無ければ記事 */
function primaryUrl(item) {
  return safeUrl(item && item.destUrl) || safeUrl(item && item.url) || null;
}

/** 締切バッジ要素（deadline が無ければ null） */
function buildDeadlineBadge(item) {
  const b = deadlineBadge(item && item.deadline);
  if (!b) return null;
  const span = document.createElement('span');
  span.className = `dl dl--${b.state}`;
  span.textContent = b.text;
  if (item.deadline) span.title = `締切 ${formatShortDateTime(item.deadline)}`;
  return span;
}

/* ---------------------------------------------------------------
   情報の鮮度（いつ時点の情報か）

   店の商品ページは中身が変わる。実際に、店が購入制限を 6BOX → 4BOX に
   変えたのに、こちらは 6BOX のまま出していたことがある。
   店由来の項目は「取得してから何時間たったか」を必ず添え、
   一定時間を過ぎたものは押す前に注意できるようにする。
   ニュース記事は publishedAt が「書かれた日」なので、この扱いはしない。
   --------------------------------------------------------------- */

/**
 * 店由来の項目の鮮度。対象外なら null。
 * @param {any} item
 * @param {Date} [now]
 * @returns {{level:'fresh'|'aging'|'stale', hours:number, text:string, note:string}|null}
 */
export function freshness(item, now = new Date()) {
  if (!item || item.tier !== 'shop') return null;
  const t = Date.parse(item.publishedAt);
  if (!Number.isFinite(t)) return null;

  const nowMs = now instanceof Date ? now.getTime() : Number(now) || Date.now();
  const hours = (nowMs - t) / HOUR_MS;
  // 時計ズレなどで未来になっている場合は「取得したて」と同じ扱い
  const level = freshnessLevel(hours);
  const rel = formatRelative(item.publishedAt, now) || 'たった今';
  const asOf = `${formatDateTime(item.publishedAt)} 時点の店の情報です`;

  return {
    level,
    hours,
    text: level === 'fresh' ? `${rel}に取得` : `${rel}の情報`,
    note:
      level === 'stale'
        ? `${asOf}。購入制限や在庫が変わっている可能性があります。押す前に店のページで確認してください`
        : asOf,
  };
}

/**
 * 取得から時間がたった店の情報につける注意バッジ。
 * 新しいうちは出さない（毎回出ると読み飛ばされ、肝心なときに効かなくなる）。
 */
function buildFreshnessBadge(item, now = new Date()) {
  const f = freshness(item, now);
  if (!f || f.level !== 'stale') return null;
  const span = document.createElement('span');
  span.className = 'dl dl--stale';
  span.textContent = `${f.text}・要確認`;
  span.title = f.note;
  return span;
}

/** 受付開始が未来なら「まだ応募できない」ことを示すバッジ */
function buildStartsBadge(item) {
  const t = Date.parse(item && item.startsAt);
  if (!Number.isFinite(t) || t <= Date.now()) return null;
  const span = document.createElement('span');
  span.className = 'dl dl--start';
  span.textContent = `${formatShortDateTime(item.startsAt)} 受付開始`;
  return span;
}

/** 応募ボタン（destUrl が無ければ null）。カード内で最も目立つ要素。 */
function buildApplyButton(item) {
  const url = safeUrl(item && item.destUrl);
  if (!url) return null;
  const a = document.createElement('a');
  a.className = 'apply';
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  const label = String((item && item.destLabel) || '').trim();
  // 受付中だと確認できていないものを「応募」と書くと、
  // 飛んだ先が期間外・売り切れだったときに裏切りになる。
  // 確認できているものだけ「応募」、それ以外は「確認」と表現を分ける。
  const verified = item && item.applyVerified === true;
  const isEntry = item && item.destIsEntry === true;
  // 商品ページが取れず店の入口だけ案内する場合は、そうと分かる文言にする。
  // 「商品ページに飛ぶ」と思って押した先が店のトップだと裏切りになる。
  const verb = isEntry ? '探す' : verified ? '応募' : '確認';
  a.textContent = label
    ? `${label}で${verb}`
    : isEntry ? '店のページへ' : verified ? '応募ページへ' : '商品ページを確認';
  if (!verified || isEntry) a.classList.add('apply--unverified');
  if (isEntry) a.classList.add('apply--entry');
  a.setAttribute(
    'aria-label',
    `${item.title || ''} — ${destinationName(item)}の${verified ? '応募ページ' : '商品ページ'}を開く`
  );
  const arrow = document.createElement('span');
  arrow.className = 'apply__arrow';
  arrow.setAttribute('aria-hidden', 'true');
  arrow.textContent = '→';
  a.appendChild(arrow);

  // 同じ商品を他の店でも応募できる場合は、その数を示す。
  // 抽選は応募する店を増やすほど当たるので、ここは価値のある情報。
  const others = Array.isArray(item.otherShops) ? item.otherShops.filter((o) => safeUrl(o.url)) : [];
  if (others.length) {
    const more = document.createElement('details');
    more.className = 'others';
    const sum = document.createElement('summary');
    sum.textContent = `ほか${others.length}店でも応募できます`;
    more.appendChild(sum);
    const ul = document.createElement('ul');
    ul.className = 'others__list';
    for (const o of others) {
      const li = document.createElement('li');
      const link = document.createElement('a');
      link.href = safeUrl(o.url);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = o.label;
      link.setAttribute('aria-label', `${item.title || ''} — ${o.label}の応募ページを開く`);
      li.appendChild(link);
      ul.appendChild(li);
    }
    more.appendChild(ul);
    a.after(more);
  }
  return a;
}

/** 「記事を読む」副リンク（ニュース自体も価値があるので必ず残す） */
function buildReadMore(item) {
  const url = safeUrl(item && item.url);
  if (!url) return null;
  const a = document.createElement('a');
  a.className = 'card__read';
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = '記事を読む ↗';
  a.setAttribute('aria-label', `${item.title || ''} — 記事を読む`);
  return a;
}

/** intentTag → CSS修飾子 */
function tagModifier(tag) {
  if (tag === '抽選') return 'tag--lottery';
  if (tag === '予約' || tag === '受付') return 'tag--reserve';
  if (tag === '再販') return 'tag--restock';
  return '';
}

/** items の先頭IPからアクセントカラー変数を決める */
function ipAccentVar(ips) {
  const key = Array.isArray(ips) ? ips.find((k) => IP_LABELS[k]) : null;
  return key ? `var(--ip-${key})` : 'var(--ip-default)';
}

/** IPキー配列 → 表示ラベル配列（未知キーはそのまま） */
function ipLabels(ips) {
  if (!Array.isArray(ips)) return [];
  return ips.map((k) => IP_LABELS[k] || k);
}

function toast(message) {
  el.toast.hidden = false;
  el.toast.textContent = message;
  // reflow してからクラス付与（連続表示でもアニメーションする）
  void el.toast.offsetWidth;
  el.toast.classList.add('is-visible');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    el.toast.classList.remove('is-visible');
    setTimeout(() => { el.toast.hidden = true; }, 250);
  }, 2000);
}

/** localStorage（プライベートブラウズ等で例外になっても落とさない） */
const storage = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* 無視 */ }
  },
};

/* ---------------------------------------------------------------
   データ取得
   --------------------------------------------------------------- */

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-cache', credentials: 'omit' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

/** feed.json の形をゆるく検証して正規化 */
function normalizeFeed(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('不正なフィード形式です');
  const items = Array.isArray(raw.items) ? raw.items.filter((i) => i && typeof i === 'object') : [];
  const ranking = raw.ranking && typeof raw.ranking === 'object' ? raw.ranking : null;
  const top = ranking && Array.isArray(ranking.top) ? ranking.top.filter(Boolean) : [];

  // 念のためクライアント側でも publishedAt 降順にソート
  items.sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0));
  top.sort((a, b) => (Number(a.rank) || 99) - (Number(b.rank) || 99));

  return {
    version: raw.version ?? 1,
    generatedAt: raw.generatedAt || null,
    ranking: ranking ? { date: ranking.date || '', tweetUrl: ranking.tweetUrl || null, top } : null,
    items,
  };
}

/**
 * FEED_URL → FALLBACK_FEED_URL → localStorage の順にフォールバック。
 * 成功時は localStorage に保存する。
 */
async function loadFeed({ silent = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  el.btnRefresh.classList.add('is-spinning');
  if (!silent && !state.feed) {
    el.secFeed.hidden = false;
    showSkeleton(true);
  }
  el.errorBox.hidden = true;

  const errors = [];

  for (const [url, origin] of [[FEED_URL, 'network'], [FALLBACK_FEED_URL, 'sample']]) {
    try {
      const feed = normalizeFeed(await fetchJson(url));
      applyFeed(feed, origin);
      storage.set(STORAGE_KEY_FEED, JSON.stringify({ savedAt: Date.now(), feed }));
      state.lastFetchedAt = Date.now();
      finishLoading();
      return;
    } catch (err) {
      errors.push(`${url}: ${err && err.message ? err.message : err}`);
    }
  }

  // キャッシュへフォールバック
  const cached = storage.get(STORAGE_KEY_FEED);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      applyFeed(normalizeFeed(parsed.feed), 'cache');
      finishLoading();
      if (!silent) toast('オフラインのため保存済みデータを表示中');
      return;
    } catch (err) {
      errors.push(`cache: ${err && err.message ? err.message : err}`);
    }
  }

  showSkeleton(false);
  finishLoading();

  if (state.feed) {
    // すでに表示中のデータがあるなら画面は壊さず、トーストだけ出す
    if (!silent) toast('更新できませんでした');
    return;
  }
  // 表示できるデータが一切ない場合だけエラー画面に切り替える
  el.secFeed.hidden = true;
  el.filters.hidden = true;
  if (el.hdrChips) el.hdrChips.hidden = true;
  el.errorBox.hidden = false;
  el.errorMsg.textContent = errors.join(' / ');
}

function finishLoading() {
  state.loading = false;
  el.btnRefresh.classList.remove('is-spinning');
}

function applyFeed(feed, origin) {
  state.feed = feed;
  state.items = feed.items;
  state.origin = origin;
  state.visibleCount = PAGE_SIZE;
  showSkeleton(false);
  el.secFeed.hidden = false;
  el.filters.hidden = false;
  if (el.hdrChips) el.hdrChips.hidden = false;
  renderAll();
}

function showSkeleton(on) {
  el.skeleton.hidden = !on;
  el.cards.hidden = on;
}

/* ---------------------------------------------------------------
   描画
   --------------------------------------------------------------- */

function renderAll() {
  renderHeader();
  renderWarn();
  renderApply();
  renderRanking();
  renderChips();
  renderCards();
  renderFooter();
}

function renderHeader() {
  const gen = state.feed && state.feed.generatedAt;
  const t = Date.parse(gen);
  const ageMs = Number.isFinite(t) ? Date.now() - t : NaN;
  const stale = Number.isFinite(ageMs) && ageMs >= STALE_HOURS * HOUR_MS;

  // 日時だけだと「それが古いのか」が分からないので、経過時間も添える。
  // ヘッダーは幅が狭く、長いと右端で切れて肝心の警告が消えるため、
  // 古いときは日時を落として「いつの情報か」と警告だけを残す（日時は title に）。
  const age = gen ? formatRelative(gen) : '';
  const label = !gen
    ? '最終更新 —'
    : stale
      ? `最終更新 ${age} · 情報が古い可能性`
      : `最終更新 ${formatDateTime(gen)}${age ? `（${age}）` : ''}`;
  const suffix = state.origin === 'cache' ? '（保存済み）' : state.origin === 'sample' ? '（サンプル）' : '';

  el.hdrUpdated.textContent = label + suffix;
  el.hdrUpdated.classList.toggle('is-stale', stale);
  el.hdrUpdated.title = stale
    ? `${formatDateTime(gen)} に取得。時間がたっています。右上の更新ボタンで取り直せます`
    : '';
}

function renderFooter() {
  const gen = state.feed && state.feed.generatedAt;
  el.ftrUpdated.textContent = gen ? `最終更新: ${formatDateTime(gen)}` : '';
  el.ftrVer.textContent = `${APP_NAME} v${APP_VERSION}`;
}

/* ---------- ランキング ---------- */
function renderRanking() {
  const ranking = state.feed && state.feed.ranking;
  const top = ranking ? ranking.top.slice(0, 3) : [];

  if (!top.length) {
    el.secRanking.hidden = true;
    return;
  }
  el.secRanking.hidden = false;
  el.rankDate.textContent = ranking.date || '';

  el.rankList.replaceChildren(...top.map((item, idx) => buildRankCard(item, item.rank || idx + 1)));

  const tweetUrl = ranking.tweetUrl;
  if (tweetUrl && /^https?:\/\//i.test(tweetUrl)) {
    el.rankTweet.hidden = false;
    el.rankTweet.href = tweetUrl;
  } else {
    el.rankTweet.hidden = true;
    el.rankTweet.removeAttribute('href');
  }
}

function buildRankCard(item, rank) {
  // 中にリンク（チップ・応募ボタン）を置くため、外枠は <a> ではなく <article>
  const card = document.createElement('article');
  card.className = `rank-card rank-card--${rank}`;
  card.style.setProperty('--ip-accent', ipAccentVar(item.ips));
  if (isExpired(item)) card.classList.add('is-expired');

  const head = document.createElement('div');
  head.className = 'rank-card__head';

  const medal = document.createElement('span');
  medal.className = `medal medal--${rank}`;
  medal.textContent = rank === 1 ? '🥇 1位' : rank === 2 ? '🥈 2位' : rank === 3 ? '🥉 3位' : `${rank}位`;
  head.appendChild(medal);

  const dl = buildDeadlineBadge(item);
  if (dl) head.appendChild(dl);
  const st = buildStartsBadge(item);
  if (st) head.appendChild(st);
  const stale = buildFreshnessBadge(item);
  if (stale) head.appendChild(stale);

  for (const label of ipLabels(item.ips).slice(0, 2)) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.style.setProperty('--ip-accent', ipAccentVar(item.ips));
    badge.textContent = label;
    head.appendChild(badge);
  }

  for (const tag of (item.intentTags || []).slice(0, 3)) {
    head.appendChild(buildTag(tag, item));
  }

  const title = buildTitle(item, 'h3', 'rank-card__title');

  const meta = document.createElement('div');
  meta.className = 'rank-card__meta';
  meta.appendChild(textSpan(item.sourceName || '出典不明'));
  meta.appendChild(sep());
  const rankFresh = freshness(item);
  meta.appendChild(textSpan(rankFresh ? rankFresh.text : formatRelative(item.publishedAt)));

  card.append(head, title, meta);

  const apply = buildApplyButton(item);
  if (apply) {
    const cta = document.createElement('div');
    cta.className = 'cta';
    cta.appendChild(apply);
    const read = buildReadMore(item);
    if (read) cta.appendChild(read);
    card.appendChild(cta);
  }

  attachCardTap(card, item);
  return card;
}

/** カードのどこをタップしても主リンク（応募ページ or 記事）を開く */
function attachCardTap(root, item) {
  root.addEventListener('click', (ev) => {
    if (ev.target.closest('a, button')) return;
    const url = primaryUrl(item);
    if (url) openExternal(url);
  });
}

/* ---------- フィルタチップ ---------- */

/**
 * 生成済みのチップ要素。key -> { btn, count }
 *
 * チップは毎回作り直さず、件数と状態だけ書き換える。
 * 作り直すと横スクロールの位置が先頭に戻ってしまい、
 * 「押した拍子に見ていた場所が飛ぶ」ことになるため。
 */
const chipEls = new Map();

/**
 * ジャンルのチップを描く。
 *
 * ここは以前「フィードに含まれるジャンルだけ」を出していた。
 * その結果「今日はドラゴンボールの記事が無い」だけでバッジ自体が消え、
 * 利用者からは機能が壊れたように見えていた。
 * いまは全17ジャンル（CONTRACT.md の対象IP）を常に出し、
 * 0件は淡色＋件数「0」で「今は情報が無いだけ」と分かるようにしている。
 */
function renderChips() {
  chipEls.clear();

  el.ipChips.replaceChildren(...IP_ORDER.map((key) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.dataset.ip = key;
    btn.style.setProperty('--ip-accent', `var(--ip-${key})`);
    btn.setAttribute('aria-pressed', String(state.selectedIps.has(key)));

    const dot = document.createElement('span');
    dot.className = 'chip__dot';
    const label = document.createElement('span');
    label.className = 'chip__label';
    label.textContent = IP_LABELS[key] || key;
    const count = document.createElement('span');
    count.className = 'chip__count';
    count.textContent = '0';
    btn.append(dot, label, count);

    btn.addEventListener('click', () => {
      // 0件のチップは押しても一覧が空になるだけなので、選択させず理由を出す。
      // 「押したのに何も出ない」という行き止まりを作らないため。
      if (!state.selectedIps.has(key) && ipCount(key).visible === 0) {
        toast(emptyChipMessage(key));
        return;
      }
      if (state.selectedIps.has(key)) state.selectedIps.delete(key);
      else state.selectedIps.add(key);
      state.visibleCount = PAGE_SIZE;
      saveFilters();
      renderFilterDependent();
    });

    chipEls.set(key, { btn, count });
    return btn;
  }));

  updateChips();

  updateClearButton();
}

/**
 * 各ジャンルの件数を数える。
 *   visible … いまの絞り込み（抽選・予約のみ / 終了分）で実際に出る件数＝チップに出す数
 *   total   … その絞り込みを外したときの件数＝0件の理由を説明するための数
 * ジャンルの選択自体は数えない。チップは足し算なので、他を選んでも件数は減らないため。
 */
function countIps() {
  const now = new Date();
  const visible = new Map();
  const total = new Map();
  for (const item of state.items) {
    const ok = passesNonIpFilters(item, now);
    for (const ip of item.ips || []) {
      total.set(ip, (total.get(ip) || 0) + 1);
      if (ok) visible.set(ip, (visible.get(ip) || 0) + 1);
    }
  }
  return { visible, total };
}

/** そのジャンルの件数（updateChips で数えた最新の値） */
function ipCount(key) {
  const c = state.ipCounts;
  return {
    visible: (c && c.visible.get(key)) || 0,
    total: (c && c.total.get(key)) || 0,
  };
}

/** 0件のチップを押したときの説明。行き止まりにしないための文言 */
function emptyChipMessage(key) {
  const label = IP_LABELS[key] || key;
  const { total } = ipCount(key);
  if (total > 0) {
    const why = state.lotteryOnly ? '「抽選・予約のみ」' : '「終了分を隠す」設定';
    return `${label}は${why}のため0件です。外すと${total}件あります`;
  }
  return `${label}は今回の更新に情報がありません`;
}

/** チップの件数・押せるかどうかを更新する（要素は作り直さない） */
function updateChips() {
  if (!chipEls.size) return;
  const counts = countIps();
  state.ipCounts = counts;

  for (const [key, refs] of chipEls) {
    const label = IP_LABELS[key] || key;
    const n = counts.visible.get(key) || 0;
    const total = counts.total.get(key) || 0;
    const selected = state.selectedIps.has(key);

    refs.count.textContent = String(n);
    refs.btn.setAttribute('aria-pressed', String(selected));

    // 0件でもチップは消さない（消えると「壊れた」ように見える）。
    // 淡色＋件数0で状態を示し、押しても選択はさせない。
    const empty = n === 0 && !selected;
    refs.btn.classList.toggle('is-empty', empty);
    if (empty) refs.btn.setAttribute('aria-disabled', 'true');
    else refs.btn.removeAttribute('aria-disabled');

    refs.btn.setAttribute('aria-label', `${label} ${n}件`);
    refs.btn.title = empty
      ? (total > 0 ? `${label}: いまの絞り込みでは0件（外すと${total}件）` : `${label}: 今回の更新には情報がありません`)
      : `${label} ${n}件`;
  }
}

function updateClearButton() {
  el.btnClearFilters.hidden = state.selectedIps.size === 0 && !state.lotteryOnly;
}

/* ---------- カード一覧 ---------- */

/** ジャンル以外の絞り込み（抽選・予約のみ / 終了分を隠す）を通るか */
function passesNonIpFilters(item, now = new Date()) {
  if (state.lotteryOnly) {
    const tags = item.intentTags || [];
    if (!tags.some((t) => LOTTERY_TAGS.includes(t))) return false;
  }
  // 締切切れは既定で非表示（「終了分も表示」でオンにできる）
  if (!state.showExpired && isExpired(item, now)) return false;
  return true;
}

function filteredItems() {
  const now = new Date();
  const list = state.items.filter((item) => {
    if (state.selectedIps.size) {
      const ips = item.ips || [];
      if (!ips.some((ip) => state.selectedIps.has(ip))) return false;
    }
    return passesNonIpFilters(item, now);
  });

  if (state.sortMode === 'deadline') {
    // 締切が近い順。締切不明のものは末尾に、その中では新しい順。
    list.sort((a, b) => {
      const va = deadlineValue(a);
      const vb = deadlineValue(b);
      if (va !== vb) return va - vb;
      return (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0);
    });
  }
  return list;
}

/** この時間内に締切を迎えるものは、並び順に関係なく先頭に出す */
const URGENT_HOURS = 24;

/**
 * いま応募できるもの（destUrl あり・締切切れでない）。
 * 画面上部のIPフィルタと並び替えに連動する。
 * 連動しないと「ポケカで絞ったのに他のゲームが出ている」状態になり、
 * フィルタが壊れているように見えるため。
 */
function applicableItems() {
  const now = new Date();
  const seen = new Set();
  const out = [];
  const ranked = (state.feed && state.feed.ranking && state.feed.ranking.top) || [];
  for (const item of [...ranked, ...state.items]) {
    if (!item || typeof item !== 'object') continue;
    if (!isApplyOpen(item, now)) continue;
    // IPフィルタを適用（「抽選・予約のみ」は応募可能な時点で自明なので見ない）
    if (state.selectedIps.size) {
      const ips = item.ips || [];
      if (!ips.some((ip) => state.selectedIps.has(ip))) continue;
    }
    const key = item.id || safeUrl(item.destUrl) || item.title;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  if (state.sortMode === 'latest') {
    // 「最新順」を選んでいるときはこちらもそれに従う。
    // ただし締切が24時間以内のものだけは、並び順に関係なく先頭へ出す。
    // この欄の目的は「締切に間に合わせること」なので、
    // 新着に押されて今日締切の案件が下に沈むのは避ける。
    const urgent = [];
    const rest = [];
    for (const it of out) {
      const v = deadlineValue(it);
      const hours = Number.isFinite(v) ? (v - now.getTime()) / 3600000 : Infinity;
      (hours <= URGENT_HOURS ? urgent : rest).push(it);
    }
    const byNew = (a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0);
    urgent.sort((a, b) => deadlineValue(a) - deadlineValue(b));
    rest.sort(byNew);
    out.length = 0;
    out.push(...urgent, ...rest);
  } else {
    out.sort((a, b) => {
      const va = deadlineValue(a);
      const vb = deadlineValue(b);
      if (va !== vb) return va - vb;
      return (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0);
    });
  }
  return out;
}

function renderApply() {
  const list = applicableItems();
  if (!list.length) {
    // 絞り込みの結果0件になった場合は、黙って消さずに理由を伝える。
    // セクションごと消すと、古い件数表示が残って矛盾して見えるうえ、
    // 利用者は「壊れた」のか「該当が無い」のか区別できない。
    if (state.selectedIps.size) {
      el.secApply.hidden = false;
      el.applyCount.textContent = '絞り込み中 · 0件';
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = '選んだジャンルに、いま応募できるものはありません。';
      el.applyList.replaceChildren(p);
      return;
    }
    el.secApply.hidden = true;
    el.applyList.replaceChildren();
    return;
  }
  el.secApply.hidden = false;
  const now = new Date();
  const urgentCount = list.filter((it) => {
    const v = deadlineValue(it);
    return Number.isFinite(v) && (v - now.getTime()) / 3600000 <= URGENT_HOURS;
  }).length;
  const order = state.sortMode === 'latest' ? '新着順' : '締切が近い順';
  const filtered = state.selectedIps.size ? '絞り込み中 · ' : '';
  const urgent = urgentCount > 0 ? ` · まもなく締切${urgentCount}件` : '';
  el.applyCount.textContent = `${filtered}${list.length}件 · ${order}${urgent}`;
  el.applyList.replaceChildren(...list.slice(0, 12).map(buildCard));
}

/**
 * IPフィルタ・並び替えの変更で描き直す必要がある領域。
 * 「いま応募できる」欄もこれらに連動するので、カード一覧と一緒に更新する。
 */
function renderFilterDependent() {
  renderApply();
  renderCards();
}

function renderCards() {
  const list = filteredItems();
  const shown = list.slice(0, state.visibleCount);

  el.cards.replaceChildren(...shown.map(buildCard));
  el.cards.hidden = shown.length === 0;
  el.empty.hidden = list.length !== 0;
  if (list.length === 0) renderEmptyState();
  el.btnMore.hidden = list.length <= state.visibleCount;

  const remaining = list.length - shown.length;
  el.btnMore.textContent = remaining > 0
    ? `もっと見る（あと${remaining}件）`
    : 'もっと見る';

  el.feedCount.textContent = list.length === state.items.length
    ? `${state.items.length}件`
    : `${list.length} / ${state.items.length}件`;

  // チップの件数は「抽選・予約のみ」「終了分」の切り替えでも変わるので、
  // 一覧を描き直すたびに合わせて更新する。
  updateChips();
  updateClearButton();
}

/**
 * 0件のときの表示。
 * 「該当する情報がありません」で終わると行き止まりになるので、
 * 絞り込みが原因なら、そう書いたうえで解除ボタンを出す。
 */
function renderEmptyState() {
  const filtering = state.selectedIps.size > 0 || state.lotteryOnly || !state.showExpired;
  if (state.selectedIps.size) {
    const names = [...state.selectedIps].map((k) => IP_LABELS[k] || k).join('・');
    el.emptyText.textContent = `${names}は、いまの条件では0件です`;
  } else if (state.lotteryOnly) {
    el.emptyText.textContent = '「抽選・予約のみ」に当てはまる情報がありません';
  } else if (!state.showExpired) {
    el.emptyText.textContent = '受付中の情報がありません（終了分は隠れています）';
  } else {
    el.emptyText.textContent = '該当する情報がありません';
  }
  el.btnEmptyClear.hidden = !filtering;
  el.btnEmptyClear.textContent = state.showExpired || state.selectedIps.size || state.lotteryOnly
    ? '絞り込みを解除する'
    : '終了分も表示する';
}

/** 絞り込みを全部外す（チップの「クリア」と0件表示のボタンで共有） */
function clearAllFilters({ showExpired = false } = {}) {
  state.selectedIps.clear();
  state.lotteryOnly = false;
  el.lotteryOnly.checked = false;
  if (showExpired) {
    state.showExpired = true;
    el.showExpired.checked = true;
  }
  state.visibleCount = PAGE_SIZE;
  saveFilters();
  // チップは作り直さない（横スクロール位置が戻ってしまうため）。
  // 押された状態と件数の更新は renderCards → updateChips が行う。
  renderFilterDependent();
}

function buildCard(item) {
  const article = document.createElement('article');
  article.className = 'card';
  article.style.setProperty('--ip-accent', ipAccentVar(item.ips));
  if (isExpired(item)) article.classList.add('is-expired');

  const tags = document.createElement('div');
  tags.className = 'card__tags';

  // 締切バッジは最も先に。「応募できるか」「いつまでか」を一目で。
  const dl = buildDeadlineBadge(item);
  if (dl) tags.appendChild(dl);
  const st = buildStartsBadge(item);
  if (st) tags.appendChild(st);

  // 商品ページを取得できず、店の入口だけ案内している場合の印。
  // 他のバッジと同じ体裁にして、押す前に行き先の種類が分かるようにする。
  if (item.destIsEntry) {
    const entry = document.createElement('span');
    entry.className = 'tag tag--entry';
    entry.textContent = '店から探す';
    entry.title = '商品ページへ直接飛べないため、お店の入口を案内しています';
    tags.appendChild(entry);
  }

  // 取得から時間がたった店の情報。押す前に「変わっているかも」と分かるようにする
  const stale = buildFreshnessBadge(item);
  if (stale) tags.appendChild(stale);

  if (item.isRanked && item.rank) {
    const medal = document.createElement('span');
    medal.className = `medal medal--${item.rank}`;
    medal.textContent = item.rank === 1 ? '🥇' : item.rank === 2 ? '🥈' : item.rank === 3 ? '🥉' : `${item.rank}位`;
    tags.appendChild(medal);
  }

  for (const label of ipLabels(item.ips)) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.style.setProperty('--ip-accent', ipAccentVar([findIpKey(item.ips, label)]));
    badge.textContent = label;
    tags.appendChild(badge);
  }

  for (const tag of item.intentTags || []) {
    tags.appendChild(buildTag(tag, item));
  }

  const title = buildTitle(item, 'h3', 'card__title');

  article.append(tags, title);

  if (item.summary) {
    const summary = document.createElement('p');
    summary.className = 'card__summary';
    summary.textContent = item.summary;
    article.appendChild(summary);
  }

  // 応募ボタン: カード内で最も目立つ要素
  const apply = buildApplyButton(item);
  if (apply) {
    const cta = document.createElement('div');
    cta.className = 'cta';
    cta.appendChild(apply);
    const read = buildReadMore(item);
    if (read) cta.appendChild(read);
    article.appendChild(cta);
  }

  const foot = document.createElement('div');
  foot.className = 'card__foot';

  const meta = document.createElement('div');
  meta.className = 'card__meta';
  const src = document.createElement('span');
  src.className = 'card__src';
  src.textContent = item.sourceName || '出典不明';
  const time = document.createElement('span');
  time.className = 'card__time';
  // 店の情報は「記事の日付」ではなく「いつ取得したか」。
  // 同じ見た目で意味だけ違うと誤読されるので、文言で言い分ける。
  const fresh = freshness(item);
  if (fresh) {
    time.classList.add(`card__time--${fresh.level}`);
    time.textContent = fresh.text;
    time.title = fresh.note;
  } else {
    time.textContent = formatRelative(item.publishedAt);
    time.title = formatDateTime(item.publishedAt);
  }
  meta.append(src, sep(), time);

  foot.appendChild(meta);
  foot.appendChild(buildShareButton(item));

  article.appendChild(foot);

  // カードのどこをタップしても主リンク（応募ページ or 記事）を開く
  attachCardTap(article, item);

  return article;
}

/** ラベルから元のIPキーを引く（バッジ個別の色付け用） */
function findIpKey(ips, label) {
  if (!Array.isArray(ips)) return null;
  return ips.find((k) => (IP_LABELS[k] || k) === label) || null;
}

/**
 * intentTag のチップ。
 * destUrl があるときは「抽選」「予約」チップ自体を応募ページへのリンクにする。
 * destUrl が無いときは押せそうに見えないよう <span> のまま。
 */
function buildTag(tag, item) {
  const dest = safeUrl(item && item.destUrl);
  const mod = tagModifier(tag);
  const cls = mod ? `tag ${mod}` : 'tag';
  if (!dest) {
    const span = document.createElement('span');
    span.className = cls;
    span.textContent = tag;
    return span;
  }
  const a = document.createElement('a');
  a.className = `${cls} tag--link`;
  a.href = dest;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = tag;
  a.setAttribute('aria-label', `${item.title || ''} — ${destinationName(item)}の${tag}ページを開く`);
  return a;
}

/**
 * タイトル。destUrl があればタイトル自体が応募ページへの主リンクになり、
 * 行き先（店名）を必ず併記する（黙って別ドメインに飛ばさない）。
 */
function buildTitle(item, tagName, cls) {
  const heading = document.createElement(tagName);
  heading.className = cls;
  const dest = safeUrl(item && item.destUrl);
  const url = primaryUrl(item);
  const text = item.title || '(タイトルなし)';

  if (!url) {
    heading.textContent = text;
    return heading;
  }
  const a = document.createElement('a');
  a.className = `${cls}__link`;
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = text;
  a.setAttribute(
    'aria-label',
    dest ? `${text} — ${destinationName(item)}の応募ページを開く` : `${text} — 記事を開く`,
  );
  heading.appendChild(a);

  if (dest) {
    heading.classList.add('has-dest');
    const hint = document.createElement('span');
    hint.className = 'dest-hint';
    hint.textContent = `→ ${destinationName(item)}`;
    heading.appendChild(hint);
  }
  return heading;
}

function buildShareButton(item) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'card__share';
  btn.setAttribute('aria-label', 'この記事を共有');

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute(
    'd',
    'M12 2.6l4.2 4.2-1.4 1.4L13 6.4V15h-2V6.4L9.2 8.2 7.8 6.8 12 2.6zM5 12h2v7h10v-7h2v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7z',
  );
  path.setAttribute('fill', 'currentColor');
  svg.appendChild(path);
  btn.appendChild(svg);

  btn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    shareItem(item);
  });

  return btn;
}

async function shareItem(item) {
  const title = item.title || APP_NAME;
  const url = primaryUrl(item) || '';
  if (navigator.share) {
    try {
      await navigator.share({ title, text: title, url });
      return;
    } catch (err) {
      // ユーザーがキャンセルした場合は何もしない
      if (err && err.name === 'AbortError') return;
    }
  }
  const text = url ? `${title}\n${url}` : title;
  toast(await copyText(text) ? 'リンクをコピーしました' : 'コピーできませんでした');
}

/**
 * クリップボードへコピーする。
 * 非同期APIが使えない環境（古いWebView・非セキュアコンテキスト）では
 * 旧 execCommand にフォールバックする。
 * @returns {Promise<boolean>} 成功したか
 */
async function copyText(text) {
  const value = String(text ?? '');
  if (!value) return false;

  // 非同期クリップボードAPI（ユーザー操作直後でないと失敗することがある）
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch { /* 下の旧APIにフォールバック */ }
  }
  // 旧 execCommand によるフォールバック
  try {
    return legacyCopy(value);
  } catch {
    return false;
  }
}

/** @returns {boolean} 成功したか */
function legacyCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, ta.value.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } finally { document.body.removeChild(ta); }
  return ok;
}

/* ---------- 小物 ---------- */
function textSpan(text) {
  const s = document.createElement('span');
  s.textContent = text;
  return s;
}

function sep() {
  const s = document.createElement('span');
  s.className = 'card__sep';
  s.textContent = '·';
  s.setAttribute('aria-hidden', 'true');
  return s;
}

/** 安全なURLだけ href に入れる（javascript: 等を弾く） */
function safeUrl(url) {
  if (typeof url !== 'string') return null;
  return /^https?:\/\//i.test(url.trim()) ? url.trim() : null;
}

function openExternal(url) {
  const safe = safeUrl(url);
  if (safe) window.open(safe, '_blank', 'noopener');
}

/* ---------------------------------------------------------------
   フィルタの永続化
   --------------------------------------------------------------- */
function saveFilters() {
  storage.set(STORAGE_KEY_FILTERS, JSON.stringify({
    ips: [...state.selectedIps],
    lotteryOnly: state.lotteryOnly,
    sortMode: state.sortMode,
    showExpired: state.showExpired,
  }));
}

function restoreFilters() {
  const raw = storage.get(STORAGE_KEY_FILTERS);
  if (!raw) return;
  try {
    const saved = JSON.parse(raw);
    if (Array.isArray(saved.ips)) {
      for (const ip of saved.ips) if (IP_LABELS[ip]) state.selectedIps.add(ip);
    }
    state.lotteryOnly = Boolean(saved.lotteryOnly);
    el.lotteryOnly.checked = state.lotteryOnly;
    state.sortMode = saved.sortMode === 'deadline' ? 'deadline' : 'latest';
    state.showExpired = Boolean(saved.showExpired);
    el.showExpired.checked = state.showExpired;
  } catch { /* 壊れていたら無視 */ }
  syncSortButtons();
}

function syncSortButtons() {
  el.sortLatest.setAttribute('aria-pressed', String(state.sortMode === 'latest'));
  el.sortDeadline.setAttribute('aria-pressed', String(state.sortMode === 'deadline'));
}

function setSortMode(mode) {
  const next = mode === 'deadline' ? 'deadline' : 'latest';
  if (state.sortMode === next) return;
  state.sortMode = next;
  state.visibleCount = PAGE_SIZE;
  syncSortButtons();
  saveFilters();
  renderFilterDependent();
}

/* ---------------------------------------------------------------
   Pull-to-refresh
   --------------------------------------------------------------- */
const PTR_THRESHOLD = 80;
const PTR_MAX = 120;

function setupPullToRefresh() {
  let startY = 0;
  let pulling = false;
  let distance = 0;

  const reset = () => {
    pulling = false;
    distance = 0;
    el.ptr.classList.remove('is-armed');
    el.ptr.style.opacity = '';
    el.ptr.style.transform = '';
  };

  document.addEventListener('touchstart', (ev) => {
    if (state.loading || ev.touches.length !== 1) return;
    if (window.scrollY > 0) return;
    startY = ev.touches[0].clientY;
    pulling = true;
    distance = 0;
  }, { passive: true });

  document.addEventListener('touchmove', (ev) => {
    if (!pulling) return;
    if (window.scrollY > 0) { reset(); return; }

    const dy = ev.touches[0].clientY - startY;
    if (dy <= 0) { reset(); return; }

    // ゴムのように減衰させる
    distance = Math.min(PTR_MAX, dy * 0.55);
    const ratio = Math.min(1, distance / PTR_THRESHOLD);
    el.ptr.style.opacity = String(ratio);
    el.ptr.style.transform = `translateY(${distance * 0.5}px) rotate(${distance * 3}deg)`;
    el.ptr.classList.toggle('is-armed', distance >= PTR_THRESHOLD * 0.62);
  }, { passive: true });

  const end = () => {
    if (!pulling) return;
    const shouldRefresh = distance >= PTR_THRESHOLD * 0.62; // 減衰後の閾値（生の指移動で約80px）
    reset();
    if (shouldRefresh) triggerRefresh();
  };

  document.addEventListener('touchend', end, { passive: true });
  document.addEventListener('touchcancel', end, { passive: true });
}

function triggerRefresh() {
  if (state.loading) return;
  el.ptr.classList.add('is-loading');
  el.ptr.style.opacity = '1';
  el.ptr.style.transform = 'translateY(20px)';
  loadFeed().finally(() => {
    el.ptr.classList.remove('is-loading');
    el.ptr.style.opacity = '';
    el.ptr.style.transform = '';
  });
}

/* ---------------------------------------------------------------
   Service Worker
   --------------------------------------------------------------- */
function registerServiceWorker() {
  if (location.protocol === 'file:') {
    console.info('[TCGウォッチ] file:// のため Service Worker 登録をスキップしました');
    return;
  }
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('[TCGウォッチ] Service Worker 登録に失敗:', err);
    });
  });
}

/* ---------------------------------------------------------------
   ホーム画面に追加（A2HS）
   --------------------------------------------------------------- */
let deferredInstallPrompt = null;

function setupA2HS() {
  const dismissed = storage.get(STORAGE_KEY_A2HS) === '1';

  el.a2hsClose.addEventListener('click', () => {
    el.a2hs.hidden = true;
    storage.set(STORAGE_KEY_A2HS, '1');
  });

  // Android / Chrome: インストールプロンプトを捕まえる
  window.addEventListener('beforeinstallprompt', (ev) => {
    ev.preventDefault();
    deferredInstallPrompt = ev;
    if (storage.get(STORAGE_KEY_A2HS) === '1') return;
    el.a2hsText.textContent = 'ホーム画面に追加すると、アプリのように全画面で使えます。';
    el.a2hsInstall.hidden = false;
    el.a2hs.hidden = false;
  });

  el.a2hsInstall.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    try { await deferredInstallPrompt.userChoice; } catch { /* 無視 */ }
    deferredInstallPrompt = null;
    el.a2hs.hidden = true;
    storage.set(STORAGE_KEY_A2HS, '1');
  });

  window.addEventListener('appinstalled', () => {
    el.a2hs.hidden = true;
    storage.set(STORAGE_KEY_A2HS, '1');
  });

  if (dismissed) return;

  // iOS Safari: 初回のみ手順を案内
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS
  const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|Chrome/.test(ua);
  const isStandalone = navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;

  if (isIOS && isSafari && !isStandalone) {
    el.a2hsText.textContent =
      '画面下の共有ボタン（□に↑）→「ホーム画面に追加」でアプリとして使えます。';
    el.a2hsInstall.hidden = true;
    el.a2hs.hidden = false;
  }
}

/* ---------------------------------------------------------------
   自動更新
   --------------------------------------------------------------- */
function setupAutoRefresh() {
  setInterval(() => {
    if (document.visibilityState === 'visible') loadFeed({ silent: true });
  }, REFRESH_INTERVAL_MS);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - state.lastFetchedAt >= REFRESH_INTERVAL_MS) loadFeed({ silent: true });
  });
}

/* ---------------------------------------------------------------
   スティッキー位置（ヘッダー高に合わせてフィルタバーを固定）
   --------------------------------------------------------------- */
function setupStickyOffset() {
  const sync = () => {
    const h = el.hdr.getBoundingClientRect().height;
    document.documentElement.style.setProperty('--hdr-h', `${Math.round(h)}px`);
  };
  sync();
  window.addEventListener('resize', sync);
  window.addEventListener('orientationchange', sync);
  if ('ResizeObserver' in window) new ResizeObserver(sync).observe(el.hdr);
}

/* ==========================================================================
   応募のじゅんび（ショップ登録チェックリスト / マイ情報）

   このアプリで抽選に落ちる一番よくある理由は倍率ではなく、
   **当日に会員登録から始めて間に合わない** こと。
   だから「未登録の店の抽選が近い」ことを画面の最上部で先に知らせ、
   会員登録フォームで手が止まる項目（特にカタカナ）を1タップで出せるようにする。

   ・データは端末内（localStorage）だけ。外部へは一切送らない。
   ・パスワードとクレジットカード番号は扱わない（入力欄も作らない）。
   ========================================================================== */

/* ---------------------------------------------------------------
   ショップ一覧の読み込み
   --------------------------------------------------------------- */

/**
 * 店の一覧は config/shops.json が正。
 * 読めればそちら（＝親が店を足したら自動で増える）、
 * 読めなければ config.js に埋め込んだ写しに落ちる（単一ファイル版・静的配信用）。
 */
async function loadShops() {
  let raw = SHOPS_CONFIG;
  try {
    const res = await fetch(SHOPS_URL, { cache: 'no-cache', credentials: 'omit' });
    if (res.ok) {
      const json = await res.json();
      if (json && Array.isArray(json.shops) && json.shops.length) raw = json;
    }
  } catch { /* 同梱されていない置き方でも動くように、黙って写しを使う */ }

  state.shops = normalizeShopList(raw);
  state.shopCategories = categoryLabels(raw);
}

/* ---------------------------------------------------------------
   未登録ショップの警告（画面最上部）
   --------------------------------------------------------------- */

/** その案件が「抽選」なのか「予約」なのかを一語で */
function applyKindWord(item) {
  const tags = (item && item.intentTags) || [];
  if (tags.includes('抽選')) return '抽選';
  if (tags.includes('予約')) return '予約';
  if (tags.includes('受付') || tags.includes('応募')) return '受付';
  if (tags.includes('再販')) return '再販';
  return '抽選・予約';
}

/** 「9/14」。日時が無ければ空文字。 */
function formatMonthDay(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function renderWarn() {
  if (!el.secWarn) return;

  const list = unregisteredShopsFor(state.items, state.shopStatus, state.shops)
    .slice(0, 4);

  if (el.profileDot) el.profileDot.hidden = list.length === 0;

  if (!list.length) {
    el.secWarn.hidden = true;
    el.warnList.replaceChildren();
    return;
  }
  el.secWarn.hidden = false;
  el.warnList.replaceChildren(...list.map(buildWarnCard));
}

function buildWarnCard(entry) {
  const card = document.createElement('article');
  card.className = 'warn';

  const head = document.createElement('p');
  head.className = 'warn__head';

  const kind = applyKindWord(entry.sample);
  const when = formatMonthDay(entry.nextAt);
  const extra = entry.count > 1 ? `（ほか${entry.count - 1}件）` : '';

  // 例: 「9/14の抽選は「ヨドバシ」です。あなたは未登録です。」
  head.textContent = when
    ? `${when}${entry.nextKind === 'start' ? '受付開始' : ''}の${kind}は「${entry.label}」です。あなたは未登録です。${extra}`
    : `「${entry.label}」で応募できる${kind}情報があります。あなたは未登録です。${extra}`;

  const body = document.createElement('p');
  body.className = 'warn__body';
  body.textContent = '今のうちに登録しておくと、当日すぐ応募できます';

  const actions = document.createElement('div');
  actions.className = 'warn__actions';

  const url = safeShopUrl(entry.url);
  if (url) {
    const a = document.createElement('a');
    a.className = 'warn__open';
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = `${entry.label}を開く →`;
    a.setAttribute('aria-label', `${entry.label}のサイトを新しいタブで開く`);
    actions.appendChild(a);
  }

  const done = document.createElement('button');
  done.type = 'button';
  done.className = 'warn__done';
  done.textContent = '登録済みにする';
  done.addEventListener('click', () => {
    setShopRegistered(entry.id, true);
    toast(`「${entry.label}」を登録済みにしました`);
  });
  actions.appendChild(done);

  card.append(head, body, actions);
  return card;
}

/* ---------------------------------------------------------------
   登録状況の更新
   --------------------------------------------------------------- */

function setShopRegistered(id, registered) {
  const next = { ...state.shopStatus };
  if (registered) next[id] = true;
  else delete next[id];
  state.shopStatus = saveShopStatus(next);
  renderWarn();
  renderShopList();
}

/* ---------------------------------------------------------------
   チェックリストの描画
   --------------------------------------------------------------- */

function renderShopList() {
  if (!el.shopList) return;

  const summary = shopStatusSummary(state.shops, state.shopStatus);
  el.shopCount.textContent = `登録済み ${summary.done} / ${summary.total} 店`;

  const visible = state.shopUnregOnly
    ? state.shops.filter((s) => !state.shopStatus[s.id])
    : state.shops;

  if (!visible.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = state.shopUnregOnly ? '未登録の店はありません' : '店の一覧を読み込めませんでした';
    el.shopList.replaceChildren(p);
    return;
  }

  const nodes = [];
  let currentCategory = null;
  for (const shop of visible) {
    if (shop.category !== currentCategory) {
      currentCategory = shop.category;
      const h = document.createElement('h4');
      h.className = 'shops__cat';
      h.textContent = state.shopCategories[currentCategory] || currentCategory;
      nodes.push(h);
    }
    nodes.push(buildShopRow(shop));
  }
  el.shopList.replaceChildren(...nodes);
}

function buildShopRow(shop) {
  const row = document.createElement('div');
  row.className = 'shop';
  const checked = state.shopStatus[shop.id] === true;
  if (checked) row.classList.add('is-done');

  const label = document.createElement('label');
  label.className = 'shop__check';

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.setAttribute('aria-label', `${shop.label}に登録済み`);
  input.addEventListener('change', () => setShopRegistered(shop.id, input.checked));

  const box = document.createElement('span');
  box.className = 'shop__box';
  box.setAttribute('aria-hidden', 'true');

  const text = document.createElement('span');
  text.className = 'shop__name';
  text.textContent = shop.label;

  label.append(input, box, text);
  row.appendChild(label);

  const url = safeShopUrl(shop.url);
  if (url) {
    const a = document.createElement('a');
    a.className = 'shop__open';
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = '開く ↗';
    a.setAttribute('aria-label', `${shop.label}のサイトを新しいタブで開く`);
    row.appendChild(a);
  }
  return row;
}

/* ---------------------------------------------------------------
   マイ情報のフォーム
   --------------------------------------------------------------- */

let profileSaveTimer = 0;

function renderProfileForm() {
  if (!el.profileForm) return;

  const nodes = [];
  for (const group of PROFILE_GROUPS) {
    const fields = PROFILE_FIELDS.filter((f) => f.group === group.key);
    if (!fields.length) continue;

    const fs = document.createElement('fieldset');
    fs.className = 'pform__group';

    const legend = document.createElement('legend');
    legend.className = 'pform__legend';
    legend.textContent = group.label;
    fs.appendChild(legend);

    for (const field of fields) fs.appendChild(buildProfileRow(field));
    nodes.push(fs);
  }
  el.profileForm.replaceChildren(...nodes);
  renderDerived();
}

function buildProfileRow(field) {
  const row = document.createElement('div');
  row.className = 'pform__row';

  const id = `pf-${field.key}`;

  const label = document.createElement('label');
  label.className = 'pform__label';
  label.htmlFor = id;
  label.textContent = field.label;
  if (field.hint) {
    const hint = document.createElement('span');
    hint.className = 'pform__hint';
    hint.textContent = field.hint;
    label.appendChild(hint);
  }

  const ctl = document.createElement('div');
  ctl.className = 'pform__ctl';

  const input = document.createElement('input');
  input.type = 'text';
  input.id = id;
  input.className = 'pform__input';
  input.dataset.key = field.key;
  input.value = state.profile[field.key] || '';
  // ブラウザ側の自動保存には乗せない（保存先はこの端末の localStorage だけにする）
  input.autocomplete = 'off';
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('autocorrect', 'off');
  input.spellcheck = false;
  if (field.placeholder) input.placeholder = field.placeholder;
  if (field.inputmode) input.inputMode = field.inputmode;
  if (field.maxLength) input.maxLength = field.maxLength;

  input.addEventListener('input', () => {
    state.profile[field.key] = input.value;
    // 入力が消えるのが一番の事故なので、明示保存を待たず自動保存もしておく
    clearTimeout(profileSaveTimer);
    profileSaveTimer = setTimeout(() => {
      state.profile = saveProfile(state.profile);
      renderDerived();
    }, 400);
  });

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'copy';
  copy.textContent = 'コピー';
  copy.setAttribute('aria-label', `${field.label}をコピー`);
  copy.addEventListener('click', async () => {
    const value = input.value.trim();
    if (!value) { toast('まだ入力されていません'); return; }
    toast(await copyText(value) ? `${field.label}をコピーしました` : 'コピーできませんでした');
  });

  ctl.append(input, copy);
  row.append(label, ctl);
  return row;
}

function renderDerived() {
  if (!el.derivedList) return;
  const rows = derivedRows(state.profile);
  if (!rows.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = '上の項目を入力すると、ここに出ます';
    el.derivedList.replaceChildren(p);
    return;
  }
  el.derivedList.replaceChildren(...rows.map((row) => {
    const item = document.createElement('div');
    item.className = 'copyrow';

    const text = document.createElement('div');
    text.className = 'copyrow__text';

    const key = document.createElement('span');
    key.className = 'copyrow__label';
    key.textContent = row.label;

    const val = document.createElement('span');
    val.className = 'copyrow__value';
    val.textContent = row.value;

    text.append(key, val);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy';
    btn.textContent = 'コピー';
    btn.setAttribute('aria-label', `${row.label}をコピー`);
    btn.addEventListener('click', async () => {
      toast(await copyText(row.value) ? `${row.label}をコピーしました` : 'コピーできませんでした');
    });

    item.append(text, btn);
    return item;
  }));
}

/* ---------------------------------------------------------------
   暗号化バックアップ
   --------------------------------------------------------------- */

const MIN_PASSPHRASE = 8;

function bkMessage(node, text, kind) {
  if (!node) return;
  node.hidden = !text;
  node.textContent = text || '';
  node.className = `bk__msg${kind ? ` bk__msg--${kind}` : ''}`;
}

/** バックアップに入れる中身。マイ情報と登録チェックの両方を1ファイルにまとめる。 */
function backupPayload() {
  return {
    app: 'tcgwatch',
    kind: 'profile-backup',
    version: 1,
    savedAt: new Date().toISOString(),
    profile: normalizeProfile(state.profile),
    shopStatus: normalizeShopStatus(state.shopStatus),
  };
}

async function exportBackup() {
  const pass = el.bkPass1.value;
  const confirm = el.bkPass2.value;

  if (pass.length < MIN_PASSPHRASE) {
    bkMessage(el.bkExportMsg, `パスフレーズは${MIN_PASSPHRASE}文字以上にしてください`, 'err');
    return;
  }
  if (pass !== confirm) {
    bkMessage(el.bkExportMsg, '2つのパスフレーズが一致しません', 'err');
    return;
  }
  if (!hasProfile(state.profile) && Object.keys(state.shopStatus).length === 0) {
    bkMessage(el.bkExportMsg, '保存する内容がまだありません', 'err');
    return;
  }

  el.btnExport.disabled = true;
  bkMessage(el.bkExportMsg, '暗号化しています…', null);
  try {
    const text = await encryptJson(backupPayload(), pass);
    const downloaded = tryDownload(text);

    el.bkOut.value = text;
    el.bkOutWrap.hidden = false;
    el.bkOutNote.textContent = downloaded
      ? 'ダウンロードが始まらないときは、下の暗号文をコピーしてメモアプリなどに保存してください。'
      : 'この画面ではファイルのダウンロードが使えません。下の暗号文をコピーして保存してください。';
    bkMessage(
      el.bkExportMsg,
      downloaded
        ? '暗号化しました。パスフレーズを忘れると復元できません。必ず控えてください。'
        : '暗号化しました。下の暗号文が復元に必要です。パスフレーズも必ず控えてください。',
      'ok',
    );
    // パスフレーズを画面に残さない
    el.bkPass1.value = '';
    el.bkPass2.value = '';
  } catch (err) {
    bkMessage(el.bkExportMsg, err && err.message ? err.message : String(err), 'err');
  } finally {
    el.btnExport.disabled = false;
  }
}

/**
 * ファイルとして保存を試みる。
 * Artifact などサンドボックス配信ではページ発のダウンロードがブロックされるので、
 * 成否に関わらず暗号文はテキストエリアにも出す（呼び出し側で必ず出している）。
 * @returns {boolean} ダウンロードを開始できたか
 */
function tryDownload(text) {
  try {
    const a = document.createElement('a');
    if (typeof a.download !== 'string') return false;
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    a.href = url;
    a.download = `tcgwatch-backup-${stamp}.json`;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return true;
  } catch {
    return false;
  }
}

async function importBackup() {
  const text = el.bkIn.value.trim();
  const pass = el.bkPass3.value;

  el.bkConfirm.hidden = true;
  state.pendingRestore = null;

  if (!text) {
    bkMessage(el.bkImportMsg, 'バックアップファイルを選ぶか、暗号文を貼り付けてください', 'err');
    return;
  }
  if (!isEncryptedBackup(text)) {
    bkMessage(el.bkImportMsg, 'このファイルは暗号化バックアップの形式ではありません', 'err');
    return;
  }
  if (!pass) {
    bkMessage(el.bkImportMsg, 'そのときのパスフレーズを入力してください', 'err');
    return;
  }

  el.btnImport.disabled = true;
  bkMessage(el.bkImportMsg, '復号しています…', null);
  try {
    const payload = await decryptJson(text, pass);
    if (!payload || typeof payload !== 'object') throw new Error('中身を読み取れませんでした。');

    const profile = normalizeProfile(payload.profile);
    const shopStatus = normalizeShopStatus(payload.shopStatus);
    if (!Object.keys(profile).length && !Object.keys(shopStatus).length) {
      throw new Error('復号できましたが、復元できる内容が入っていませんでした。');
    }

    state.pendingRestore = { profile, shopStatus };
    const savedAt = Date.parse(payload.savedAt);
    const when = Number.isFinite(savedAt) ? `${formatDateTime(savedAt)}に保存` : '保存日時不明';
    el.bkPreview.textContent =
      `${when} / マイ情報 ${Object.keys(profile).length}項目 / 登録済みショップ ${Object.keys(shopStatus).length}店。`
      + ' いまの内容は上書きされます。';
    el.bkConfirm.hidden = false;
    bkMessage(el.bkImportMsg, '復号できました。内容を確認してください。', 'ok');
  } catch (err) {
    bkMessage(el.bkImportMsg, err && err.message ? err.message : String(err), 'err');
  } finally {
    el.btnImport.disabled = false;
  }
}

function applyRestore() {
  if (!state.pendingRestore) return;
  state.profile = saveProfile(state.pendingRestore.profile);
  state.shopStatus = saveShopStatus(state.pendingRestore.shopStatus);
  state.pendingRestore = null;

  el.bkConfirm.hidden = true;
  el.bkIn.value = '';
  el.bkPass3.value = '';
  bkMessage(el.bkImportMsg, '復元しました。', 'ok');

  renderProfileForm();
  renderShopList();
  renderWarn();
  toast('バックアップから復元しました');
}

/* ---------------------------------------------------------------
   ボトムシート
   --------------------------------------------------------------- */

let lastFocused = null;

function openSheet(tab) {
  lastFocused = document.activeElement;
  el.sheet.hidden = false;
  document.body.classList.add('is-locked');
  selectTab(tab || 'shops');
  renderShopList();
  renderProfileForm();
  // 表示直後にフォーカスを移す（アニメーション開始と同フレームだと効かない端末がある）
  requestAnimationFrame(() => { el.sheetClose.focus(); });
}

function closeSheet() {
  el.sheet.hidden = true;
  document.body.classList.remove('is-locked');
  // パスフレーズと暗号文を画面に残さない
  el.bkPass1.value = '';
  el.bkPass2.value = '';
  el.bkPass3.value = '';
  if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
  lastFocused = null;
}

function selectTab(name) {
  const shops = name !== 'profile';
  el.tabShops.setAttribute('aria-selected', String(shops));
  el.tabProfile.setAttribute('aria-selected', String(!shops));
  el.paneShops.hidden = !shops;
  el.paneProfile.hidden = shops;
  el.sheetBody.scrollTop = 0;
}

function setupSheet() {
  if (!el.sheet) return;

  el.btnProfile.addEventListener('click', () => openSheet('shops'));
  el.btnWarnOpen.addEventListener('click', () => openSheet('shops'));
  el.sheetClose.addEventListener('click', closeSheet);
  el.sheetScrim.addEventListener('click', closeSheet);
  el.tabShops.addEventListener('click', () => selectTab('shops'));
  el.tabProfile.addEventListener('click', () => selectTab('profile'));

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !el.sheet.hidden) closeSheet();
  });

  el.shopUnregOnly.addEventListener('change', () => {
    state.shopUnregOnly = el.shopUnregOnly.checked;
    renderShopList();
  });

  el.btnProfileSave.addEventListener('click', () => {
    clearTimeout(profileSaveTimer);
    state.profile = saveProfile(state.profile);
    renderProfileForm();
    toast('この端末に保存しました');
  });

  el.btnProfileCopyAll.addEventListener('click', async () => {
    const text = profileSummaryText(state.profile);
    if (!text) { toast('まだ入力されていません'); return; }
    toast(await copyText(text) ? 'マイ情報をまとめてコピーしました' : 'コピーできませんでした');
  });

  el.btnProfileClear.addEventListener('click', () => {
    if (!window.confirm('この端末に保存したマイ情報を消します。よろしいですか？')) return;
    clearTimeout(profileSaveTimer);
    state.profile = clearProfile();
    renderProfileForm();
    toast('マイ情報を消しました');
  });

  el.btnExport.addEventListener('click', exportBackup);
  el.btnExportCopy.addEventListener('click', async () => {
    toast(await copyText(el.bkOut.value) ? '暗号文をコピーしました' : 'コピーできませんでした');
  });

  el.bkFile.addEventListener('change', async () => {
    const file = el.bkFile.files && el.bkFile.files[0];
    if (!file) return;
    try {
      // 端末上のファイルを読むだけ。どこにも送らない。
      const text = await file.text();
      el.bkIn.value = text;
      bkMessage(
        el.bkImportMsg,
        isEncryptedBackup(text)
          ? 'ファイルを読み込みました。パスフレーズを入力して「復元する」を押してください。'
          : 'このファイルは暗号化バックアップの形式ではありません',
        isEncryptedBackup(text) ? 'ok' : 'err',
      );
    } catch (err) {
      bkMessage(el.bkImportMsg, `ファイルを読めませんでした: ${err && err.message ? err.message : err}`, 'err');
    }
  });

  el.btnImport.addEventListener('click', importBackup);
  el.btnImportApply.addEventListener('click', applyRestore);
  el.btnImportCancel.addEventListener('click', () => {
    state.pendingRestore = null;
    el.bkConfirm.hidden = true;
    bkMessage(el.bkImportMsg, '', null);
  });
}

/** 起動時に端末内の保存内容を読み戻す */
async function setupProfile() {
  state.profile = loadProfile();
  state.shopStatus = loadShopStatus();
  setupSheet();
  await loadShops();
  renderShopList();
  renderWarn();
}

/* ---------------------------------------------------------------
   起動
   --------------------------------------------------------------- */
function init() {
  document.title = APP_NAME;
  el.appName.textContent = APP_NAME;
  el.ftrVer.textContent = `${APP_NAME} v${APP_VERSION}`;

  restoreFilters();
  setupStickyOffset();

  el.btnRefresh.addEventListener('click', triggerRefresh);
  el.btnRetry.addEventListener('click', triggerRefresh);

  el.btnMore.addEventListener('click', () => {
    state.visibleCount += PAGE_SIZE;
    renderCards();
  });

  el.lotteryOnly.addEventListener('change', () => {
    state.lotteryOnly = el.lotteryOnly.checked;
    state.visibleCount = PAGE_SIZE;
    saveFilters();
    renderCards();
  });

  el.showExpired.addEventListener('change', () => {
    state.showExpired = el.showExpired.checked;
    state.visibleCount = PAGE_SIZE;
    saveFilters();
    renderCards();
  });

  el.sortLatest.addEventListener('click', () => setSortMode('latest'));
  el.sortDeadline.addEventListener('click', () => setSortMode('deadline'));

  el.btnClearFilters.addEventListener('click', () => clearAllFilters());

  // 0件表示からの戻り道。絞り込みが「終了分を隠す」だけなら、それを外す
  el.btnEmptyClear.addEventListener('click', () => {
    const onlyExpiredHidden = !state.selectedIps.size && !state.lotteryOnly && !state.showExpired;
    clearAllFilters({ showExpired: onlyExpiredHidden });
  });

  setupPullToRefresh();
  setupA2HS();
  setupAutoRefresh();
  registerServiceWorker();

  // 「応募のじゅんび」はフィードが来る前に開けるようにしておく（登録は今すぐできる）
  setupProfile().catch((err) => {
    console.warn('[TCGウォッチ] マイ情報の初期化に失敗:', err);
  });

  loadFeed();
}

init();
