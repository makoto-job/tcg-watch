/**
 * src/report.js — 実行結果をHTMLレポートとして出力する
 *
 * ターミナルの枠線出力と同じ情報を、読みやすい1枚のHTMLにまとめる。
 * 依存パッケージなし。生成物は単体で開ける自己完結HTML。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { weightedLength } from './format.js';

/** HTMLエスケープ。属性値・テキストの両方に使える最小限。 */
export function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** http(s) のみ許可。それ以外は空文字（javascript: 対策） */
export function safeUrl(u) {
  const s = String(u || '');
  return /^https?:\/\//i.test(s) ? s : '';
}

const IP_LABELS = {
  pokemon: 'ポケカ',
  onepiece: 'ワンピ',
  dragonball: 'ドラゴンボール',
  gundam: 'ガンダム',
  hololive: 'ホロライブ',
  yugioh: '遊戯王',
  duelmasters: 'デュエマ',
  mtg: 'MTG',
  newtcg: '新作',
  digimon: 'デジモン',
  battlespirits: 'バトスピ',
  aikatsu: 'アイカツ',
  carddass: 'カードダス',
  vanguard: 'ヴァンガード',
  weiss: 'ヴァイス',
  lottery: '抽選',
};

/** タグの意味づけ。色は「良い/注意」ではなく情報の種類を表す */
const TAG_KIND = {
  抽選: 'hot',
  当選: 'hot',
  予約: 'warm',
  受付: 'warm',
  発売: 'warm',
  再販: 'calm',
  新弾: 'calm',
  収録: 'neutral',
  コラボ: 'neutral',
  相場: 'neutral',
  大会: 'neutral',
};

const MEDALS = ['🥇', '🥈', '🥉'];

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * 締切までの残り時間を「一目で分かる」1語にする。
 * 返り値の state は表示の強さ: expired < far < near < soon < urgent
 *
 * @param {string|null|undefined} deadline ISO8601
 * @param {Date} [now]
 * @param {string} [tz]
 * @returns {{state:'expired'|'urgent'|'soon'|'near'|'far', text:string, diffMs:number}|null}
 *          deadline が無い/壊れている場合は null（=バッジを出さない）
 */
export function deadlineBadge(deadline, now = new Date(), tz = 'Asia/Tokyo') {
  const t = Date.parse(typeof deadline === 'string' ? deadline : '');
  if (!Number.isFinite(t)) return null;
  const diff = t - now.getTime();
  if (diff <= 0) return { state: 'expired', text: '受付終了', diffMs: diff };
  if (diff < HOUR_MS) return { state: 'urgent', text: 'まもなく締切', diffMs: diff };
  if (diff < DAY_MS) {
    return { state: 'soon', text: `あと${Math.max(1, Math.floor(diff / HOUR_MS))}時間`, diffMs: diff };
  }
  if (diff < 7 * DAY_MS) {
    return { state: 'near', text: `あと${Math.max(1, Math.floor(diff / DAY_MS))}日`, diffMs: diff };
  }
  return { state: 'far', text: `${fmtMonthDay(deadline, tz)}まで`, diffMs: diff };
}

function fmtMonthDay(iso, tz = 'Asia/Tokyo') {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('ja-JP', { timeZone: tz, month: 'numeric', day: 'numeric' }).format(d);
}

/** 締切切れか（deadline が無ければ false = まだ応募できる扱い） */
export function isExpired(item, now = new Date()) {
  const b = deadlineBadge(item?.deadline, now);
  return b ? b.state === 'expired' : false;
}

/** 応募ページがあり、かつ締切切れでない */
export function isApplyOpen(item, now = new Date()) {
  return Boolean(safeUrl(item?.destUrl)) && !isExpired(item, now);
}

/** 締切バッジのHTML。deadline が無ければ何も出さない（「締切不明」と書かない） */
function deadlineBadgeHtml(item, now, tz) {
  const b = deadlineBadge(item?.deadline, now, tz);
  if (!b) return '';
  const title = `締切 ${fmtDateTime(item.deadline, tz)}`;
  return `<span class="dl dl--${b.state}" title="${esc(title)}">${esc(b.text)}</span>`;
}

/** 受付開始が未来なら「まだ応募できない」ことを示す */
function startsAtHtml(item, now, tz) {
  const t = Date.parse(typeof item?.startsAt === 'string' ? item.startsAt : '');
  if (!Number.isFinite(t) || t <= now.getTime()) return '';
  return `<span class="dl dl--start">${esc(fmtDateTime(item.startsAt, tz))} 受付開始</span>`;
}

/** 飛び先の名前。destLabel が無ければドメイン、それも無ければ「応募ページ」 */
function destinationName(item) {
  const label = String(item?.destLabel || '').trim();
  if (label) return label;
  const url = safeUrl(item?.destUrl);
  if (!url) return '応募ページ';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '応募ページ';
  }
}

/**
 * 応募ボタン。このページで最も押させたい要素。
 * destUrl が無ければ何も出さない。
 */
function applyButtonHtml(item, extraClass = '') {
  const url = safeUrl(item?.destUrl);
  if (!url) return '';
  const label = String(item?.destLabel || '').trim();
  // 受付中だと確認できていないものは「応募」と断定しない
  const verified = item?.applyVerified === true;
  const verb = verified ? '応募' : '確認';
  const text = label ? `${label}で${verb}` : verified ? '応募ページへ' : '商品ページを確認';
  const aria = `${String(item?.title || '').trim()} — ${destinationName(item)}の${
    verified ? '応募ページ' : '商品ページ'
  }を開く`;
  return `<a class="apply${extraClass}" href="${esc(url)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(
    aria
  )}">${esc(text)}<span class="apply__arrow" aria-hidden="true">→</span></a>`;
}

/** 記事リンク（応募ボタンがある時も必ず残す副次リンク。ニュース自体も価値がある） */
function articleLinkHtml(item) {
  const url = safeUrl(item?.url);
  if (!url) return '';
  return `<a class="readmore" href="${esc(url)}" target="_blank" rel="noopener noreferrer">記事を読む ↗</a>`;
}

/**
 * 見出し（タイトル）そのものを主リンクにする。
 * destUrl があればそちらへ飛ばし、行き先を必ず併記する（黙って別ドメインに飛ばさない）。
 */
function titleLinkHtml(item, tag = 'h3', cls = '') {
  const dest = safeUrl(item?.destUrl);
  const url = dest || safeUrl(item?.url);
  const title = String(item?.title || '');
  if (!url) return `<${tag} class="${cls}">${esc(title)}</${tag}>`;
  const aria = dest
    ? `${title.trim()} — ${destinationName(item)}の応募ページを開く`
    : `${title.trim()} — 記事を開く`;
  const hint = dest
    ? `<span class="dest-hint"><span class="dest-hint__arrow" aria-hidden="true">→</span>${esc(
        destinationName(item)
      )}</span>`
    : '';
  return `<${tag} class="${cls}${dest ? ' has-dest' : ''}"><a href="${esc(
    url
  )}" target="_blank" rel="noopener noreferrer" aria-label="${esc(aria)}">${esc(title)}</a>${hint}</${tag}>`;
}

function fmtDateTime(iso, tz = 'Asia/Tokyo') {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: tz,
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

function fmtDate(d, tz = 'Asia/Tokyo') {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: tz,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  }).format(d);
}

/** 主IP（lottery を除いた最初のもの） */
function primaryIp(item) {
  const ips = Array.isArray(item.ips) ? item.ips : [];
  return ips.find((k) => k !== 'lottery') || ips[0] || '';
}

/**
 * intentTags のチップ。
 * destUrl があるときは「抽選」「予約」チップ自体を応募ページへのリンクにする。
 * （destUrl が無いときは押せそうに見えないよう、従来どおり非リンクの装飾のまま）
 */
function chips(tags, item) {
  const dest = safeUrl(item?.destUrl);
  const label = destinationName(item);
  const title = String(item?.title || '').trim();
  return (Array.isArray(tags) ? tags : [])
    .map((t) => {
      const cls = `chip chip--${TAG_KIND[t] || 'neutral'}`;
      if (!dest) return `<span class="${cls}">${esc(t)}</span>`;
      const aria = `${title} — ${label}の${t}ページを開く`;
      return `<a class="${cls} chip--link" href="${esc(dest)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(
        aria
      )}">${esc(t)}</a>`;
    })
    .join('');
}

/** ランキング1件分 */
function rankCard(item, i, tz, now) {
  const dest = safeUrl(item.destUrl);
  const ip = primaryIp(item);
  const dup = Number(item.clusterSize) > 1 ? Number(item.clusterSize) - 1 : 0;
  const score = Number(item.score) || 0;
  // スコアバーは100点満点に対する割合
  const pct = Math.max(0, Math.min(100, score));
  const expired = isExpired(item, now);
  return `
    <article class="rank${i === 0 ? ' rank--lead' : ''}${expired ? ' is-expired' : ''}">
      <div class="rank__gutter">
        <span class="rank__medal" aria-hidden="true">${MEDALS[i] || ''}</span>
        <span class="rank__num">${i + 1}</span>
      </div>
      <div class="rank__body">
        <div class="rank__tags">
          ${deadlineBadgeHtml(item, now, tz)}
          ${startsAtHtml(item, now, tz)}
          ${ip ? `<span class="ip ip--${esc(ip)}">${esc(IP_LABELS[ip] || ip)}</span>` : ''}
          ${chips(item.intentTags, item)}
        </div>
        ${titleLinkHtml(item, 'h3', 'rank__title')}
        ${item.summary ? `<p class="rank__summary">${esc(item.summary)}</p>` : ''}
        ${
          dest
            ? `<div class="cta">${applyButtonHtml(item)}${articleLinkHtml(item)}</div>`
            : ''
        }
        <div class="rank__meta">
          <span>${esc(item.sourceName || '')}</span>
          <span class="sep" aria-hidden="true">·</span>
          <time datetime="${esc(item.publishedAt || '')}">${esc(fmtDateTime(item.publishedAt, tz))}</time>
          ${dup > 0 ? `<span class="sep" aria-hidden="true">·</span><span class="dup">他${dup}媒体が報道</span>` : ''}
        </div>
        <div class="score" title="スコア ${esc(score.toFixed(2))} / 100">
          <span class="score__label">スコア</span>
          <span class="score__track"><span class="score__fill" style="width:${pct}%"></span></span>
          <span class="score__value">${esc(score.toFixed(1))}</span>
        </div>
      </div>
    </article>`;
}

/** ツイート1本分のプレビュー */
function tweetBox(text, i, total, style) {
  const w = weightedLength(text);
  const pct = Math.min(100, Math.round((w / 280) * 100));
  const state = w > 280 ? 'over' : w > 252 ? 'near' : 'ok';
  const label = style === 'single' ? '単発ツイート' : `${i + 1} / ${total} 本目`;
  return `
    <article class="tweet">
      <header class="tweet__head">
        <span class="tweet__label">${esc(label)}</span>
        <span class="meter meter--${state}">
          <span class="meter__track"><span class="meter__fill" style="width:${pct}%"></span></span>
          <span class="meter__num">${w}<span class="meter__max">/280</span></span>
        </span>
      </header>
      <pre class="tweet__text">${esc(text)}</pre>
    </article>`;
}

/** 最新情報リスト1件 */
function feedRow(item, tz, now) {
  const dest = safeUrl(item.destUrl);
  const ip = primaryIp(item);
  const expired = isExpired(item, now);
  return `
    <li class="row${expired ? ' is-expired' : ''}">
      <time class="row__time" datetime="${esc(item.publishedAt || '')}">${esc(
        fmtDateTime(item.publishedAt, tz)
      )}</time>
      <div class="row__main">
        ${titleLinkHtml(item, 'div', 'row__title')}
        <div class="row__meta">
          ${deadlineBadgeHtml(item, now, tz)}
          ${startsAtHtml(item, now, tz)}
          ${ip ? `<span class="ip ip--${esc(ip)} ip--sm">${esc(IP_LABELS[ip] || ip)}</span>` : ''}
          ${chips((item.intentTags || []).slice(0, 3), item)}
          <span class="row__src">${esc(item.sourceName || '')}</span>
        </div>
        ${
          dest
            ? `<div class="cta cta--sm">${applyButtonHtml(item, ' apply--sm')}${articleLinkHtml(item)}</div>`
            : ''
        }
      </div>
    </li>`;
}

/**
 * 「いま応募できるもの」— このページの主役。
 * destUrl があり締切切れでないものを、締切が近い順に並べる。
 */
function pickApplicable(lists, now) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const item of Array.isArray(list) ? list : []) {
      if (!item || typeof item !== 'object') continue;
      if (!isApplyOpen(item, now)) continue;
      const key = item.id || safeUrl(item.destUrl) || safeUrl(item.url) || item.title;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  // 締切が近い順。締切不明のものは末尾へ。
  return out.sort((a, b) => {
    const ta = Date.parse(a.deadline ?? '');
    const tb = Date.parse(b.deadline ?? '');
    const va = Number.isFinite(ta) ? ta : Infinity;
    const vb = Number.isFinite(tb) ? tb : Infinity;
    if (va !== vb) return va - vb;
    return (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0);
  });
}

function applyCard(item, tz, now) {
  const ip = primaryIp(item);
  const b = deadlineBadge(item.deadline, now, tz);
  return `
    <article class="offer${b ? ` offer--${b.state}` : ''}">
      <div class="offer__tags">
        ${deadlineBadgeHtml(item, now, tz)}
        ${startsAtHtml(item, now, tz)}
        ${ip ? `<span class="ip ip--${esc(ip)} ip--sm">${esc(IP_LABELS[ip] || ip)}</span>` : ''}
        ${chips((item.intentTags || []).slice(0, 2), item)}
      </div>
      ${titleLinkHtml(item, 'h3', 'offer__title')}
      <div class="cta">
        ${applyButtonHtml(item)}
        ${articleLinkHtml(item)}
      </div>
      ${
        item.deadline
          ? `<p class="offer__when">締切 <time datetime="${esc(item.deadline)}">${esc(
              fmtDateTime(item.deadline, tz)
            )}</time></p>`
          : '<p class="offer__when">締切の記載なし — 早めの応募を</p>'
      }
    </article>`;
}

/**
 * HTMLレポートを組み立てる。
 * @param {Object} p
 * @param {Array<Object>} p.top        TOP N（RankedItem）
 * @param {string[]} p.texts           投稿予定のツイート文面
 * @param {Array<Object>} p.feedItems  最新順のフィード（FeedItem）
 * @param {Object} p.stats             {collected, excluded, clusters, feedCount}
 * @param {Date} p.now
 * @param {string} p.style             'thread' | 'single'
 * @param {boolean} p.posted           実投稿済みか
 * @param {string|null} p.tweetUrl
 * @param {string} [p.tz]
 * @returns {string}
 */
export function buildReportHtml({
  top = [],
  texts = [],
  feedItems = [],
  stats = {},
  now = new Date(),
  style = 'thread',
  posted = false,
  tweetUrl = null,
  tz = 'Asia/Tokyo',
}) {
  const dateLabel = fmtDate(now, tz);
  const genAt = fmtDateTime(now.toISOString(), tz);
  // このページの主役: いま応募できるもの（締切が近い順）
  const offers = pickApplicable([top, feedItems], now);
  const statCells = [
    ['収集した記事', stats.collected ?? 0, '件'],
    ['まとめた話題', stats.clusters ?? 0, '件'],
    ['投稿済み除外', stats.excluded ?? 0, '件'],
    ['アプリ掲載', stats.feedCount ?? feedItems.length, '件'],
  ];

  // charset はファイル先頭1024バイト以内に置く必要がある（file:// で直接開いた時の文字化け対策）
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TCGデイリーランキング</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Zen+Kaku+Gothic+New:wght@400;500;700&family=IBM+Plex+Mono:wght@400;600&display=swap">
<style>
:root {
  --paper: #F7F8FB;
  --surface: #FFFFFF;
  --ink: #12172B;
  --ink-soft: #5A6076;
  --ink-faint: #8B92A8;
  --rule: #E2E6F0;
  --accent: #3D3AE0;
  --hot: #C6284B;
  --warm: #A85A14;
  --calm: #1F7A5A;
  --urgent: #B3102F;
  --warn-strong: #8A4A10;
  --on-accent: #FFFFFF;
  --shadow: 0 1px 2px rgba(18, 23, 43, .05), 0 8px 24px rgba(18, 23, 43, .05);
  --mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  --sans: "Zen Kaku Gothic New", -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --paper: #0E1120;
    --surface: #161B2E;
    --ink: #E8EAF4;
    --ink-soft: #A2A9C0;
    --ink-faint: #767D96;
    --rule: #262C46;
    --accent: #8A87FF;
    --hot: #FF7391;
    --warm: #E0A050;
    --calm: #55C99C;
    --urgent: #FF8FA3;
    --warn-strong: #E0A050;
    --on-accent: #0E1120;
    --shadow: 0 1px 2px rgba(0, 0, 0, .3), 0 8px 24px rgba(0, 0, 0, .28);
  }
}
:root[data-theme="dark"] {
  --paper: #0E1120;
  --surface: #161B2E;
  --ink: #E8EAF4;
  --ink-soft: #A2A9C0;
  --ink-faint: #767D96;
  --rule: #262C46;
  --accent: #8A87FF;
  --hot: #FF7391;
  --warm: #E0A050;
  --calm: #55C99C;
  --urgent: #FF8FA3;
  --warn-strong: #E0A050;
  --on-accent: #0E1120;
  --shadow: 0 1px 2px rgba(0, 0, 0, .3), 0 8px 24px rgba(0, 0, 0, .28);
}

* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: var(--sans);
  font-size: 16px;
  line-height: 1.7;
  -webkit-font-smoothing: antialiased;
}
.wrap {
  max-width: 900px;
  margin: 0 auto;
  padding: 48px 20px 96px;
  display: flex;
  flex-direction: column;
  gap: 56px;
}
a { color: inherit; text-decoration-color: var(--rule); text-underline-offset: 3px; }
a:hover { text-decoration-color: var(--accent); }
a:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 2px; }

/* --- 見出し。箔（ホロ）の帯はここ1か所だけ --- */
.masthead { display: flex; flex-direction: column; gap: 14px; }
.masthead__eyebrow {
  font-family: var(--mono);
  font-size: 12px;
  letter-spacing: .14em;
  text-transform: uppercase;
  color: var(--ink-faint);
}
.masthead__title {
  margin: 0;
  font-size: clamp(28px, 5vw, 40px);
  font-weight: 700;
  letter-spacing: -.01em;
  line-height: 1.25;
  text-wrap: balance;
}
.masthead__date { margin: 0; color: var(--ink-soft); font-size: 15px; }
.foil {
  height: 3px;
  border-radius: 2px;
  background: linear-gradient(90deg, #3D3AE0, #7B4BE0, #C43FA8, #E06A3F, #C9A227, #2FA36B, #2E7BE0);
  background-size: 220% 100%;
  animation: shift 14s linear infinite;
}
@keyframes shift { to { background-position: 220% 0; } }
@media (prefers-reduced-motion: reduce) { .foil { animation: none; } }

/* --- 統計 --- */
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 1px;
  background: var(--rule);
  border: 1px solid var(--rule);
  border-radius: 8px;
  overflow: hidden;
}
.stat { background: var(--surface); padding: 18px 20px; display: flex; flex-direction: column; gap: 2px; }
.stat__label { font-size: 12px; color: var(--ink-faint); letter-spacing: .04em; }
.stat__value { font-family: var(--mono); font-size: 26px; font-weight: 600; font-variant-numeric: tabular-nums; }
.stat__unit { font-size: 13px; color: var(--ink-faint); font-family: var(--sans); margin-left: 2px; }

/* --- セクション --- */
section { display: flex; flex-direction: column; gap: 20px; }
.sec-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; border-bottom: 1px solid var(--rule); padding-bottom: 10px; }
.sec-head h2 { margin: 0; font-size: 19px; font-weight: 700; letter-spacing: .01em; }
.sec-head .note { font-size: 13px; color: var(--ink-faint); font-family: var(--mono); }

/* --- ランキング --- */
.ranks { display: flex; flex-direction: column; gap: 14px; }
.rank {
  display: grid;
  grid-template-columns: 68px 1fr;
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: 8px;
  box-shadow: var(--shadow);
  overflow: hidden;
}
.rank--lead { border-color: color-mix(in srgb, var(--accent) 35%, var(--rule)); }
.rank__gutter {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
  padding: 22px 0; border-right: 1px solid var(--rule);
}
.rank__medal { font-size: 22px; line-height: 1; }
.rank__num { font-family: var(--mono); font-size: 13px; font-weight: 600; color: var(--ink-faint); font-variant-numeric: tabular-nums; }
.rank__body { padding: 18px 22px 20px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.rank__tags { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.rank__title { margin: 0; font-size: 17px; font-weight: 700; line-height: 1.55; text-wrap: pretty; }
.rank--lead .rank__title { font-size: 19px; }
.rank__summary { margin: 0; color: var(--ink-soft); font-size: 14px; line-height: 1.7; }
.rank__meta { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; font-size: 13px; color: var(--ink-faint); font-family: var(--mono); }
.rank__meta .sep { opacity: .5; }
.dup { color: var(--accent); }

/* スコア */
.score { display: flex; align-items: center; gap: 9px; margin-top: 2px; }
.score__label { font-size: 11px; color: var(--ink-faint); letter-spacing: .08em; }
.score__track { flex: 1; height: 4px; background: var(--rule); border-radius: 2px; overflow: hidden; max-width: 260px; }
.score__fill { display: block; height: 100%; background: var(--accent); }
.score__value { font-family: var(--mono); font-size: 12px; font-variant-numeric: tabular-nums; color: var(--ink-soft); }

/* --- バッジ・チップ --- */
.ip {
  font-size: 12px; font-weight: 700; padding: 3px 9px; border-radius: 4px;
  color: #fff; background: var(--ink-soft); white-space: nowrap; line-height: 1.5;
}
.ip--sm { font-size: 11px; padding: 1px 7px; }
.ip--pokemon { background: #C79A00; }
.ip--onepiece { background: #C1272D; }
.ip--dragonball { background: #D26516; }
.ip--gundam { background: #2A5CB8; }
.ip--hololive { background: #1E8FA8; }
.ip--yugioh { background: #6B3FA0; }
.ip--duelmasters { background: #1F3E8C; }
.ip--mtg { background: #7A5230; }
.ip--newtcg { background: #2E7D53; }
.ip--digimon { background: #1B6FA8; }
.ip--battlespirits { background: #B03A2E; }
.ip--aikatsu { background: #C2417F; }
.ip--carddass { background: #5E7A1E; }
.ip--vanguard { background: #C8541E; }
.ip--weiss { background: #4A4A8C; }
.ip--lottery { background: #B03060; }
.chip {
  font-size: 11.5px; padding: 2px 8px; border-radius: 4px; line-height: 1.6;
  border: 1px solid currentColor; white-space: nowrap;
}
.chip--hot { color: var(--hot); }
.chip--warm { color: var(--warm); }
.chip--calm { color: var(--calm); }
.chip--neutral { color: var(--ink-faint); }
/* destUrl があるチップは「押せる」= 応募ページへのリンク */
a.chip--link { text-decoration: none; cursor: pointer; font-weight: 700; }
a.chip--link:hover { background: color-mix(in srgb, currentColor 12%, transparent); }
a.chip--link:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* --- 応募導線（第2フェーズ） --- */
/* 応募ボタン: このページで最も目立つ要素 */
.apply {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 11px 20px; border-radius: 8px;
  background: var(--accent); color: var(--on-accent);
  font-size: 15px; font-weight: 700; line-height: 1.4;
  text-decoration: none; white-space: nowrap;
  box-shadow: 0 1px 2px rgba(18, 23, 43, .16);
}
.apply:hover { filter: brightness(1.08); text-decoration: none; }
.apply:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.apply__arrow { font-family: var(--mono); }
.apply--sm { padding: 7px 14px; font-size: 13px; border-radius: 6px; }

.cta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; margin: 4px 0 2px; }
.cta--sm { margin: 6px 0 0; }
.readmore { font-size: 13px; color: var(--ink-soft); text-decoration: underline; text-decoration-color: var(--rule); }
.readmore:hover { color: var(--accent); }

/* 行き先の明示（黙って別ドメインに飛ばさない） */
.dest-hint {
  display: inline-flex; align-items: center; gap: 4px;
  margin-left: 8px; font-size: 12.5px; font-weight: 500;
  color: var(--accent); font-family: var(--mono); white-space: nowrap;
}
.dest-hint__arrow { opacity: .8; }
.rank__title.has-dest a, .row__title.has-dest a, .offer__title a { text-decoration-color: color-mix(in srgb, var(--accent) 55%, transparent); }

/* 締切バッジ */
.dl {
  font-size: 12px; font-weight: 700; line-height: 1.6; white-space: nowrap;
  padding: 2px 9px; border-radius: 4px; border: 1px solid currentColor;
}
.dl--urgent {
  color: var(--on-accent); background: var(--urgent); border-color: var(--urgent);
  animation: pulse 1.6s ease-in-out infinite;
}
.dl--soon { color: var(--hot); background: color-mix(in srgb, var(--hot) 12%, var(--surface)); }
.dl--near { color: var(--warn-strong); background: color-mix(in srgb, var(--warn-strong) 10%, var(--surface)); }
.dl--far { color: var(--ink-soft); background: color-mix(in srgb, var(--rule) 45%, var(--surface)); border-color: var(--rule); }
.dl--expired { color: var(--ink-soft); background: transparent; border-style: dashed; font-weight: 500; }
.dl--start { color: var(--calm); background: color-mix(in srgb, var(--calm) 12%, var(--surface)); }
@keyframes pulse { 50% { opacity: .75; } }
@media (prefers-reduced-motion: reduce) { .dl--urgent { animation: none; } }

/* 締切切れは淡色に落とす */
.is-expired { opacity: .62; }
.is-expired .row__title, .is-expired .rank__title { text-decoration: line-through; text-decoration-thickness: 1px; }

/* いま応募できるもの */
.offers { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
.offer {
  display: flex; flex-direction: column; gap: 9px;
  background: var(--surface); border: 1px solid var(--rule); border-radius: 8px;
  box-shadow: var(--shadow); padding: 16px 18px 18px;
  border-left: 3px solid var(--accent);
}
.offer--urgent { border-left-color: var(--urgent); }
.offer--soon { border-left-color: var(--hot); }
.offer--near { border-left-color: var(--warm); }
.offer__tags { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.offer__title { margin: 0; font-size: 16px; font-weight: 700; line-height: 1.5; text-wrap: pretty; }
.offer__title .dest-hint { margin-left: 6px; }
.offer__when { margin: 0; font-size: 12px; color: var(--ink-faint); font-family: var(--mono); }
.sec--offers .sec-head h2 { font-size: 21px; }

/* --- ツイートプレビュー --- */
.tweets { display: flex; flex-direction: column; gap: 12px; }
.tweet { background: var(--surface); border: 1px solid var(--rule); border-radius: 8px; overflow: hidden; }
.tweet__head {
  display: flex; align-items: center; justify-content: space-between; gap: 14px;
  padding: 10px 16px; border-bottom: 1px solid var(--rule); background: color-mix(in srgb, var(--paper) 55%, var(--surface));
}
.tweet__label { font-family: var(--mono); font-size: 12px; letter-spacing: .06em; color: var(--ink-soft); }
.meter { display: flex; align-items: center; gap: 8px; }
.meter__track { width: 84px; height: 4px; background: var(--rule); border-radius: 2px; overflow: hidden; }
.meter__fill { display: block; height: 100%; background: var(--calm); }
.meter--near .meter__fill { background: var(--warm); }
.meter--over .meter__fill { background: var(--hot); }
.meter__num { font-family: var(--mono); font-size: 12px; font-variant-numeric: tabular-nums; color: var(--ink-soft); }
.meter__max { color: var(--ink-faint); }
.tweet__text {
  margin: 0; padding: 18px 20px; font-family: var(--sans); font-size: 15px; line-height: 1.85;
  white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere;
}

/* --- 最新情報リスト --- */
.rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.row { display: grid; grid-template-columns: 92px 1fr; gap: 16px; padding: 14px 4px; border-bottom: 1px solid var(--rule); }
.row:last-child { border-bottom: 0; }
.row__time { font-family: var(--mono); font-size: 12.5px; color: var(--ink-faint); font-variant-numeric: tabular-nums; padding-top: 3px; }
.row__main { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.row__title { font-size: 15px; line-height: 1.6; font-weight: 500; }
.row__meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.row__src { font-family: var(--mono); font-size: 11.5px; color: var(--ink-faint); }

/* --- 注記 --- */
.callout {
  border: 1px solid var(--rule); border-radius: 8px; padding: 16px 20px;
  background: var(--surface); color: var(--ink-soft); font-size: 14px;
}
.callout strong { color: var(--ink); }
.foot { color: var(--ink-faint); font-size: 12.5px; font-family: var(--mono); text-align: center; }

@media (max-width: 560px) {
  .rank { grid-template-columns: 52px 1fr; }
  .rank__body { padding: 16px; }
  .row { grid-template-columns: 1fr; gap: 6px; }
  .row__time { padding-top: 0; }
}
</style>

<div class="wrap">
  <header class="masthead">
    <span class="masthead__eyebrow">Daily ranking</span>
    <h1 class="masthead__title">TCG注目ニュース TOP${top.length}</h1>
    <p class="masthead__date">${esc(dateLabel)}　${
      posted
        ? `<strong>投稿済み</strong>${tweetUrl ? ` — <a href="${esc(safeUrl(tweetUrl))}" target="_blank" rel="noopener noreferrer">投稿を見る</a>` : ''}`
        : '未投稿（ドライラン）'
    }</p>
    <div class="foil" aria-hidden="true"></div>
  </header>

  <div class="stats">
    ${statCells
      .map(
        ([label, value, unit]) => `<div class="stat">
      <span class="stat__label">${esc(label)}</span>
      <span class="stat__value">${esc(value)}<span class="stat__unit">${esc(unit)}</span></span>
    </div>`
      )
      .join('')}
  </div>

  ${
    offers.length === 0
      ? ''
      : `<section class="sec--offers">
    <div class="sec-head">
      <h2>🎯 いま応募できるもの</h2>
      <span class="note">締切が近い順 · ${offers.length}件</span>
    </div>
    <div class="offers">${offers.map((it) => applyCard(it, tz, now)).join('')}</div>
  </section>`
  }

  <section>
    <div class="sec-head">
      <h2>今日のランキング</h2>
      <span class="note">直近48時間の記事から選出</span>
    </div>
    ${
      top.length === 0
        ? '<p class="callout">該当するニュースが見つかりませんでした。投稿はスキップされます。</p>'
        : `<div class="ranks">${top.map((it, i) => rankCard(it, i, tz, now)).join('')}</div>`
    }
  </section>

  ${
    texts.length === 0
      ? ''
      : `<section>
    <div class="sec-head">
      <h2>投稿される文面</h2>
      <span class="note">${style === 'single' ? '単発' : 'スレッド'} · 全${texts.length}本</span>
    </div>
    <div class="tweets">${texts.map((t, i) => tweetBox(t, i, texts.length, style)).join('')}</div>
    <p class="callout">数値は<strong>Xの重み付き文字数</strong>です。日本語は1文字=2、URLは長さに関係なく23として数えます。上限280。</p>
  </section>`
  }

  <section>
    <div class="sec-head">
      <h2>アプリに載る最新情報</h2>
      <span class="note">新しい順 · ${feedItems.length}件</span>
    </div>
    ${
      feedItems.length === 0
        ? '<p class="callout">掲載できる記事がありません。</p>'
        : `<ul class="rows">${feedItems.map((it) => feedRow(it, tz, now)).join('')}</ul>`
    }
  </section>

  <p class="foot">generated ${esc(genAt)}</p>
</div>`;
}

/**
 * レポートをファイルに書き出す。
 * @param {string} html
 * @param {string} path
 * @returns {Promise<{path:string, bytes:number}>}
 */
export async function writeReport(html, path) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, html, 'utf8');
  return { path, bytes: Buffer.byteLength(html, 'utf8') };
}
