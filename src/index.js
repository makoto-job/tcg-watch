#!/usr/bin/env node
/**
 * 区画D: CLI エントリポイント
 *
 * TCG/人気IPの最新ニュースを収集 → ランキング → Xへ投稿 → feed.json を出力。
 *
 * 使い方:
 *   node src/index.js --dry-run      # 既定。投稿せず内容を表示
 *   node src/index.js --post         # 実際にXへ投稿
 *   node src/index.js --auth-check   # X APIの疎通確認だけ
 *   node src/index.js --help
 *
 * npm依存ゼロ / Node標準のみ。
 */

import { loadConfig, hasXCreds, missingXCredKeys } from './config.js';
import { loadPosted, isPosted, markPosted, savePosted } from './store.js';
import { buildFeedJson, writeFeedJson } from './feed.js';
import { buildReportHtml, writeReport } from './report.js';
import { enrichItems } from './enrich.js';
import { collectAll } from './collect.js';
import { rankItems, selectTop } from './score.js';
import { buildThread, buildSingle, weightedLength } from './format.js';
import { pathToFileURL } from 'node:url';
import { verifyCredentials, postThread } from './x.js';

// ────────────────────────────────────────────────────────────
// 引数パース
// ────────────────────────────────────────────────────────────

const HELP = `
TCGニュース自動投稿bot

  使い方: node src/index.js [オプション]

  オプション:
    --dry-run          投稿せず内容をコンソールに表示する（既定）
    --post             実際にXへ投稿する（--dry-run とは併用不可）
    --no-post          投稿しない（--dry-run と同じ。feed.json だけ更新したい時に）
    --verbose          詳細ログを出す
    --auth-check       X APIの疎通確認だけして終了する
    --top=N            ランキングに載せる件数（既定 3 / .env の TOP_N）
    --style=thread     スレッド形式で投稿（既定）
    --style=single     1ツイートに収める形式で投稿
    --no-feed          public/feed.json を書き出さない
    --max-age=H        収集対象とする記事の新しさ（時間・既定 168＝7日）
    --tweet-max-age=H  ツイートのTOP選出に使う新しさ（時間・既定 48）
    --html[=PATH]      実行結果をHTMLレポートで出力（既定 public/report.html）
    --no-enrich        応募ページ・締切の抽出をスキップ（高速確認用）
    --help, -h         このヘルプを表示

  例:
    node src/index.js --dry-run --verbose
    node src/index.js --post --top=5 --style=single
`;

/**
 * @param {string[]} argv
 * @returns {{dryRun:boolean, post:boolean, verbose:boolean, authCheck:boolean,
 *            top:number|null, style:'thread'|'single'|null, feed:boolean,
 *            maxAgeHours:number, help:boolean, errors:string[]}}
 */
export function parseArgs(argv) {
  const opts = {
    dryRun: false,
    post: false,
    noPost: false,
    verbose: false,
    authCheck: false,
    top: null,
    style: null,
    feed: true,
    maxAgeHours: 168,
    tweetMaxAgeHours: 48,
    html: null,
    noEnrich: false,
    help: false,
    errors: [],
  };

  for (const arg of argv) {
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--post') opts.post = true;
    else if (arg === '--no-post') opts.noPost = true;
    else if (arg === '--verbose' || arg === '-v') opts.verbose = true;
    else if (arg === '--auth-check') opts.authCheck = true;
    else if (arg === '--no-feed') opts.feed = false;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg.startsWith('--top=')) {
      const n = Number.parseInt(arg.slice('--top='.length), 10);
      if (!Number.isFinite(n) || n <= 0) opts.errors.push(`--top には1以上の整数を指定してください（受け取った値: ${arg}）`);
      else opts.top = n;
    } else if (arg.startsWith('--style=')) {
      const v = arg.slice('--style='.length);
      if (v !== 'thread' && v !== 'single') opts.errors.push(`--style は thread か single を指定してください（受け取った値: ${v}）`);
      else opts.style = v;
    } else if (arg === '--no-enrich') {
      opts.noEnrich = true;
    } else if (arg === '--html') {
      opts.html = 'public/report.html';
    } else if (arg.startsWith('--html=')) {
      const v = arg.slice('--html='.length).trim();
      if (!v) opts.errors.push('--html= にはファイルパスを指定してください');
      else opts.html = v;
    } else if (arg.startsWith('--tweet-max-age=')) {
      const n = Number.parseInt(arg.slice('--tweet-max-age='.length), 10);
      if (!Number.isFinite(n) || n <= 0) opts.errors.push(`--tweet-max-age には1以上の整数（時間）を指定してください（受け取った値: ${arg}）`);
      else opts.tweetMaxAgeHours = n;
    } else if (arg.startsWith('--max-age=')) {
      const n = Number.parseInt(arg.slice('--max-age='.length), 10);
      if (!Number.isFinite(n) || n <= 0) opts.errors.push(`--max-age には1以上の整数（時間）を指定してください（受け取った値: ${arg}）`);
      else opts.maxAgeHours = n;
    } else {
      opts.errors.push(`不明なオプションです: ${arg}（--help でヘルプを表示）`);
    }
  }

  if (opts.post && opts.dryRun) {
    opts.errors.push('--post と --dry-run は同時に指定できません。どちらか一方にしてください。');
  }
  if (opts.post && opts.noPost) {
    opts.errors.push('--post と --no-post は同時に指定できません。');
  }
  // 既定は dry-run
  if (!opts.post) opts.dryRun = true;

  return opts;
}

// ────────────────────────────────────────────────────────────
// 表示ヘルパー
// ────────────────────────────────────────────────────────────

const LINE = '─'.repeat(60);

/**
 * ツイート本文を枠線で囲んで表示する。消費文字数 (n/280) を併記。
 * @param {string} label
 * @param {string} text
 */
function printTweetBox(label, text) {
  let used = 0;
  try {
    used = weightedLength(text);
  } catch {
    used = text.length;
  }
  const over = used > 280 ? '  ⚠️ 280超過' : '';
  console.log(`┌${LINE}┐`);
  console.log(`│ ${label}  (${used}/280)${over}`);
  console.log(`├${LINE}┤`);
  for (const line of String(text).split('\n')) {
    console.log(`│ ${line}`);
  }
  console.log(`└${LINE}┘`);
}

/**
 * TOP の各アイテムの主IPから、config/sources.json の ips[key].hashtag を集める。
 * @param {any[]} top
 * @param {any} sources
 * @returns {string[]} 重複除去済みハッシュタグ配列
 */
export function collectHashtags(top, sources) {
  const ipsConfig = sources?.ips || {};
  const seen = new Set();
  const out = [];
  for (const item of top || []) {
    const key = Array.isArray(item?.ips) ? item.ips[0] : undefined;
    if (!key) continue;
    const tag = ipsConfig[key]?.hashtag;
    if (typeof tag === 'string' && tag !== '' && !seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────
// メイン
// ────────────────────────────────────────────────────────────

/**
 * @param {string[]} [argv=process.argv.slice(2)]
 * @returns {Promise<number>} 終了コード
 */
export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);

  if (opts.help) {
    console.log(HELP);
    return 0;
  }
  if (opts.errors.length > 0) {
    for (const e of opts.errors) console.error(`エラー: ${e}`);
    return 1;
  }

  // 1. 設定読み込み
  const config = await loadConfig();
  const topN = opts.top ?? config.env.topN;
  const style = opts.style ?? config.env.postStyle;
  const now = new Date();

  if (opts.verbose) {
    console.log(`[設定] TOP=${topN} / 形式=${style} / 収集範囲=${opts.maxAgeHours}時間 / ツイート対象=${opts.tweetMaxAgeHours}時間以内 / TZ=${config.env.tz}`);
    console.log(`[設定] モード=${opts.post ? '投稿(--post)' : 'ドライラン'} / feed.json=${opts.feed ? '出力する' : '出力しない'}`);
  }

  // 2. --auth-check なら疎通確認だけして終了
  if (opts.authCheck) {
    if (!hasXCreds(config)) {
      console.error('X APIの認証情報が足りません。');
      console.error(`不足している項目: ${missingXCredKeys(config).join(', ')}`);
      console.error('.env を作成し、4つの値をすべて設定してください（.env.example をコピーしてください）。');
      return 1;
    }
    const result = await verifyCredentials(config.env.xCreds);
    if (result?.ok) {
      console.log(`認証OK: @${result.username} として投稿できます。`);
      return 0;
    }
    console.error('認証に失敗しました。');
    console.error(`理由: ${result?.error || '不明なエラー'}`);
    console.error('確認事項:');
    console.error('  - 開発者ポータルのアプリ設定が「Read and write」になっているか');
    console.error('  - 権限変更後にアクセストークンを再生成したか（変更前のトークンは書き込み不可のままです）');
    console.error('  - .env の4つの値にコピーミス（前後の空白・改行）が無いか');
    return 1;
  }

  // --post なのに認証情報が無い場合は早期に案内
  if (opts.post && !hasXCreds(config)) {
    console.error('--post を指定しましたが、X APIの認証情報がありません。');
    console.error(`不足している項目: ${missingXCredKeys(config).join(', ')}`);
    console.error('.env を設定してください（.env.example をコピーして値を入れてください）。');
    return 1;
  }

  // 3. 収集
  // 公式サイト設定（無くても動く）
  let officialConfig = null;
  try {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    officialConfig = JSON.parse(await readFile(join(root, 'config/official-sites.json'), 'utf8'));
  } catch (err) {
    console.warn(`[設定] config/official-sites.json を読めませんでした（公式サイト監視をスキップ）: ${err.message}`);
  }

  // 小売店設定（無くても動く）
  let shopConfig = null;
  try {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    shopConfig = JSON.parse(await readFile(join(root, 'config/shop-sources.json'), 'utf8'));
  } catch (err) {
    console.warn(`[設定] config/shop-sources.json を読めませんでした（小売店監視をスキップ）: ${err.message}`);
  }

  const collected = await collectAll(config.sources, {
    officialConfig,
    shopConfig,
    now,
    maxAgeHours: opts.maxAgeHours,
    verbose: opts.verbose,
  });
  if (opts.verbose) console.log(`[収集] ${collected.length}件`);

  // 4. 投稿済みを除外
  const store = await loadPosted();
  const fresh = collected.filter((item) => !isPosted(store, item));
  const excluded = collected.length - fresh.length;
  if (opts.verbose) console.log(`[除外] 投稿済み ${excluded}件 → 残り ${fresh.length}件`);

  // 4.5 応募ページ・締切の抽出
  // 抽選/予約系の記事だけ本文を取得して、応募先URLと締切を割り出す。
  // ここが「記事を読む」から「応募する」への橋渡しになる。
  if (!opts.noEnrich) {
    try {
      await enrichItems(fresh, { concurrency: 4, verbose: opts.verbose });
      if (opts.verbose) {
        const withDest = fresh.filter((i) => i.destUrl).length;
        const withDeadline = fresh.filter((i) => i.deadline).length;
        console.log(`[応募導線] 応募リンク ${withDest}件 / 締切 ${withDeadline}件`);
      }
    } catch (err) {
      console.warn(`[応募導線] 抽出に失敗しました（続行します）: ${err.message}`);
    }
  }

  // 5. ランキング
  // IP重み(weight)は sources.json 側にあるため scoring にマージして渡す
  // 店名一覧はクラスタ間で応募リンクを引き継ぐ際の安全弁に使う
  let shopLabels = [];
  try {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    const shopsCfg = JSON.parse(await readFile(join(root, 'config/shops.json'), 'utf8'));
    shopLabels = (shopsCfg.shops || [])
      .flatMap((sh) => [sh.label, ...(sh.aliases || [])])
      .filter((v) => typeof v === 'string' && v.length >= 2);
  } catch {
    /* shops.json が無くても動く */
  }
  const scoringCfg = { ...config.scoring, ips: config.sources.ips, shopLabels };
  const ranked = rankItems(fresh, scoringCfg, now);
  // ツイートは「新しいニュース」だけを対象にする。
  // 収集は7日ぶんに広げてアプリのフィードに厚みを持たせつつ、
  // TOP3の選出は tweetMaxAgeHours（既定48時間）以内に限定する。
  const tweetCutoff = now.getTime() - opts.tweetMaxAgeHours * 3600 * 1000;
  const rankedForTweet = ranked.filter((r) => {
    const t = new Date(r.publishedAt).getTime();
    return !Number.isFinite(t) || t >= tweetCutoff;
  });
  // ツイートに載せる資格の判定。フィードには残すが、TOP3には出さないものを弾く。
  const LOTTERY_KEY = 'lottery';
  const tweetable = rankedForTweet.filter((r) => {
    // (1) 対象IPに1つも当てはまらないもの（lottery だけ）は載せない。
    //     デジモンカード等の対象外タイトルが1位に来るのを防ぐ。
    const hasTargetIp = (r.ips || []).some((k) => k !== LOTTERY_KEY);
    if (!hasTargetIp) return false;
    // (2) タイトルが途中で切れているものは載せない。
    //     プレミアムバンダイの一覧は商品名を20字程度で打ち切るため、
    //     そのままツイートすると「【予約販売】データカードダス ...」になる。
    if (/(\.\.\.|…)\s*$/.test(String(r.title || ''))) return false;
    return true;
  });
  if (opts.verbose) {
    const dropped = rankedForTweet.length - tweetable.length;
    if (dropped > 0) console.log(`[TOP選出] 対象外IP・タイトル切れ ${dropped}件を除外`);
  }
  const top = selectTop(
    tweetable.length > 0 ? tweetable : rankedForTweet.length > 0 ? rankedForTweet : ranked,
    topN
  );
  if (opts.verbose) console.log(`[集約] クラスタ数 ${ranked.length} / TOP ${top.length}件`);

  let tweetUrl = null;
  let posted = false;
  /** @type {string[]} HTMLレポートでも使うため外側で保持する */
  let tweetTexts = [];
  /** @type {Object|null} */
  let feedObj = null;

  if (top.length === 0) {
    // 6. TOPが0件 → 投稿はスキップするが feed.json は書き出す
    console.log('本日は該当ニュースなし（新規の記事が見つかりませんでした）。投稿はスキップします。');
  } else {
    // 7. 文面生成
    const hashtags = collectHashtags(top, config.sources);
    if (opts.verbose && hashtags.length > 0) console.log(`[ハッシュタグ] ${hashtags.join(' ')}`);

    let texts;
    if (style === 'single') {
      texts = [buildSingle(top, { date: now, hashtags })];
    } else {
      texts = buildThread(top, { date: now, hashtags }).map((t) => (typeof t === 'string' ? t : t.text));
    }
    tweetTexts = texts;

    // 8. 投稿 or ドライラン表示
    if (opts.post) {
      const result = await postThread(texts, config.env.xCreds);
      const urls = result?.urls || [];
      tweetUrl = urls[0] || null;
      posted = true;
      console.log(`投稿しました（${(result?.ids || []).length}件）。`);
      for (const u of urls) console.log(`  ${u}`);

      markPosted(store, top, new Date());
      const saved = await savePosted(store);
      if (opts.verbose) console.log(`[store] ${saved.path} に保存（${saved.count}件 / prune ${saved.pruned}件）`);
    } else {
      console.log('');
      console.log(`【ドライラン】以下の内容を投稿します（実際には投稿していません）  形式: ${style}`);
      console.log('');
      texts.forEach((t, i) => {
        printTweetBox(style === 'single' ? '単発ツイート' : `${i + 1}/${texts.length} 本目`, t);
        console.log('');
      });
      console.log('実際に投稿するには --post を付けて実行してください。');
    }
  }

  // 9. feed.json
  let feedResult = null;
  if (opts.feed || opts.html) {
    // 低スコアのノイズ記事（買取相場ページ等）はアプリのフィードから除外する。
    // 閾値は config/scoring.json の feedMinScore で調整可（0で無効）。
    const minScore = Number.isFinite(config.scoring?.feedMinScore)
      ? config.scoring.feedMinScore
      : 10;
    const topIds = new Set(top.map((t) => t.id));
    const feedRanked =
      minScore > 0 ? ranked.filter((r) => r.score >= minScore || topIds.has(r.id)) : ranked;
    if (opts.verbose) {
      console.log(`[フィード] スコア${minScore}未満を除外 → ${feedRanked.length}件`);
    }
    feedObj = buildFeedJson({
      ranked: feedRanked,
      top,
      tweetUrl,
      now,
      maxItems: 50,
      tz: config.env.tz,
    });
    if (opts.feed) feedResult = await writeFeedJson(feedObj, 'public/feed.json');
  }

  // 9.5 HTMLレポート
  let reportResult = null;
  if (opts.html) {
    const html = buildReportHtml({
      top,
      texts: tweetTexts,
      feedItems: feedObj ? feedObj.items : [],
      stats: {
        collected: collected.length,
        excluded,
        clusters: ranked.length,
        feedCount: feedObj ? feedObj.items.length : 0,
      },
      now,
      style,
      posted,
      tweetUrl,
      tz: config.env.tz,
    });
    reportResult = await writeReport(html, opts.html);
  }

  // 10. 結果サマリ
  console.log('');
  console.log(`┌${LINE}┐`);
  console.log('│ 実行結果サマリ');
  console.log(`├${LINE}┤`);
  console.log(`│ 収集件数      : ${collected.length}件`);
  console.log(`│ 投稿済み除外  : ${excluded}件`);
  console.log(`│ クラスタ数    : ${ranked.length}件`);
  if (top.length === 0) {
    console.log('│ TOP           : 該当なし');
  } else {
    top.forEach((it, i) => {
      console.log(`│ TOP${i + 1}          : ${it.title}`);
    });
  }
  console.log(`│ 投稿URL       : ${tweetUrl || (posted ? '(取得できず)' : '未投稿')}`);
  console.log(`│ feed.json     : ${feedResult ? `${feedResult.itemCount}件 → ${feedResult.path}` : '出力なし（--no-feed）'}`);
  if (reportResult) {
    console.log(`│ HTMLレポート  : ${reportResult.path}`);
  }
  console.log(`└${LINE}┘`);

  return 0;
}

// ────────────────────────────────────────────────────────────
// 実行
// ────────────────────────────────────────────────────────────

// このファイルが直接実行された場合のみ main() を走らせる（import 時は走らせない）
const isDirectRun = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isDirectRun) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      console.error('');
      console.error('予期せぬエラーで停止しました。');
      console.error(`メッセージ: ${err?.message || err}`);
      if (err?.stack) {
        console.error('');
        console.error('--- スタックトレース ---');
        console.error(err.stack);
      }
      console.error('');
      console.error('よくある原因: config/*.json が無い / ネットワーク不通 / .env の設定漏れ');
      process.exit(1);
    });
}
