/**
 * 在庫の除外設定が「効いているつもりで効いていない」状態を防ぐ。
 *
 * きっかけ:
 *   ミントモールの設定には stockExcludePattern があったのに、
 *   一覧50件のうち43件が売り切れなのに全件そのまま出していた。
 *
 *   原因は itemPattern が商品ブロックの開始タグだけを切り出していたこと。
 *     <a href="..." class="thumbnail">        ← ここまでしか見ていない
 *       <span class="soldout">SOLD OUT</span> ← 届いていない
 *   キャプチャが無いと切り出し範囲＝一致した文字列そのものになるため、
 *   在庫の印が範囲の外に落ちる。設定は正しく見えるので気づけない。
 *
 * この検査を入れた時点で、同じ形の間違いが他に2件見つかった
 * （famima-online-hobby / edion-tcg）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const load = async (rel) => {
  const cfg = JSON.parse(await readFile(join(ROOT, rel), 'utf8'));
  return Array.isArray(cfg) ? cfg : cfg.sites || [];
};

/** 正規表現にキャプチャ（丸カッコ）があるか。(?: や (?= は数えない */
function hasCaptureGroup(pattern) {
  return /\((?!\?)/.test(String(pattern || ''));
}

for (const [label, file] of [
  ['小売店', 'config/shop-sources.json'],
  ['公式サイト', 'config/official-sites.json'],
]) {
  test(`${label}: 在庫除外を設定したHTML情報源は、商品ブロック全体を切り出していること`, async () => {
    const sites = await load(file);
    const bad = [];
    for (const s of sites) {
      if (!s || s.enabled === false) continue;
      if (!s.stockExcludePattern) continue;
      if (s.type !== 'html' && s.type !== 'html-grouped') continue;
      if (!hasCaptureGroup(s.itemPattern)) bad.push(s.id);
    }
    assert.deepEqual(
      bad,
      [],
      `itemPattern にキャプチャが無いため在庫除外が効きません: ${bad.join(', ')}\n` +
        '商品ブロック全体を ( ) で囲って切り出してください。',
    );
  });
}

/**
 * ミントモール固有の回帰テスト。
 *
 * 「SOLD OUT」という文字列はこのサイトのページ内に474回現れる（大半は商品と無関係）。
 * これを除外条件に入れると一覧50件すべてが売り切れ判定になり、取得0件になる
 * （修正の途中で実際にそうなった）。売り切れの印は span の class="soldout" だけ。
 */
test('ミントモール: 在庫判定は class="soldout" に限る', async () => {
  const sites = await load('config/shop-sources.json');
  const mint = sites.find((s) => s.id === 'mint-mall-cardgame-box');
  assert.ok(mint, 'ミントモールの設定が見つかりません');
  assert.match(mint.stockExcludePattern, /class="soldout/);
  assert.ok(
    !/SOLD/i.test(mint.stockExcludePattern.replace(/class="soldout/gi, '')),
    '「SOLD OUT」の文字列そのものを条件にしてはいけません（全件が売り切れ判定になります）',
  );
  assert.match(mint.itemPattern, /list_area/);
});
