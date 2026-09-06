/**
 * test/shops-more.test.js — 区画N: 小売店の情報源を増やしたぶんのユニットテスト
 *
 * ネットワークアクセスなしで動く。実行: node --test test/shops-more.test.js
 *
 * 検体（HTML / JSON 断片）は 2026-09-06 に実際に取得したレスポンスからの抜粋で、作り物ではない。
 * 装飾マークアップと長いフィールドだけ間引き、パターンが依存する部分
 *   ・通販のPAO : <li class="itemList__unit"> / <a href="/view/item/N?category_page_id=..."> /
 *                 <p class="itemName"> / <span class="itemSoldout">SOLD OUT</span>
 *   ・CBトレコロ : <script> 内の const surveys = [ { category, title, announce, deadline, result, url } ]
 *   ・Yahoo/auPAY/Shopify/楽天 : listKey / titleKey / pathKey / dateKey / stockTextKey の各フィールド
 * は実物どおりに残してある。
 *
 * 既存の test/shops.test.js / test/shops-extra.test.js は編集していない。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { parseShopList, parseShopJson, resolveUrlTemplate } from '../src/sources/shops.js';

const CONFIG_PATH = fileURLToPath(new URL('../config/shop-sources.json', import.meta.url));

/** 設定ファイルから id 指定でサイト定義を取り出す（設定と実レスポンスを突き合わせるため） */
async function siteConfig(id) {
  const cfg = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
  const site = cfg.sites.find((s) => s.id === id);
  assert.ok(site, `config/shop-sources.json に ${id} が無い`);
  return site;
}

async function allSites() {
  const cfg = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
  return cfg.sites;
}

/* ================================================================== */
/* 検体1: 通販のPAO 予約商品                                          */
/* https://pao-onlineshop.com/view/category/reservation               */
/* ================================================================== */

/**
 * 1件目 = 在庫あり（残りあと48個）の予約BOX → 採用
 * 2件目 = SOLD OUT の予約BOX → itemPattern の tempered pattern で丸ごと除外
 * 3件目 = 在庫ありだがカードスリーブ → titleExclude で除外
 * 4件目 = 発売済みだが在庫ありのBOX → 採用（【予約商品】が付いていなくても拾える）
 */
const PAO_RESERVATION_HTML = `
      <ul class="itemList itemList--typeA itemList-pc--5 itemList-sp--2">
        <li class="itemList__unit">
  <a href="/view/item/000000146760?category_page_id=reservation" class="itemWrap">
    <span class="itemImg">
      <img src="https://makeshop-multi-images.akamaized.net/PAOonline/itemimages/000000146760_wkOcqTS.jpg" alt="【予約商品】2026年9月19日発売 ホロライブカードゲーム ブースターパック「ボリュームヴォルテックス」 1BOX">
                </span>
    <p class="itemName">【予約商品】2026年9月19日発売 ホロライブカードゲーム ブースターパック「ボリュームヴォルテックス」 1BOX</p>
  </a>
  <div class="price-stock-wrap">
          <p class="itemPrice">5,280円<small>(税込)</small></p>
      <p class="itemstock">
        <small>残りあと48個</small>
      </p>
      </div>
      <p class="itemcartbtn">
      <a href="#makeshop-common-cart-entry-url:000000146760" aria-label="【予約商品】2026年9月19日発売 ホロライブカードゲーム ブースターパック「ボリュームヴォルテックス」 1BOX をカートに入れる">カートに入れる</a>
    </p>
  </li>
        <li class="itemList__unit">
  <a href="/view/item/000000147981?category_page_id=reservation" class="itemWrap">
    <span class="itemImg">
      <img src="https://makeshop-multi-images.akamaized.net/PAOonline/itemimages/000000147981_d4Zoa6P.png" alt="【予約販売】2026年9月19日発売 ヴァイスシュヴァルツ ブースターパック「勝利の女神：NIKKE Vol.2」 1BOX">
      <span class="itemSoldout">SOLD OUT</span>          </span>
    <p class="itemName">【予約販売】2026年9月19日発売 ヴァイスシュヴァルツ ブースターパック「勝利の女神：NIKKE Vol.2」 1BOX</p>
  </a>
  <div class="price-stock-wrap">
          <p class="itemPrice">4,400円<small>(税込)</small></p>
      <p class="itemstock">
        <small>残りあと0個</small>
      </p>
      </div>
      <p class="itemcartbtn">売り切れ</p>
  </li>
        <li class="itemList__unit">
  <a href="/view/item/000000146212?category_page_id=New" class="itemWrap">
    <span class="itemImg">
      <img src="https://makeshop-multi-images.akamaized.net/PAOonline/itemimages/000000146212_f2ADEhW.jpg" alt="ONE PIECEカードゲーム オフィシャルカードスリーブ 【ボア・ハンコック】">
                </span>
    <p class="itemName">ONE PIECEカードゲーム オフィシャルカードスリーブ 【ボア・ハンコック】</p>
  </a>
  <div class="price-stock-wrap">
          <p class="itemPrice">990円<small>(税込)</small></p>
      </div>
  </li>
        <li class="itemList__unit">
  <a href="/view/item/000000145546?category_page_id=reservation" class="itemWrap">
    <span class="itemImg">
      <img src="https://makeshop-multi-images.akamaized.net/PAOonline/itemimages/000000145546_koPLmir.webp" alt="2026年8月21日発売 ホロライブカードゲーム エクストラブースター「サマー・ホログラム」 1BOX">
                </span>
    <p class="itemName">2026年8月21日発売 ホロライブカードゲーム エクストラブースター「サマー・ホログラム」 1BOX</p>
  </a>
  <div class="price-stock-wrap">
      <p class="itemstock"><small>残りあと40個</small></p>
      </div>
  </li>
      </ul>
`;

test('PAO: 予約商品カテゴリから在庫ありのカード商品だけを取り出す', async () => {
  const site = await siteConfig('pao-reservation');
  const items = parseShopList(PAO_RESERVATION_HTML, site);

  assert.equal(items.length, 2);
  assert.equal(
    items[0].title,
    '【予約商品】2026年9月19日発売 ホロライブカードゲーム ブースターパック「ボリュームヴォルテックス」 1BOX'
  );
  assert.equal(
    items[1].title,
    '2026年8月21日発売 ホロライブカードゲーム エクストラブースター「サマー・ホログラム」 1BOX'
  );
});

test('PAO: SOLD OUT の商品は itemPattern の時点で除外される（買えない応募先を出さない）', async () => {
  const site = await siteConfig('pao-reservation');
  const items = parseShopList(PAO_RESERVATION_HTML, site);
  const titles = items.map((i) => i.title).join('\n');
  assert.ok(!titles.includes('NIKKE'), 'SOLD OUT のヴァイスシュヴァルツが混ざっている');
  assert.ok(!items.some((i) => i.link.includes('000000147981')));
});

test('PAO: 相対URLが baseUrl で絶対化され、category_page_id は落ちる', async () => {
  const site = await siteConfig('pao-reservation');
  const items = parseShopList(PAO_RESERVATION_HTML, site);
  assert.equal(items[0].link, 'https://pao-onlineshop.com/view/item/000000146760');
  assert.equal(items[1].link, 'https://pao-onlineshop.com/view/item/000000145546');
  for (const i of items) assert.ok(!i.link.includes('category_page_id'));
});

test('PAO: スリーブは titleExclude で落ちる', async () => {
  const site = await siteConfig('pao-reservation');
  const items = parseShopList(PAO_RESERVATION_HTML, site);
  assert.ok(!items.some((i) => i.title.includes('スリーブ')));
});

test('PAO: 一覧に日付が無いので pubDate は空（親が現在時刻を入れる）', async () => {
  const site = await siteConfig('pao-reservation');
  for (const i of parseShopList(PAO_RESERVATION_HTML, site)) assert.equal(i.pubDate, '');
});

/* ================================================================== */
/* 検体2: CBトレコロ 抽選販売総合ページ                                */
/* https://www.torecolo.jp/shop/t/t19294/                             */
/* ================================================================== */

/**
 * ページ本文は closed Shadow DOM で描画されるが、その元データが生HTMLの <script> に
 * ベタ書きされている。url が空文字の項目は「受付終了・結果発表済み」。
 *
 * 1件目 = 受付中（url あり）
 * 2件目 = 受付終了（url:""）→ 除外されなければならない
 * 3件目 = 受付中（url あり・ワンピ）。2件目の title を 3件目の url と結び付けないことの確認も兼ねる
 */
const TORECOLO_LOTTERY_HTML = `
<main class="pane-main">
<h1 class="h1">抽選販売総合ページ</h1>
<div id="lottery-root"></div>
<script>
  const root = document.getElementById("lottery-root");
  const shadow = root.attachShadow({ mode: "closed" });

  // ▼ 本番データ
  const surveys = [

    {
      category: "ポケカ",
      title: "ストームエメラルダ（1box） 抽選販売",
      announce: "2026年9月4日",
      deadline: "2026年9月27日 23時59分",
      result: "未発表",
      url: "https://www.torecolo.jp/shop/form/form.aspx?questionnaire=poke20260904"
    },

    {
      category: "ポケカ",
      title: "『30th CELEBRATION』『プレミアムデッキセット エーフィ・ブラッキー』 いずれか1種 抽選販売",
      announce: "2026年8月19日",
      deadline: "2026年8月27日 23時59分",
      result: "発表済み 「マイページ」→「クーポンの確認」から抽選結果をご確認ください。",
      url: ""
    },

  {
      category: "ワンピ",
      title: "ワンピースカードゲーム 世界最強の戦士【OP-17】抽選販売",
      announce: "2026年8月31日",
      deadline: "2026年9月7日 23時59分",
      result: "未発表",
      url: "https://www.torecolo.jp/shop/form/form.aspx?questionnaire=OP20260831"
    },

  ];

  const container = wrapper.querySelector("#poke");
  surveys.forEach(item => {
    card.innerHTML = \`
      <h5 class="card-title">\${item.title}</h5>
      <p><span class="fw-bold">抽選開始日：</span><strong>\${item.announce}</strong></p>
      <p><span class="fw-bold text-danger">応募期限：</span><strong>\${item.deadline}</strong></p>
    \`;
  });
</script>
</main>
`;

test('トレコロ: 受付中の抽選（url あり）だけを取り出す', async () => {
  const site = await siteConfig('torecolo-lottery');
  const items = parseShopList(TORECOLO_LOTTERY_HTML, site);

  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'ストームエメラルダ（1box） 抽選販売');
  assert.equal(items[1].title, 'ワンピースカードゲーム 世界最強の戦士【OP-17】抽選販売');
});

test('トレコロ: 受付終了（url:""）の項目は1件も混ざらない', async () => {
  const site = await siteConfig('torecolo-lottery');
  const items = parseShopList(TORECOLO_LOTTERY_HTML, site);
  const titles = items.map((i) => i.title).join('\n');
  assert.ok(!titles.includes('30th CELEBRATION'), '受付終了の抽選が混ざっている');
});

test('トレコロ: 受付終了の項目のタイトルが次の項目のURLと結び付かない', async () => {
  const site = await siteConfig('torecolo-lottery');
  const items = parseShopList(TORECOLO_LOTTERY_HTML, site);
  // 「30th CELEBRATION」の title が OP20260831 の url を拾ってしまう事故が起きていないこと
  const op = items.find((i) => i.link.includes('OP20260831'));
  assert.ok(op);
  assert.equal(op.title, 'ワンピースカードゲーム 世界最強の戦士【OP-17】抽選販売');
});

test('トレコロ: destUrl になる応募フォームURLが絶対URLでそのまま取れる', async () => {
  const site = await siteConfig('torecolo-lottery');
  const items = parseShopList(TORECOLO_LOTTERY_HTML, site);
  assert.equal(
    items[0].link,
    'https://www.torecolo.jp/shop/form/form.aspx?questionnaire=poke20260904'
  );
  // questionnaire パラメータが無いとフォームが特定できないので、必ず残っていること
  for (const i of items) assert.match(i.link, /questionnaire=/);
});

test('トレコロ: pubDate はページが「抽選開始日」と書いている announce を JST で解釈する', async () => {
  const site = await siteConfig('torecolo-lottery');
  const items = parseShopList(TORECOLO_LOTTERY_HTML, site);
  // 2026年9月4日 00:00 JST = 2026-09-03T15:00:00Z
  assert.equal(items[0].pubDate, '2026-09-03T15:00:00.000Z');
  assert.equal(items[1].pubDate, '2026-08-30T15:00:00.000Z');
});

test('トレコロ: 店が公表している応募期限を deadline に取り込む', async () => {
  // 和風日付（2026年9月27日 23時59分）を読めるようにしたので、
  // 店が公表している本物の応募締切が入るようになった。
  const site = await siteConfig('torecolo-lottery');
  assert.equal(site.deadlinePattern, 'deadline:\\s*"([^"]*)"');
  const items = parseShopList(TORECOLO_LOTTERY_HTML, site);
  assert.ok(items.length > 0, '受付中の抽選が取れること');
  for (const i of items) {
    assert.match(i.deadline, /^\d{4}-\d{2}-\d{2}T/, `締切が取れていない: ${i.title}`);
  }
});

/* ================================================================== */
/* 検体3: Yahoo!ショッピング 商品検索API V3                            */
/* https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch     */
/* ================================================================== */

/** 公式ドキュメント（2026-09-06 確認）のレスポンス構造に合わせた検体 */
const YAHOO_JSON = {
  totalResultsAvailable: 312,
  totalResultsReturned: 4,
  firstResultPosition: 1,
  request: { query: '' },
  hits: [
    {
      index: 1,
      name: 'ポケモンカードゲーム MEGA 拡張パック ストームエメラルダ BOX 予約',
      url: 'https://store.shopping.yahoo.co.jp/examplestore/pk-storm-box.html',
      code: 'pk-storm-box',
      condition: 'new',
      inStock: true,
      price: 5940,
      releaseDate: '2026-09-19',
      seller: { sellerId: 'examplestore', name: 'サンプルカードストア' },
    },
    {
      index: 2,
      name: 'hololive OFFICIAL CARD GAME ブースターパック ボリュームヴォルテックス 1BOX',
      url: 'https://store.shopping.yahoo.co.jp/examplestore/holo-bp06.html',
      code: 'holo-bp06',
      condition: 'new',
      inStock: true,
      price: 5280,
      releaseDate: '2026-09-19',
      seller: { sellerId: 'examplestore', name: 'サンプルカードストア' },
    },
    {
      index: 3,
      name: 'ポケモンカード デッキシールド スリーブ メガレックウザ',
      url: 'https://store.shopping.yahoo.co.jp/examplestore/pk-sleeve.html',
      code: 'pk-sleeve',
      condition: 'new',
      inStock: true,
      price: 660,
      releaseDate: '2026-07-31',
      seller: { sellerId: 'examplestore', name: 'サンプルカードストア' },
    },
    {
      index: 4,
      name: 'ポケモンカード リザードンex SAR 中古 シングル PSA10',
      url: 'https://store.shopping.yahoo.co.jp/examplestore/pk-single.html',
      code: 'pk-single',
      condition: 'new',
      inStock: true,
      price: 32000,
      releaseDate: '',
      seller: { sellerId: 'examplestore', name: 'サンプルカードストア' },
    },
  ],
};

test('Yahoo!ショッピングAPI: hits から BOX/パックだけを取り出しサプライとシングルを落とす', async () => {
  const site = await siteConfig('yahoo-shopping-tcg-preorder');
  const items = parseShopJson(YAHOO_JSON, site);

  assert.equal(items.length, 2);
  assert.match(items[0].title, /ストームエメラルダ BOX 予約$/);
  assert.match(items[1].title, /ボリュームヴォルテックス 1BOX$/);
  const titles = items.map((i) => i.title).join('\n');
  assert.ok(!titles.includes('スリーブ'));
  assert.ok(!titles.includes('シングル'));
});

test('Yahoo!ショッピングAPI: url は絶対URLなのでそのまま destUrl になる', async () => {
  const site = await siteConfig('yahoo-shopping-tcg-preorder');
  const items = parseShopJson(YAHOO_JSON, site);
  assert.equal(items[0].link, 'https://store.shopping.yahoo.co.jp/examplestore/pk-storm-box.html');
});

test('Yahoo!ショッピングAPI: releaseDate は発売日として要約に回るだけで、締切には使わない', async () => {
  const site = await siteConfig('yahoo-shopping-tcg-preorder');
  const items = parseShopJson(YAHOO_JSON, site);
  assert.equal(items[0].releaseText, '2026-09-19');
  assert.equal(items[0].startsAt, '');
  assert.equal(items[0].deadline, '');
  assert.equal(site.startsAtKey, undefined);
  assert.equal(site.deadlineKey, undefined);
});

test('Yahoo!ショッピングAPI: APIキーが無ければURLが解決できずスキップされる', async () => {
  const site = await siteConfig('yahoo-shopping-tcg-preorder');
  assert.match(site.url, /\{env:YAHOO_APP_ID\}/);

  const missing = resolveUrlTemplate(site.url, {});
  assert.equal(missing.url, null);
  assert.deepEqual(missing.missing, ['YAHOO_APP_ID']);

  const filled = resolveUrlTemplate(site.url, { YAHOO_APP_ID: 'dj0zaiZpPXNhbXBsZQ--' });
  assert.ok(filled.url.includes('appid=dj0zaiZpPXNhbXBsZQ--'));
  assert.ok(filled.url.includes('genre_category_id=2420'));
  assert.ok(filled.url.includes('preorder=true'));
});

test('Yahoo!ショッピングAPI: キー未取得なので enabled は false のまま', async () => {
  const site = await siteConfig('yahoo-shopping-tcg-preorder');
  assert.equal(site.enabled, false);
});

/* ================================================================== */
/* 検体4: au PAY マーケット（wowma）検索API                            */
/* https://wowma.jp/catalog/api/search/items                          */
/* ================================================================== */

/** 実レスポンスからフィールドを間引いたもの（キー名・値の形は実物どおり） */
const WOWMA_JSON = {
  pageInformation: { totalCount: 841331, limitValue: 40, currentPage: 1 },
  hitItems: [
    {
      lotNo: 762797194,
      url: 'https://wowma.jp/item/762797194',
      itemName: '【予約】[TCG] (BOX) UNION ARENA(ユニオンアリーナ) ブースターパック 魔法少女まどか☆マギカ',
      ktaiPrice: 6600,
      shopName: '完全無休！即日発送！メディアワールド',
      startDate: 1748414462,
    },
    {
      lotNo: 762797159,
      url: 'https://wowma.jp/item/762797159',
      itemName: 'ラグロン ラグコート2 汚れ防止撥水剤 500ML ',
      ktaiPrice: 3410,
      shopName: 'ペイントガレージ au PAY マーケット店',
      startDate: 1763465676,
    },
  ],
};

test('auPAYマーケット: 設定は書いてあるが無効（転売主体・新着順が効かない）', async () => {
  const site = await siteConfig('aupay-market-tcg');
  assert.equal(site.enabled, false);
  // 意味の分からない startDate を日付に割り当てていないこと
  assert.equal(site.dateKey, undefined);
  assert.equal(site.startsAtKey, undefined);
  assert.equal(site.deadlineKey, undefined);
});

test('auPAYマーケット: 無効だが listKey/titleKey/pathKey は実レスポンスと合っている', async () => {
  const site = await siteConfig('aupay-market-tcg');
  const items = parseShopJson(WOWMA_JSON, site);
  assert.equal(items.length, 2);
  assert.equal(items[0].link, 'https://wowma.jp/item/762797194');
  assert.match(items[0].title, /^【予約】\[TCG\] \(BOX\) UNION ARENA/);
  // 塗料まで混ざるのが無効化の理由。そのことを検体で示しておく
  assert.match(items[1].title, /撥水剤/);
});

test('auPAYマーケット: keyword は CP932 のパーセントエンコードで書いてある', async () => {
  const site = await siteConfig('aupay-market-tcg');
  // 'トレーディングカード' の CP932 エンコード。UTF-8 で渡すと文字化けして無関係な商品が返る
  assert.ok(site.url.includes('keyword=%83g%83%8C%81%5B%83f%83B%83%93%83O%83J%81%5B%83h'));
  const cp932 = Buffer.from(
    site.url.split('keyword=')[1].split('&')[0].replace(/%([0-9A-Fa-f]{2})/g, (_, h) =>
      String.fromCharCode(parseInt(h, 16))
    ),
    'binary'
  );
  assert.equal(cp932.length, 20); // 全角10文字 × 2バイト
});

/* ================================================================== */
/* 検体5: Shopify（Cardshop Serra / トレカキングダム）                 */
/* /collections/<name>/products.json                                  */
/* ================================================================== */

const SHOPIFY_JSON = {
  products: [
    {
      id: 8000000000001,
      title: '【予約】ホビット Gift Bundle 英語版',
      handle: 'hobbit-gift-bundle',
      published_at: '2026-09-01T10:00:00+09:00',
      product_type: 'Sealed',
    },
    {
      id: 8000000000002,
      title: '《島》{FDN}',
      handle: 'island-fdn',
      published_at: '2026-08-20T10:00:00+09:00',
      product_type: 'Single',
    },
  ],
};

test('Shopify系: handle + linkTemplate で商品URLが組み立てられる（設定は検証済みだが無効）', async () => {
  for (const id of ['cardshop-serra', 'japan-toreca-shopify']) {
    const site = await siteConfig(id);
    assert.equal(site.enabled, false, `${id} は enabled:false のはず`);
    assert.equal(site.type, 'json');
    assert.equal(site.pathKey, 'handle');
    assert.ok(site.linkTemplate.includes('{path}'));

    const items = parseShopJson(SHOPIFY_JSON, site);
    assert.equal(items.length, 2);
    assert.equal(items[0].link, site.linkTemplate.replace('{path}', 'hobbit-gift-bundle'));
    assert.equal(items[0].pubDate, '2026-09-01T01:00:00.000Z');
  }
});

/* ================================================================== */
/* 検体6: 楽天ブックス 追加IPクエリ（ヴァンガード / ヴァイス / ホロライブ）*/
/* ================================================================== */

/** 実レスポンスからフィールドを間引いたもの */
const RAKUTEN_JSON = {
  header: { hit_count: 115, start: 0 },
  items: [
    {
      item_url: 'https://books.rakuten.co.jp/rb/18700001/',
      title:
        'カードファイト！！ ヴァンガード VG-DZ-SS20 スペシャルシリーズ Stride Deckset Altmile',
      stock_status_text: '予約受付中',
      release_date_text: '2026年10月17日',
      creation_time: '2026-08-06T09:00:00.000Z',
      sales_start_time: '2026-08-06T09:00:00.000Z',
      sales_end_time: '2027-08-06T09:00:00.000Z',
    },
    {
      item_url: 'https://books.rakuten.co.jp/rb/18700002/',
      title:
        'カードファイト!! ヴァンガード リリカルブースター『リリカルモナステリオ 伝説のアイドル！』【16パック入りBOX】',
      stock_status_text: 'ご注文できない商品',
      release_date_text: '2026年9月12日',
      creation_time: '2026-08-18T09:00:00.000Z',
    },
  ],
};

test('楽天ブックス追加ぶん: 「ご注文できない商品」は stockExclude で落ちる', async () => {
  for (const id of ['rakuten-books-vanguard', 'rakuten-books-weiss', 'rakuten-books-hololive']) {
    const site = await siteConfig(id);
    const items = parseShopJson(RAKUTEN_JSON, site);
    assert.equal(items.length, 1, `${id}: 買えない商品が残っている`);
    assert.equal(items[0].link, 'https://books.rakuten.co.jp/rb/18700001/');
    assert.equal(items[0].releaseText, '2026年10月17日');
    assert.equal(items[0].pubDate, '2026-08-06T09:00:00.000Z');
  }
});

test('楽天ブックス追加ぶん: sales_start_time / sales_end_time を受付期間として使っていない', async () => {
  for (const id of ['rakuten-books-vanguard', 'rakuten-books-weiss', 'rakuten-books-hololive']) {
    const site = await siteConfig(id);
    assert.equal(site.startsAtKey, undefined);
    assert.equal(site.deadlineKey, undefined);
    const items = parseShopJson(RAKUTEN_JSON, site);
    assert.equal(items[0].startsAt, '');
    assert.equal(items[0].deadline, '');
  }
});

test('楽天ブックス追加ぶん: IPキーが CONTRACT の値になっている', async () => {
  assert.deepEqual((await siteConfig('rakuten-books-vanguard')).ips, ['vanguard']);
  assert.deepEqual((await siteConfig('rakuten-books-weiss')).ips, ['weiss']);
  assert.deepEqual((await siteConfig('rakuten-books-hololive')).ips, ['hololive']);
});

/* ================================================================== */
/* 設定ファイル全体の健全性                                            */
/* ================================================================== */

const NEW_IDS = [
  'pao-reservation',
  'torecolo-lottery',
  'rakuten-books-vanguard',
  'rakuten-books-weiss',
  'rakuten-books-hololive',
  'yahoo-shopping-tcg-preorder',
  'aupay-market-tcg',
  'cardshop-serra',
  'japan-toreca-shopify',
  'bigweb-mtg',
  'cardbox-online',
  'ryuunoshippo',
  'pao-new',
  'toretoku',
  'tcgsunrise',
  'fullcomp',
  'animate-onlineshop',
  'furu1-online',
];

test('設定: 区画Nで追加したエントリが全て存在し、id が重複していない', async () => {
  const sites = await allSites();
  const ids = sites.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'id が重複している');
  for (const id of NEW_IDS) assert.ok(ids.includes(id), `${id} が無い`);
});

test('設定: 既存の8サイトは有効のまま残っている（既存を壊していない）', async () => {
  const sites = await allSites();
  const enabled = new Set(sites.filter((s) => s.enabled !== false).map((s) => s.id));
  for (const id of [
    'rakuten-books-lottery',
    'rakuten-books-tcg-new',
    'rakuten-books-dragonball',
    'rakuten-books-duelmasters',
    'c-labo-new',
    'c-labo-yoyaku',
    'mint-mall-cardgame-box',
    'rakuten-books-unionarena',
  ]) {
    assert.ok(enabled.has(id), `既存の有効サイト ${id} が無効になっている`);
  }
});

test('設定: 追加した有効サイトは 2件（PAO予約 / トレコロ抽選）＋楽天3件', async () => {
  const sites = await allSites();
  const added = sites.filter((s) => NEW_IDS.includes(s.id) && s.enabled !== false).map((s) => s.id);
  assert.deepEqual(added.sort(), [
    'pao-reservation',
    'rakuten-books-hololive',
    'rakuten-books-vanguard',
    'rakuten-books-weiss',
    'torecolo-lottery',
  ]);
});

test('設定: 無効サイトには必ず【enabled:false の理由】を書いた note がある', async () => {
  const sites = await allSites();
  for (const s of sites.filter((x) => NEW_IDS.includes(x.id) && x.enabled === false)) {
    assert.ok(s.note && s.note.includes('【enabled:false の理由】'), `${s.id} の note が不十分`);
  }
});

test('設定: 追加した全エントリの正規表現がコンパイルできる', async () => {
  const sites = await allSites();
  for (const s of sites.filter((x) => NEW_IDS.includes(x.id))) {
    for (const key of [
      'itemPattern',
      'linkPattern',
      'titlePattern',
      'datePattern',
      'titleFilter',
      'titleExclude',
      'deadlinePattern',
    ]) {
      if (!s[key]) continue;
      assert.doesNotThrow(() => new RegExp(s[key]), `${s.id}.${key} が壊れている`);
    }
  }
});

test('設定: 有効な html サイトは itemPattern / linkPattern / titlePattern が揃っている', async () => {
  const sites = await allSites();
  for (const s of sites.filter((x) => NEW_IDS.includes(x.id) && x.enabled !== false)) {
    if (s.type !== 'html') continue;
    assert.ok(s.itemPattern, `${s.id}: itemPattern が空`);
    assert.ok(s.linkPattern, `${s.id}: linkPattern が空`);
    assert.ok(s.titlePattern, `${s.id}: titlePattern が空`);
  }
});

test('設定: 追加した有効サイトの url は https で、robots.txt で禁じられた検索・カート系パスを含まない', async () => {
  const sites = await allSites();
  for (const s of sites.filter((x) => NEW_IDS.includes(x.id) && x.enabled !== false)) {
    assert.match(s.url, /^https:\/\//, `${s.id}: https ではない`);
    assert.ok(!/\/(cart|checkout|mypage|account)\b/.test(s.url), `${s.id}: 取得してはいけないパス`);
  }
});

test('設定: 受付中か確認できないサイトは applyVerified を立てていない', async () => {
  // 「一覧に載っている」だけでは受付中の証拠にならない。
  // 例外は、店が公表している応募締切を取得できるサイト（deadlinePattern あり）。
  // その場合は締切という一次情報を持っているので確認済みとして扱ってよい。
  const sites = await allSites();
  for (const s of sites.filter((x) => NEW_IDS.includes(x.id))) {
    if (s.deadlinePattern) {
      assert.equal(
        s.applyVerified,
        true,
        `${s.id}: 締切を取得できるなら applyVerified を立ててよい`
      );
      continue;
    }
    assert.notEqual(s.applyVerified, true, `${s.id}: applyVerified を true にしてはいけない`);
  }
});
