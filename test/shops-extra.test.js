/**
 * test/shops-extra.test.js — 区画K: カードショップ・量販店の情報源追加ぶんのユニットテスト
 *
 * ネットワークアクセスなしで動く。実行: node --test test/shops-extra.test.js
 * HTML断片は 2026-08-30 に実際に取得したページからの抜粋（作り物ではない）。
 * 長すぎる装飾マークアップだけ間引いてあり、パターンが依存するタグ
 *   ・カードラボ: <li class="list_item_cell ..."> / <a href=".../product/N" class="item_data_link"> / <p class="item_name"><span class="goods_name">
 *   ・ミントモール: <a href="/products/detail.php?product_id=N" (改行) title="..." class="thumbnail">
 * は実物どおりに残してある。
 *
 * 既存の test/shops.test.js は編集していない（このファイルは追加ぶんだけを見る）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { parseShopList, fetchShopItems, USER_AGENT } from '../src/sources/shops.js';

const CONFIG_PATH = fileURLToPath(new URL('../config/shop-sources.json', import.meta.url));

/** 設定ファイルから id 指定でサイト定義を取り出す（設定と実HTMLを突き合わせるため） */
async function siteConfig(id) {
  const cfg = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
  const site = cfg.sites.find((s) => s.id === id);
  assert.ok(site, `config/shop-sources.json に ${id} が無い`);
  return site;
}

/* ================================================================== */
/* 検体: カードラボ 新作予約                                          */
/* https://www.c-labo-online.jp/product-group/2691?num=120&sort=new    */
/* ================================================================== */

/**
 * 1件目 = 受付締切がタイトルに入った予約BOX（採用）
 * 2件目 = [書籍]（titleExclude で落ちる。中身は遊戯王だが本なので対象外）
 * 3件目 = ポケモンごいた＝ボードゲーム（titleFilter にカード語が無いので落ちる）
 * 4件目 = 【予約/抽選】付きのデュエマ（採用・lottery タグが付く側の代表）
 */
const CLABO_YOYAKU_HTML = `
<ul class="flex_layout flex_wrap reset_list_style tiled_list">
  <li class="list_item_cell wrapped_item flex_layout list_item_407097 list_item_lowstock">
    <div class="item_data">
      <a href="https://www.c-labo-online.jp/product/407097" class="item_data_link">
        <div class="list_item_data">
          <p class="item_name">
<span class="goods_name">※9月12日まで受付※【予約】[新品ボックス]DIVINE CROSS ディヴァインクロス ブースターパック 『ローゼンメイデン』(1BOX=20パック) [2610/22]</span>
          </p>
        </div>
      </a>
    </div>
  </li>
  <li class="list_item_cell wrapped_item flex_layout list_item_398305 list_item_soldout">
    <div class="item_data">
      <a href="https://www.c-labo-online.jp/product/398305" class="item_data_link">
        <div class="list_item_data">
          <p class="item_name">
<span class="goods_name">[書籍]遊☆戯☆王OCGストラクチャーズ 12 [同梱カード 遊☆戯☆王OCG ★「道化の一座 ハット」] [26年8月]</span>
          </p>
        </div>
      </a>
    </div>
  </li>
  <li class="list_item_cell wrapped_item flex_layout list_item_407247">
    <div class="item_data">
      <a href="https://www.c-labo-online.jp/product/407247" class="item_data_link">
        <div class="list_item_data">
          <p class="item_name">
<span class="goods_name">【予約】[新品]ポケモンごいた [再入荷/26年9月下旬] </span>
          </p>
        </div>
      </a>
    </div>
  </li>
  <li class="list_item_cell wrapped_item flex_layout list_item_381528 list_item_soldout">
    <div class="item_data flex_layout">
      <a href="https://www.c-labo-online.jp/product/381528" class="item_data_link">
        <div class="list_item_data">
          <p class="item_name">
<span class="goods_name">【予約/抽選】[新品]デュエル・マスターズTCG ドキドキつよいデッキ 25の王道【DM26-SD1】 [再販/2608]</span>
          </p>
        </div>
      </a>
    </div>
  </li>
</ul>
`;

/** 相対hrefのケース。おちゃのこネットは絶対URLを吐くが、テンプレ変更で相対になっても壊れないことの担保 */
const CLABO_YOYAKU_RELATIVE_HTML = `
<li class="list_item_cell wrapped_item flex_layout list_item_406934">
  <div class="item_data">
    <a href="/product/406934" class="item_data_link">
      <div class="list_item_data">
        <p class="item_name">
<span class="goods_name">【予約】[新品]Xross Stars クロススターズ EXスタートデッキ 『ぶいすぽっ！』 [2610/30]</span>
        </p>
      </div>
    </a>
  </div>
</li>
`;

/* ================================================================== */
/* 検体: ミントモール カードゲーム【ボックス】新着順                  */
/* /products/list.php?category_id=8622&orderby=date&disp_number=50     */
/* ================================================================== */

/**
 * ミントモールは1件が <a> 1タグで、href（相対）と title（商品名）が同じタグに入っている。
 * href と title の間に改行＋インデントが入るのが実物どおり（itemPattern の \\s+ がこれを吸収する）。
 * 3件目だけは実物の別カテゴリにあるサイン会チケットを同じタグ形に置き直したもので、
 * titleExclude（チケット/サイン会）が効くことの確認用。
 */
const MINT_HTML = `
<div class="list_area clearfix col-xs-6 col-sm-6 col-md-4 col-lg-3 padding-xs" id="products_area">
  <a href="/products/detail.php?product_id=1321834"
            title="◆予約◆マジック:ザ・ギャザリング MTG スター・トレック 統率者デッキ 日本語版" class="thumbnail">
    <div class="image_area"><img src="https://8zI3k70.mint-mall.net/upload/save_image/08271656_6a8fedb13bd1a.jpg" alt="◆予約◆マジック:ザ・ギャザリング MTG スター・トレック 統率者デッキ 日本語版" class="img-responsive" /></div>
  </a>
</div>
<div class="list_area clearfix col-xs-6 col-sm-6 col-md-4 col-lg-3 padding-xs" id="products_area">
  <a href="/products/detail.php?product_id=1321837"
            title="◆予約◆ウルトラマンカードゲーム エクストラブースターパック01 夢のUNION" class="thumbnail">
    <div class="image_area"></div>
  </a>
</div>
<div class="list_area clearfix col-xs-6 col-sm-6 col-md-4 col-lg-3 padding-xs" id="products_area">
  <a href="/products/detail.php?product_id=1300001"
            title="◆予約◆矢野燿大氏 サイン会チケット [9月19日(土) 会場: MINT三宮店]" class="thumbnail">
    <div class="image_area"></div>
  </a>
</div>
`;

/* ================================================================== */
/* カードラボ 新作予約                                                */
/* ================================================================== */

test('c-labo-yoyaku: 新作予約一覧から title / link を取り出す', async () => {
  const site = await siteConfig('c-labo-yoyaku');
  const out = parseShopList(CLABO_YOYAKU_HTML, site);

  assert.equal(out.length, 2, `採用2件のはずが ${out.map((o) => o.title).join(' / ')}`);
  assert.equal(
    out[0].title,
    '※9月12日まで受付※【予約】[新品ボックス]DIVINE CROSS ディヴァインクロス ブースターパック 『ローゼンメイデン』(1BOX=20パック) [2610/22]'
  );
  assert.equal(out[0].link, 'https://www.c-labo-online.jp/product/407097');
  assert.equal(out[0].pubDate, '', '一覧に日付が無いので pubDate は空（親が現在時刻を入れる）');

  assert.match(out[1].title, /デュエル・マスターズTCG ドキドキつよいデッキ 25の王道/);
  assert.equal(out[1].link, 'https://www.c-labo-online.jp/product/381528');
});

test('c-labo-yoyaku: titleExclude が [書籍] を落とす（遊戯王でも本なら対象外）', async () => {
  const site = await siteConfig('c-labo-yoyaku');
  const out = parseShopList(CLABO_YOYAKU_HTML, site);
  assert.ok(!out.some((o) => o.title.includes('[書籍]')), '書籍が混ざっている');
  assert.ok(!out.some((o) => o.link.endsWith('/product/398305')), '書籍のURLが混ざっている');
});

test('c-labo-yoyaku: titleFilter がカード商品以外（ボードゲーム）を落とす', async () => {
  const site = await siteConfig('c-labo-yoyaku');
  const out = parseShopList(CLABO_YOYAKU_HTML, site);
  assert.ok(!out.some((o) => o.title.includes('ポケモンごいた')), 'ボードゲームが混ざっている');
});

test('c-labo-yoyaku: 相対URLを baseUrl で絶対化する', async () => {
  const site = await siteConfig('c-labo-yoyaku');
  const out = parseShopList(CLABO_YOYAKU_RELATIVE_HTML, site);
  assert.equal(out.length, 1);
  assert.equal(out[0].link, 'https://www.c-labo-online.jp/product/406934');
});

test('c-labo-yoyaku: 既存の c-labo-new とパターンを共有している（同じおちゃのこネット構造）', async () => {
  const yoyaku = await siteConfig('c-labo-yoyaku');
  const neww = await siteConfig('c-labo-new');
  assert.equal(yoyaku.itemPattern, neww.itemPattern);
  assert.equal(yoyaku.linkPattern, neww.linkPattern);
  assert.equal(yoyaku.titlePattern, neww.titlePattern);
  assert.notEqual(yoyaku.url, neww.url, 'URLまで同じなら追加した意味が無い');
});

/* ================================================================== */
/* ミントモール                                                        */
/* ================================================================== */

test('mint-mall-cardgame-box: aタグ1つから title / link を取り出す', async () => {
  const site = await siteConfig('mint-mall-cardgame-box');
  const out = parseShopList(MINT_HTML, site);

  assert.equal(out.length, 2, `採用2件のはずが ${out.map((o) => o.title).join(' / ')}`);
  assert.equal(out[0].title, '◆予約◆マジック:ザ・ギャザリング MTG スター・トレック 統率者デッキ 日本語版');
  assert.equal(out[1].title, '◆予約◆ウルトラマンカードゲーム エクストラブースターパック01 夢のUNION');
});

test('mint-mall-cardgame-box: 相対URLを baseUrl で絶対化する（クエリ付きパス）', async () => {
  const site = await siteConfig('mint-mall-cardgame-box');
  const out = parseShopList(MINT_HTML, site);
  assert.equal(out[0].link, 'https://www.mint-mall.net/products/detail.php?product_id=1321834');
  assert.equal(out[1].link, 'https://www.mint-mall.net/products/detail.php?product_id=1321837');
});

test('mint-mall-cardgame-box: titleExclude がイベントチケットを落とす', async () => {
  const site = await siteConfig('mint-mall-cardgame-box');
  const out = parseShopList(MINT_HTML, site);
  assert.ok(!out.some((o) => o.title.includes('サイン会チケット')), 'チケットが混ざっている');
});

test('mint-mall-cardgame-box: href と title の間の改行・インデントを吸収する', async () => {
  const site = await siteConfig('mint-mall-cardgame-box');
  // 改行を消して1行にしても、逆に空白を増やしても同じ結果になること
  const oneLine = MINT_HTML.replace(/"\n\s+title=/g, '" title=');
  const padded = MINT_HTML.replace(/"\n\s+title=/g, '"\n\n      \t title=');
  const base = parseShopList(MINT_HTML, site).map((o) => o.link);
  assert.deepEqual(parseShopList(oneLine, site).map((o) => o.link), base);
  assert.deepEqual(parseShopList(padded, site).map((o) => o.link), base);
});

/* ================================================================== */
/* RawItem への変換（fetch をスタブ・ネットには出ない）                */
/* ================================================================== */

/** globalThis.fetch を差し替える */
function stubFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

/** console を黙らせる */
function muteConsole() {
  const warn = console.warn;
  const log = console.log;
  console.warn = () => {};
  console.log = () => {};
  return {
    restore() {
      console.warn = warn;
      console.log = log;
    },
  };
}

const htmlResponse = (html) =>
  new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });

test('追加2サイト: destUrl / destLabel / tier / kind が埋まる', async () => {
  const cfg = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
  const sites = cfg.sites.filter((s) => ['c-labo-yoyaku', 'mint-mall-cardgame-box'].includes(s.id));
  assert.equal(sites.length, 2);

  const body = { 'c-labo-yoyaku': CLABO_YOYAKU_HTML, 'mint-mall-cardgame-box': MINT_HTML };
  const stub = stubFetch(async (url) => {
    const hit = sites.find((s) => url.startsWith(s.url.split('?')[0]));
    return htmlResponse(body[hit.id]);
  });
  const mute = muteConsole();
  try {
    const items = await fetchShopItems(
      { defaults: { ...cfg.defaults, retry: 0, delayMs: 0 }, sites },
      { now: new Date('2026-08-30T12:00:00Z') }
    );

    assert.equal(items.length, 4, 'カードラボ2件＋ミント2件');
    for (const it of items) {
      assert.equal(it.kind, 'shop');
      assert.equal(it.tier, 'shop');
      assert.equal(it.destUrl, it.url, '小売店由来は商品ページがそのまま応募先');
      assert.ok(it.destUrl.startsWith('https://'), `destUrl が絶対URLでない: ${it.destUrl}`);
      assert.ok(it.destLabel, 'destLabel が空');
      assert.ok(it.sourceWeight <= 1.4 && it.sourceWeight >= 1.2, `weight が範囲外: ${it.sourceWeight}`);
    }
    const labels = new Set(items.map((i) => i.destLabel));
    assert.deepEqual([...labels].sort(), ['カードラボ', 'ミントモール']);
  } finally {
    mute.restore();
    stub.restore();
  }
});

test('追加2サイト: 抽選・予約の語を含むタイトルには lottery タグが付く', async () => {
  const cfg = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
  const sites = cfg.sites.filter((s) => s.id === 'c-labo-yoyaku');
  const stub = stubFetch(async () => htmlResponse(CLABO_YOYAKU_HTML));
  const mute = muteConsole();
  try {
    const items = await fetchShopItems({ defaults: { retry: 0, delayMs: 0 }, sites }, {});
    assert.equal(items.length, 2);
    for (const it of items) {
      assert.ok(it.ips.includes('lottery'), `lottery が付いていない: ${it.title}`);
    }
    // ips は設定側では空。IP判定は親の collect.js がタイトルから行う約束
    assert.deepEqual(sites[0].ips, []);
  } finally {
    mute.restore();
    stub.restore();
  }
});

test('追加サイトもブラウザ偽装しないUAで取りに行く', async () => {
  const cfg = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
  const sites = cfg.sites.filter((s) => s.id === 'mint-mall-cardgame-box');
  const stub = stubFetch(async () => htmlResponse(MINT_HTML));
  const mute = muteConsole();
  try {
    await fetchShopItems({ defaults: { retry: 0, delayMs: 0 }, sites }, {});
    const ua = stub.calls[0].init.headers['user-agent'];
    assert.equal(ua, USER_AGENT);
    assert.ok(!/Chrome|Safari\/\d|Firefox|Edg\//.test(ua), 'ブラウザになりすましている');
  } finally {
    mute.restore();
    stub.restore();
  }
});

/* ================================================================== */
/* 設定ファイル側の不変条件（今回追加ぶん）                            */
/* ================================================================== */

test('config: 今回追加したIDが全て存在し、既存5サイトを壊していない', async () => {
  const cfg = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
  const ids = new Set(cfg.sites.map((s) => s.id));

  for (const id of [
    'c-labo-yoyaku',
    'mint-mall-cardgame-box',
    'mint-mall-lottery',
    'yuyu-tei',
    'cardrush',
    'hareruyamtg',
    'itoyokado',
    'hobby-station',
    'aeon',
  ]) {
    assert.ok(ids.has(id), `追加したはずの ${id} が無い`);
  }

  // 既存の稼働5サイトが有効なままであること（追記で壊していないことの担保）
  for (const id of [
    'rakuten-books-lottery',
    'rakuten-books-tcg-new',
    'rakuten-books-dragonball',
    'rakuten-books-duelmasters',
    'c-labo-new',
  ]) {
    const s = cfg.sites.find((x) => x.id === id);
    assert.ok(s, `既存サイト ${id} が消えている`);
    assert.equal(s.enabled, true, `既存サイト ${id} が無効化されている`);
  }
});

test('config: 有効にした追加サイトの weight は 1.2〜1.35 の範囲', async () => {
  const cfg = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
  for (const id of ['c-labo-yoyaku', 'mint-mall-cardgame-box']) {
    const s = cfg.sites.find((x) => x.id === id);
    assert.equal(s.enabled, true);
    assert.ok(s.weight >= 1.2 && s.weight <= 1.35, `${id}: weight ${s.weight} が 1.2〜1.35 の外`);
  }
});

test('config: 無効にした追加サイトは note に理由と「回避していない」根拠を書いている', async () => {
  const cfg = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
  for (const id of ['mint-mall-lottery', 'yuyu-tei', 'cardrush', 'hareruyamtg', 'itoyokado', 'hobby-station', 'aeon']) {
    const s = cfg.sites.find((x) => x.id === id);
    assert.equal(s.enabled, false, `${id} が有効になっている`);
    assert.match(s.note, /enabled:false の理由/, `${id}: 無効化の理由が note に無い`);
    assert.match(s.note, /robots\.txt|接続|JS描画|シングル|取り扱|ブロック/, `${id}: 調査の実測根拠が note に無い`);
  }
});

test('config: 有効な追加サイトはトップページではなく一覧ページを見ている', async () => {
  const cfg = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
  for (const id of ['c-labo-yoyaku', 'mint-mall-cardgame-box']) {
    const s = cfg.sites.find((x) => x.id === id);
    const u = new URL(s.url);
    assert.ok(u.pathname !== '/', `${id}: トップページを見ている（一覧ページを指定すること）`);
  }
});
