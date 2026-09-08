/**
 * tools/verify-feed.mjs
 *
 * いま公開している feed.json の内容が、情報源の現在の表示と一致するかを照合する。
 *
 * 作った理由:
 *   通販のPAOの商品名に「お1人様 6 BOXまで」と出していたが、
 *   店側は既に「4 BOXまで」に変更していた。
 *   商品ページは変化するのに、こちらは取得時のスナップショットを出し続ける。
 *   古い情報で応募条件を誤解させるのは、このツールの目的に真っ向から反する。
 *
 * やること:
 *   1. 情報源を取り直す
 *   2. feed.json の各項目が、今も同じ内容で存在するか照合する
 *   3. 消えた／変わった項目を報告する
 *
 * 使い方:
 *   node tools/verify-feed.mjs            # 照合して結果を表示
 *   node tools/verify-feed.mjs --fix      # 食い違った項目を feed.json から取り除く
 *   node tools/verify-feed.mjs --json     # 機械可読な結果を出す（CI用）
 *
 * 終了コード: 食い違いがあれば 1（CIで検知できるように）
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchOfficialItems } from '../src/sources/official.js';
import { fetchShopItems } from '../src/sources/shops.js';
import { canonicalizeUrl } from '../src/resolve.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const FIX = args.includes('--fix');
const AS_JSON = args.includes('--json');

const readJson = async (rel) => JSON.parse(await readFile(join(ROOT, rel), 'utf8'));

/** 比較用にURLを正規化する */
function urlKey(u) {
  if (typeof u !== 'string' || !u) return '';
  try {
    return canonicalizeUrl(u);
  } catch {
    return u;
  }
}

/** 比較用にタイトルを正規化する（表記ゆれは無視し、意味のある差だけ見る） */
function titleKey(t) {
  return String(t || '')
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .toLowerCase();
}

async function main() {
  const feed = await readJson('public/feed.json');
  const items = Array.isArray(feed.items) ? feed.items : [];
  if (items.length === 0) {
    console.log('feed.json に項目がありません。先に収集を実行してください。');
    process.exit(0);
  }

  // 情報源を取り直す（feed の生成時と同じ条件で）
  const [officialCfg, shopCfg] = await Promise.all([
    readJson('config/official-sites.json'),
    readJson('config/shop-sources.json'),
  ]);
  const now = new Date();
  const [official, shops] = await Promise.all([
    fetchOfficialItems(officialCfg, { now, maxAgeHours: 168, concurrency: 3 }).catch(() => []),
    fetchShopItems(shopCfg, { now, maxAgeHours: 168, concurrency: 3 }).catch(() => []),
  ]);

  /** 現在の情報源にある項目: URL → タイトル */
  const live = new Map();
  for (const it of [...official, ...shops]) {
    const k = urlKey(it.url || it.destUrl);
    if (k) live.set(k, it.title || '');
  }

  const ok = [];
  const changed = [];
  const gone = [];
  const unknown = [];

  for (const it of items) {
    // 照合対象は「情報源の一覧に載っていた項目」だけ。
    // ニュース記事は一覧から流れて消えるのが正常なので対象外。
    // kind は detectKind() が sourceName から推測するので当てにならない。
    // 実際の出所は tier に入っている（shop / official / news）。
    const isListing = it.tier === 'shop' || it.tier === 'official';
    const k = urlKey(it.destUrl || it.url);
    if (!isListing || !k) {
      unknown.push(it);
      continue;
    }
    if (!live.has(k)) {
      gone.push(it);
      continue;
    }
    const before = titleKey(it.title);
    const after = titleKey(live.get(k));
    if (before !== after) {
      changed.push({ item: it, now: live.get(k) });
    } else {
      ok.push(it);
    }
  }

  const result = {
    generatedAt: feed.generatedAt,
    checkedAt: now.toISOString(),
    total: items.length,
    ok: ok.length,
    changed: changed.length,
    gone: gone.length,
    skipped: unknown.length,
  };

  if (AS_JSON) {
    console.log(JSON.stringify({ ...result, changed, gone: gone.map((g) => g.title) }, null, 2));
  } else {
    const age = Math.round((now.getTime() - Date.parse(feed.generatedAt)) / 60000);
    console.log(`feed.json の生成: ${feed.generatedAt}（${age}分前）`);
    console.log('');
    console.log(`  一致       : ${ok.length}件`);
    console.log(`  内容が変化 : ${changed.length}件`);
    console.log(`  消えている : ${gone.length}件`);
    console.log(`  照合対象外 : ${unknown.length}件（ニュース記事など）`);

    if (changed.length) {
      console.log('');
      console.log('=== 内容が変わった項目（古い情報を出している）===');
      for (const c of changed) {
        console.log(`  いま公開中: ${c.item.title}`);
        console.log(`  情報源の今: ${c.now}`);
        console.log(`  ${c.item.destUrl || c.item.url}`);
        console.log('');
      }
    }
    if (gone.length) {
      console.log('=== 情報源から消えた項目（受付終了・売切の可能性）===');
      for (const g of gone.slice(0, 15)) {
        console.log(`  ${g.title.slice(0, 60)}`);
      }
      if (gone.length > 15) console.log(`  …ほか ${gone.length - 15}件`);
    }
  }

  if (FIX && (changed.length || gone.length)) {
    const badIds = new Set([...changed.map((c) => c.item.id), ...gone.map((g) => g.id)]);
    const kept = items.filter((it) => !badIds.has(it.id));
    const next = { ...feed, items: kept, verifiedAt: now.toISOString() };
    await writeFile(join(ROOT, 'public/feed.json'), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    console.log('');
    console.log(`--fix: 食い違った ${badIds.size}件を取り除きました（残り ${kept.length}件）`);
  }

  process.exit(changed.length || gone.length ? 1 : 0);
}

main().catch((err) => {
  console.error('照合に失敗しました:', err.message);
  process.exit(2);
});
