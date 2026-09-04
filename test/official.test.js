/**
 * test/official.test.js — 区画F: 公式サイト直接監視のユニットテスト
 *
 * ネットワークアクセスなしで動く。実行: node --test test/official.test.js
 * HTML断片は 2026-08-24 に実際に取得したページからの抜粋（作り物ではない）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  parseNewsList,
  parseJsonList,
  fetchOfficialItems,
  cleanTitle,
  absolutizeUrl,
  partsToIso,
  makeItemId,
  hasLotteryIntent,
  toRegExp,
} from '../src/sources/official.js';

const CONFIG_PATH = fileURLToPath(new URL('../config/official-sites.json', import.meta.url));

/** 設定ファイルから id 指定でサイト定義を取り出す */
async function siteConfig(id) {
  const cfg = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
  const site = cfg.sites.find((s) => s.id === id);
  assert.ok(site, `config/official-sites.json に ${id} が無い`);
  return site;
}

/* ================================================================== */
/* 実サイトのHTML断片                                                  */
/* ================================================================== */

/** https://www.pokemon-card.com/info/ */
const POKEMON_HTML = `
<ul class="List-box">
  <li class="List_item">
    <a class="List_item_inner" href="/info/005606.html">
      <div class="List_title">
        <img class="After_load" src="/assets/images/now-loading_220.png" data-src="/info/2025/09/images/250925_thumbnail_2.png" alt="本人認証に使用するアプリの切り替えについて"/>
      </div>
      <div class="List_body">
        <div class="Calendar_Label ">その他</div>
        本人認証に使用するアプリの切り替えについて
        <span class="Date Date-small">2026.8.21</span>
      </div>
    </a>
  </li>
  <li class="List_item">
    <a class="List_item_inner" href="/info/005608.html">
      <div class="List_title">
        <img class="After_load" src="/assets/images/now-loading_220.png" data-src="/info/2026/08/images/260821_thumbnail_005608.jpg" alt="「シティリーグ2027 シーズン1」がポケモンカードジムでスタート！"/>
      </div>
      <div class="List_body">
        <div class="Calendar_Label Calendar_Label_Event">イベント</div>
        「シティリーグ2027 シーズン1」がポケモンカードジムでスタート！
        <span class="Date Date-small">2026.8.21</span>
      </div>
    </a>
  </li>
</ul>`;

/** https://www.yugioh-card.com/japan/ の「更新情報」（日付が見出し側にある） */
const YUGIOH_TOP_HTML = `
<section class="update-list">
  <h3>更新情報</h3>
  <div class="update">
  <time>2026/8/21</time>
  <ul>
  <li class="products"><a href="products/imph/" class="">「遊戯王OCG IMMORTAL PHOENIX」商品情報を公開</a></li>
  <li class="event"><a href="event/genesys/" class="">「遊戯王OCG GENESYS イベント」「上位者デッキ情報」公開</a></li>
  </ul>
  </div>

  <div class="update">
  <time>2026/8/17</time>
  <ul>
  <li class="event"><a href="event/yugioh_day/" class="">「遊☆戯☆王の日」9月の開催情報を公開</a></li>
  </ul>
  </div>
</section>`;

/** https://www.yugioh-card.com/japan/news/ の「おしらせ」 */
const YUGIOH_NEWS_HTML = `
<ul class="news-list">
  <li class="information"><a href="/japan/event//limitregulation/?list=202607" class="news marker ">「リミットレギュレーション（禁止・制限・準制限カード）」2026年7月01日適用リスト<time>2026/6/22</time></a></li>
  <li class="information"><a href="https://www.konami.com/yugioh/ots/" class="news marker external" target="_blank">「コナミフレンドリーショップ」は、「遊戯王カードゲーム オフィシャルトーナメントストア」に名称変更しました。  <time>2026/3/19</time></a></li>
</ul>`;

/** https://dm.takaratomy.co.jp/news/ */
const DUELMASTERS_HTML = `
<ul class="newsList01 clearfix">
  <li>
    <a class="eventCategory imgOverBigWrap"  target="_blank" href="/eventextra/duekamisama/">
      <div class="img01 imgOverBig">
<img width="225" height="102" src="https://dm.takaratomy.co.jp/wp-content/uploads/duekamisama20221122.jpg" class="attachment-225x102 size-225x102 wp-post-image" alt="" loading="lazy" /></div>
      <div class="category01">
        <p> イベント・大会</p>
      </div>
      <p class="day01">2026.08.24</p>
      <p class="tit01">「デュエ神さまに挑戦」更新！</p>
    </a>
  </li>
  <li>
    <a class="productsCategory imgOverBigWrap"  target="_blank" href="/product/dm26rp3/">
      <div class="category01">
        <p> 商品情報</p>
      </div>
      <p class="day01">2026.08.24</p>
      <p class="tit01">「DM26-RP3」先行公開カードを更新！</p>
    </a>
  </li>
</ul>`;

/** https://mtg-jp.com/reading/topics/ */
const MTG_HTML = `
<section class="list-article">
  <ul>
    <li><a href="https://mtg-jp.com/reading/iwashowdeck/0039691/">
      <div>
        <p><span class="date">2026.8.24</span>
          <span class="category strategy">戦略記事</span></p>
        <p>ボロス応召：新たなスタンダードの幕開け！（スタンダード）｜岩SHOWの「デイリー・デッキ」</p>
      </div>
    </a>
      <div class="tag-list">
        <p><a href="?search&tag=151">ホビット</a></p>
      </div>
    </li>
    <li><a href="https://mtg-jp.com/reading/mm/0039680/">
      <div>
        <p><span class="date">2026.8.17</span>
          <span class="category secret">開発秘話</span></p>
        <p>プレイテスト｜Making Magic -マジック開発秘話-</p>
      </div>
    </a>
    </li>
  </ul>
</section>`;

/** https://www.gundam-gcg.com/jp/news/ */
const GUNDAM_HTML = `
<div class="newsBox">
  <div class="newsDetail is-pickup" data-tags="event">
    <a href="https://www.gundam-gcg.com/jp/events/event_st11-st14_TeamMatch.html" class="card newsDetailInner">
      <div class="cardThumb">
        <img src="/gcg/bccard/jp/news/2026/08/20/JrupyIrXYfpIpxeF/rel.webp" alt="［ST11-ST14］リリースイベント -チーム戦-">
      </div>
      <div class="cardTxt">
        <dl>
          <dt class="cardDate">2026.08.21</dt>
          <dd class="cardLead">［ST11-ST14］リリースイベント -チーム戦-</dd>
        </dl>
      </div>
      <span class="btn">詳しくはこちら</span>
    </a>
    <span class="cardCategory">EVENTS</span>
  </div>
  <div class="newsDetail is-other" data-tags="event">
    <a href="https://www.gundam-gcg.com/jp/events/NTC_EXPO_TOKYO.html" class="card newsDetailInner">
      <div class="cardTxt">
        <dl>
          <dt class="cardDate">2026.08.07</dt>
          <dd class="cardLead">ニュータイプチャレンジ in GCG EXPO TOKYO</dd>
        </dl>
      </div>
    </a>
    <span class="cardCategory">EVENTS</span>
  </div>
</div>`;

/** https://www.dbs-cardgame.com/fw/jp/ */
const DBS_HTML = `
<ul class="newsList">
  <li class="newsItem">
    <div class="cardBGCol"><div class="cardBG"><span></span><span></span></div></div>
    <a href="https://www.dbs-cardgame.com/fw/jp/news/01_502.html" class="newsLink"></a>
    <div class="newsThumb"><img class="lazy" src="/fw/renewal01/images/top/dummy.webp" alt="" width="1040" height="586"></div>
    <div class="newsDetail">
      <div class="newsDetailHead">
        <div class="newsCategory newsCatNews"><p>お知らせ</p></div>
        <time class="newsDate" datetime="2026-08-22">2026.08.22</time>
      </div>
      <div class="newsDetailBottom">
        <h3 class="newsText">【DIGITAL ver.】【予告】『STORY BOOSTER 01 [ST01]』 登場！</h3>
      </div>
    </div>
  </li>
</ul>`;

/** https://p-bandai.jp/hobby/lotterysales/ （Shift_JIS のページをデコードしたもの） */
// カードゲーム商品版（同じマークアップ構造）。titleFilter を通ることの確認用
const PBANDAI_LOTTERY_CARD_HTML = `
<div class="dtailListArticle">
<div class="article_area">
<div class="article_photo_s">
<a href="/item/item-1000256594/"><img src="https://bandai-a.akamaihd.net/bc/img/model/m/1000256594_1.jpg" alt="【抽選販売】デジモンカードゲーム リミテッドパック" width="90" height="90" /></a><br />
</div>
<div class="article_txt">
<ul class="icon">
<li><img src="https://bandai-a.akamaihd.net/bc/img/icon/ITEM_LOT_SALES.gif" alt="抽選販売" /></li>
</ul>
<p class="article_title"><a href="/item/item-1000256594/">【抽選販売】デジモンカードゲーム リミテッドパック</a></p>
<p class="price">3,300円（税込）</p>
</div>
</div>
<!-- / article_area -->
</div>`;

const PBANDAI_LOTTERY_HTML = `
<div class="dtailListArticle">
<!-- article_area -->
<div class="article_area">
<div class="article_photo_s">
<a href="/item/item-1000224338/"><img src="https://bandai-a.akamaihd.net/bc/img/model/m/1000224338_1.jpg" alt="【抽選販売】ＭＧ 1/100 RX78FRGMT GUNDAM" width="90" height="90" /></a><br />
</div>
<div class="article_txt">
<ul class="icon">
<li><img src="https://bandai-a.akamaihd.net/bc/img/icon/ITEM_LOT_SALES.gif" alt="抽選販売" /></li>
</ul>
<p class="article_title"><a href="/item/item-1000224338/">【抽選販売】ＭＧ 1/100 RX78FRGMT GUNDAM</a></p>
<p class="price">8,800円（税込）</p>
</div>
</div>
<!-- / article_area -->
</div>`;

/** https://p-bandai.jp/new_itemlist/ （Shift_JIS のページをデコードしたもの） */
const PBANDAI_NEW_HTML = `
<ul class="item_wrap">
  <li class="heightLine-group2 bl-hot">
  <a href="/item/item-1000256594/"><img src="https://bandai-a.akamaihd.net/bc/img/model/m/1000256594_1.jpg" alt="デジモンカードゲーム リミテッ..." width="120" height="120" /></a>
  <p class="itemslist_name"><a class="bl-bigger" href="/item/item-1000256594/"><span>デジモンカードゲーム リミテッ...</span>
    <span class="price">3,300円（税込）</span>
    <span class="start">開始：8/24 8時<label class="fav"><input type="checkbox" id="nfm_1000256594"><span>お気に入り</span></label></span></a></p>
  </li>
  <li class="heightLine-group2 bl-hot">
  <a href="/item/item-1000247258/"><img src="https://bandai-a.akamaihd.net/bc/img/model/m/1000247258_1.jpg" alt="SO-DO CHRONICLE 仮面ライダーア..." width="120" height="120" /></a>
  <p class="itemslist_name"><a class="bl-bigger" href="/item/item-1000247258/"><span>SO-DO CHRONICLE 仮面ライダーア...</span>
    <span class="price">8,580円（税込）</span>
    <span class="start">開始：8/24 8時</span></a></p>
  </li>
</ul>`;

/** https://www.onepiece-cardgame.com/common/templates/api/article_list.php のレスポンス（抜粋） */
const ONEPIECE_JSON = {
  statusCode: 200,
  data: {
    apiStatus: true,
    total_count: 122,
    article_list: [
      {
        site: 'jp',
        _id: '15970',
        dspdate: '2026/08/24 11:35',
        path: '01_459',
        title:
          '8月22日(土)ブースターパック世界最強の戦士【OP-17】発売を記念し、 ティーチングアプリに追加コンテンツ実装！',
      },
      {
        site: 'jp',
        _id: '15900',
        dspdate: '2026/08/17 12:00',
        path: '01_435',
        title: '「プレミアムカードコレクション」抽選販売受付のお知らせ',
      },
    ],
  },
};

/* ================================================================== */
/* parseNewsList — 実断片が正しく取れること                            */
/* ================================================================== */

test('parseNewsList: ポケモンカード公式（相対URL・タイトル・日付）', async () => {
  const site = await siteConfig('pokemon-card-official');
  const items = parseNewsList(POKEMON_HTML, site);

  assert.equal(items.length, 2);
  assert.equal(items[0].title, '本人認証に使用するアプリの切り替えについて');
  // 相対URL /info/005606.html が baseUrl で絶対化される
  assert.equal(items[0].link, 'https://www.pokemon-card.com/info/005606.html');
  // 2026.8.21 JST = 2026-08-20T15:00:00Z
  assert.equal(items[0].pubDate, '2026-08-20T15:00:00.000Z');
  assert.equal(items[1].title, '「シティリーグ2027 シーズン1」がポケモンカードジムでスタート！');
  assert.equal(items[1].link, 'https://www.pokemon-card.com/info/005608.html');
});

test('parseNewsList: サムネイルURL内の 2026/08/ を日付と誤認しない', async () => {
  const site = await siteConfig('pokemon-card-official');
  const items = parseNewsList(POKEMON_HTML, site);
  // data-src="/info/2026/08/images/..." に引きずられず <span class="Date"> を見ている
  assert.equal(items[1].pubDate, '2026-08-20T15:00:00.000Z');
});

test('parseNewsList: 遊戯王トップ 更新情報（html-grouped・日付は見出し側）', async () => {
  const site = await siteConfig('yugioh-ocg-official');
  const items = parseNewsList(YUGIOH_TOP_HTML, site);

  assert.equal(items.length, 3);
  assert.equal(items[0].title, '「遊戯王OCG IMMORTAL PHOENIX」商品情報を公開');
  assert.equal(items[0].link, 'https://www.yugioh-card.com/japan/products/imph/');
  assert.equal(items[0].pubDate, '2026-08-20T15:00:00.000Z');
  // 同じ <div class="update"> の2件目にも同じ日付が入る
  assert.equal(items[1].pubDate, items[0].pubDate);
  assert.equal(items[1].link, 'https://www.yugioh-card.com/japan/event/genesys/');
  // 別グループは別の日付
  assert.equal(items[2].pubDate, '2026-08-16T15:00:00.000Z');
});

test('parseNewsList: 遊戯王 おしらせ一覧（<time> がアンカー内）', async () => {
  const site = await siteConfig('yugioh-ocg-news');
  const items = parseNewsList(YUGIOH_NEWS_HTML, site);

  assert.equal(items.length, 2);
  assert.equal(
    items[0].title,
    '「リミットレギュレーション（禁止・制限・準制限カード）」2026年7月01日適用リスト'
  );
  assert.equal(items[0].link, 'https://www.yugioh-card.com/japan/event//limitregulation/?list=202607');
  assert.equal(items[0].pubDate, '2026-06-21T15:00:00.000Z');
  // 外部リンク（konami.com）はそのまま絶対URLとして残る
  assert.equal(items[1].link, 'https://www.konami.com/yugioh/ots/');
});

test('parseNewsList: デュエル・マスターズ公式', async () => {
  const site = await siteConfig('duelmasters-official');
  const items = parseNewsList(DUELMASTERS_HTML, site);

  assert.equal(items.length, 2);
  assert.equal(items[0].title, '「デュエ神さまに挑戦」更新！');
  assert.equal(items[0].link, 'https://dm.takaratomy.co.jp/eventextra/duekamisama/');
  assert.equal(items[0].pubDate, '2026-08-23T15:00:00.000Z');
  assert.equal(items[1].title, '「DM26-RP3」先行公開カードを更新！');
});

test('parseNewsList: MTG日本公式 読み物一覧（抽出そのものの検証）', async () => {
  // titleExclude を外した状態で、title/link/pubDate の抽出が正しいことを確認する
  const site = { ...(await siteConfig('mtg-jp-official')), titleExclude: null };
  const items = parseNewsList(MTG_HTML, site);

  assert.equal(items.length, 2);
  assert.equal(
    items[0].title,
    'ボロス応召：新たなスタンダードの幕開け！（スタンダード）｜岩SHOWの「デイリー・デッキ」'
  );
  assert.equal(items[0].link, 'https://mtg-jp.com/reading/iwashowdeck/0039691/');
  assert.equal(items[0].pubDate, '2026-08-23T15:00:00.000Z');
  // タグリンク（?search&tag=151）を記事URLとして拾っていないこと
  assert.equal(items[1].link, 'https://mtg-jp.com/reading/mm/0039680/');
});

test('parseNewsList: MTG日本公式は連載コラムを取り込まない', async () => {
  // /reading/topics/ はコラムが大半で、製品ニュースは少数混在している。
  // このフィクスチャは2件とも連載コラム（岩SHOW / Making Magic）なので0件になるのが正しい
  const site = await siteConfig('mtg-jp-official');
  const items = parseNewsList(MTG_HTML, site);
  assert.equal(items.length, 0);
});

test('parseNewsList: ガンダムカードゲーム公式（キャプチャなし itemPattern）', async () => {
  const site = await siteConfig('gundam-gcg-official');
  const items = parseNewsList(GUNDAM_HTML, site);

  assert.equal(items.length, 2);
  assert.equal(items[0].title, '［ST11-ST14］リリースイベント -チーム戦-');
  assert.equal(
    items[0].link,
    'https://www.gundam-gcg.com/jp/events/event_st11-st14_TeamMatch.html'
  );
  assert.equal(items[0].pubDate, '2026-08-20T15:00:00.000Z');
  assert.equal(items[1].title, 'ニュータイプチャレンジ in GCG EXPO TOKYO');
});

test('parseNewsList: ドラゴンボール フュージョンワールド公式（datetime属性）', async () => {
  const site = await siteConfig('dragonball-fw-official');
  const items = parseNewsList(DBS_HTML, site);

  assert.equal(items.length, 1);
  assert.equal(items[0].title, '【DIGITAL ver.】【予告】『STORY BOOSTER 01 [ST01]』 登場！');
  assert.equal(items[0].link, 'https://www.dbs-cardgame.com/fw/jp/news/01_502.html');
  assert.equal(items[0].pubDate, '2026-08-21T15:00:00.000Z');
});

test('parseNewsList: プレミアムバンダイ 抽選販売はカード商品だけ残る（日付が無いので pubDate は空文字）', async () => {
  const site = await siteConfig('p-bandai-lotterysales');
  const items = parseNewsList(PBANDAI_LOTTERY_CARD_HTML, site);

  assert.equal(items.length, 1);
  assert.equal(items[0].title, '【抽選販売】デジモンカードゲーム リミテッドパック');
  assert.equal(items[0].link, 'https://p-bandai.jp/item/item-1000256594/');
  assert.equal(items[0].pubDate, '');
});

test('parseNewsList: プレミアムバンダイ 抽選販売からガンプラ・プラモデルは除外される', () => {
  // 抽選販売カテゴリはガンプラが大半で、そのまま通すとカードゲームの情報が埋もれる。
  // このbotの対象はカードゲームなので titleFilter で落とす。
  return siteConfig('p-bandai-lotterysales').then((site) => {
    const items = parseNewsList(PBANDAI_LOTTERY_HTML, site);
    assert.equal(items.length, 0, 'ＭＧ 1/100 ガンダムは対象外');
  });
});

test('parseNewsList: プレミアムバンダイ 新着商品は titleFilter でカード系だけ残る', async () => {
  const site = await siteConfig('p-bandai-new');
  const items = parseNewsList(PBANDAI_NEW_HTML, site);

  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'デジモンカードゲーム リミテッ...');
  assert.equal(items[0].link, 'https://p-bandai.jp/item/item-1000256594/');
  assert.equal(items[0].pubDate, '');
});

test('parseJsonList: ONE PIECEカードゲーム公式 article_list API', async () => {
  const site = await siteConfig('onepiece-cardgame-official');
  const items = parseJsonList(ONEPIECE_JSON, site);

  assert.equal(items.length, 2);
  assert.equal(items[0].link, 'https://www.onepiece-cardgame.com/news/01_459.html');
  // dspdate '2026/08/24 11:35' は JST
  assert.equal(items[0].pubDate, '2026-08-24T02:35:00.000Z');
  assert.equal(items[1].title, '「プレミアムカードコレクション」抽選販売受付のお知らせ');
});

/* ================================================================== */
/* parseNewsList — 共通の振る舞い                                      */
/* ================================================================== */

const CUSTOM_SITE = {
  id: 'custom',
  baseUrl: 'https://example.jp/news/',
  type: 'html',
  itemPattern: '<li class="row">([\\s\\S]*?)</li>',
  linkPattern: 'href="([^"]+)"',
  titlePattern: '<h3>([\\s\\S]*?)</h3>',
  datePattern: '<span class="d">(\\d{4})/(\\d{1,2})/(\\d{1,2})</span>',
};

test('parseNewsList: 相対URLが baseUrl で絶対URLになる（./ ../ / 各形式）', () => {
  const html = `
    <li class="row"><a href="detail/1.html"><h3>相対</h3></a></li>
    <li class="row"><a href="../top/2.html"><h3>親</h3></a></li>
    <li class="row"><a href="/abs/3.html"><h3>ルート</h3></a></li>
    <li class="row"><a href="https://other.example.com/4.html"><h3>絶対</h3></a></li>`;
  const items = parseNewsList(html, CUSTOM_SITE);
  assert.deepEqual(
    items.map((i) => i.link),
    [
      'https://example.jp/news/detail/1.html',
      'https://example.jp/top/2.html',
      'https://example.jp/abs/3.html',
      'https://other.example.com/4.html',
    ]
  );
});

test('parseNewsList: 日付が無ければ pubDate は空文字', () => {
  const noDateSite = { ...CUSTOM_SITE, datePattern: undefined };
  const items = parseNewsList('<li class="row"><a href="/a.html"><h3>日付なし</h3></a></li>', noDateSite);
  assert.equal(items.length, 1);
  assert.equal(items[0].pubDate, '');
});

test('parseNewsList: datePattern はあるが日付が書かれていない記事も pubDate は空文字', () => {
  const items = parseNewsList('<li class="row"><a href="/a.html"><h3>日付なし</h3></a></li>', CUSTOM_SITE);
  assert.equal(items[0].pubDate, '');
});

test('parseNewsList: タイトルのHTMLタグとエンティティが除去される', () => {
  const html =
    '<li class="row"><a href="/a.html"><h3>  <span class="new">NEW</span>「A&amp;B」&#12459;&#12540;&#12489;<br>発売&nbsp;決定！  </h3></a></li>';
  const items = parseNewsList(html, CUSTOM_SITE);
  assert.equal(items[0].title, 'NEW「A&B」カード 発売 決定！');
});

test('parseNewsList: 同じ記事が複数タブに重複出力されても1件になる', () => {
  const html = `
    <li class="row"><a href="/a.html"><h3>重複記事</h3></a></li>
    <li class="row"><a href="/a.html"><h3>重複記事</h3></a></li>`;
  assert.equal(parseNewsList(html, CUSTOM_SITE).length, 1);
});

test('parseNewsList: タイトルかリンクが欠けた行は捨てる', () => {
  const html = `
    <li class="row"><a href="/a.html"><h3></h3></a></li>
    <li class="row"><h3>リンクなし</h3></li>
    <li class="row"><a href="javascript:void(0);"><h3>JSリンク</h3></a></li>
    <li class="row"><a href="/ok.html"><h3>正常</h3></a></li>`;
  const items = parseNewsList(html, CUSTOM_SITE);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, '正常');
});

test('parseNewsList: 空入力・壊れたパターンでも throw しない', () => {
  assert.deepEqual(parseNewsList('', CUSTOM_SITE), []);
  assert.deepEqual(parseNewsList(null, CUSTOM_SITE), []);
  assert.deepEqual(parseNewsList('<li class="row"><a href="/a"><h3>x</h3></a></li>', {
    ...CUSTOM_SITE,
    itemPattern: '<li class="row">([\\s\\S]*?', // 閉じ括弧が無い壊れた正規表現
  }), []);
});

test('parseNewsList: maxItemsPerSite で件数を打ち切る', () => {
  const html = Array.from(
    { length: 10 },
    (_, i) => `<li class="row"><a href="/a${i}.html"><h3>記事${i}</h3></a></li>`
  ).join('\n');
  const items = parseNewsList(html, { ...CUSTOM_SITE, maxItemsPerSite: 3 });
  assert.equal(items.length, 3);
});

/* ================================================================== */
/* 小物                                                                */
/* ================================================================== */

test('partsToIso: JSTとして解釈し、不正値は空文字', () => {
  assert.equal(partsToIso([2026, 8, 21]), '2026-08-20T15:00:00.000Z');
  assert.equal(partsToIso([2026, 8, 24, 11, 35]), '2026-08-24T02:35:00.000Z');
  assert.equal(partsToIso([2026, 13, 1]), '');
  assert.equal(partsToIso([1800, 1, 1]), '');
  assert.equal(partsToIso(['x', 1, 1]), '');
  assert.equal(partsToIso([]), '');
});

test('absolutizeUrl: 危険/無意味なスキームは空文字', () => {
  assert.equal(absolutizeUrl('mailto:a@example.com', 'https://x.jp/'), '');
  assert.equal(absolutizeUrl('#anchor', 'https://x.jp/'), '');
  assert.equal(absolutizeUrl('', 'https://x.jp/'), '');
  assert.equal(absolutizeUrl('/a', 'https://x.jp/'), 'https://x.jp/a');
});

test('cleanTitle: タグ除去 + エンティティ復号 + 空白畳み', () => {
  assert.equal(cleanTitle('<b>あ</b>&amp;<i>い</i>'), 'あ&い');
  assert.equal(cleanTitle('  改行\n  と\tタブ  '), '改行 と タブ');
  assert.equal(cleanTitle(null), '');
});

test('hasLotteryIntent: 抽選系の語を検出する', () => {
  assert.equal(hasLotteryIntent('【抽選販売】ガンダム'), true);
  assert.equal(hasLotteryIntent('予約受付開始'), true);
  assert.equal(hasLotteryIntent('当選者発表'), true);
  assert.equal(hasLotteryIntent('デッキ紹介'), false);
});

test('makeItemId: 16桁で決定的、URLが違えば別ID', () => {
  const a = makeItemId('テスト記事', 'https://x.jp/a');
  const b = makeItemId('テスト記事', 'https://x.jp/a');
  const c = makeItemId('テスト記事', 'https://x.jp/b');
  assert.equal(a.length, 16);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('toRegExp: 壊れたパターンは null', () => {
  assert.equal(toRegExp('([a-z'), null);
  assert.equal(toRegExp(''), null);
  assert.ok(toRegExp('a+') instanceof RegExp);
});

/* ================================================================== */
/* fetchOfficialItems — fetch をスタブして検証                         */
/* ================================================================== */

/** テキストを返す最小のResponseスタブ */
function textResponse(body, { status = 200, contentType = 'text/html; charset=utf-8', url = '' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    url,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  };
}

/**
 * URL -> レスポンス のマップで globalThis.fetch を差し替える。
 * 戻り値の restore() で必ず戻すこと。
 */
function stubFetch(routes) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const key = String(url);
    calls.push(key);
    const handler = routes[key];
    if (!handler) throw new Error(`未定義のURL: ${key}`);
    if (typeof handler === 'function') return handler(key);
    return handler;
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

/** テスト用の最小サイト定義 */
function testSite(id, url, extra = {}) {
  return {
    id,
    name: id,
    url,
    baseUrl: new URL(url).origin,
    ips: ['pokemon'],
    weight: 1.4,
    enabled: true,
    type: 'html',
    itemPattern: '<li class="row">([\\s\\S]*?)</li>',
    linkPattern: 'href="([^"]+)"',
    titlePattern: '<h3>([\\s\\S]*?)</h3>',
    datePattern: '<span class="d">(\\d{4})/(\\d{1,2})/(\\d{1,2})</span>',
    ...extra,
  };
}

const NOW = new Date('2026-08-24T12:00:00.000Z');

function rowHtml(title, path, date) {
  return `<li class="row"><a href="${path}"><h3>${title}</h3></a>${
    date ? `<span class="d">${date}</span>` : ''
  }</li>`;
}

test('fetchOfficialItems: RawItem の各フィールドが契約どおり', async () => {
  const stub = stubFetch({
    'https://a.example.jp/news/': textResponse(rowHtml('新弾情報が公開', '/a1.html', '2026/8/24')),
  });
  try {
    const items = await fetchOfficialItems(
      { defaults: { retry: 0 }, sites: [testSite('site-a', 'https://a.example.jp/news/')] },
      { now: NOW }
    );
    assert.equal(items.length, 1);
    const it = items[0];
    assert.equal(it.title, '新弾情報が公開');
    assert.equal(it.url, 'https://a.example.jp/a1.html');
    assert.equal(it.sourceId, 'site-a');
    assert.equal(it.sourceName, 'site-a');
    assert.equal(it.sourceWeight, 1.4);
    assert.equal(it.kind, 'official');
    assert.equal(it.tier, 'official');
    assert.equal(it.summary, '');
    assert.equal(it.feedUrl, 'https://a.example.jp/news/');
    assert.deepEqual(it.ips, ['pokemon']);
    assert.equal(it.id, makeItemId(it.title, it.url));
    assert.equal(it.destUrl, null);
    assert.equal(it.destLabel, null);
    assert.equal(it.startsAt, null);
    assert.equal(it.deadline, null);
    assert.equal(it.publishedAt, '2026-08-23T15:00:00.000Z');
  } finally {
    stub.restore();
  }
});

test('fetchOfficialItems: 1サイト失敗しても他のサイトは返る', async () => {
  const warns = [];
  const originalWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));

  const stub = stubFetch({
    'https://ng.example.jp/news/': () => {
      throw new Error('ECONNRESET');
    },
    'https://ok.example.jp/news/': textResponse(rowHtml('生き残った記事', '/ok.html', '2026/8/24')),
  });
  try {
    const items = await fetchOfficialItems(
      {
        defaults: { retry: 0 },
        sites: [
          testSite('site-ng', 'https://ng.example.jp/news/'),
          testSite('site-ok', 'https://ok.example.jp/news/'),
        ],
      },
      { now: NOW }
    );
    assert.equal(items.length, 1);
    assert.equal(items[0].sourceId, 'site-ok');
    assert.ok(warns.some((w) => w.includes('site-ng')), '失敗サイトが warn されること');
  } finally {
    stub.restore();
    console.warn = originalWarn;
  }
});

test('fetchOfficialItems: 全滅でも throw せず空配列', async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  const stub = stubFetch({
    'https://ng1.example.jp/news/': () => {
      throw new Error('boom');
    },
    'https://ng2.example.jp/news/': textResponse('error', { status: 503 }),
  });
  try {
    const items = await fetchOfficialItems(
      {
        defaults: { retry: 0 },
        sites: [
          testSite('ng1', 'https://ng1.example.jp/news/'),
          testSite('ng2', 'https://ng2.example.jp/news/'),
        ],
      },
      { now: NOW }
    );
    assert.deepEqual(items, []);
  } finally {
    stub.restore();
    console.warn = originalWarn;
  }
});

test('fetchOfficialItems: enabled:false のサイトは取得しない', async () => {
  const stub = stubFetch({
    'https://on.example.jp/news/': textResponse(rowHtml('有効サイト', '/on.html', '2026/8/24')),
  });
  try {
    const items = await fetchOfficialItems(
      {
        defaults: { retry: 0 },
        sites: [
          testSite('on', 'https://on.example.jp/news/'),
          testSite('off', 'https://off.example.jp/news/', { enabled: false }),
        ],
      },
      { now: NOW }
    );
    assert.equal(items.length, 1);
    assert.equal(items[0].sourceId, 'on');
    // 無効サイトへは1度もリクエストしていない
    assert.ok(!stub.calls.some((u) => u.includes('off.example.jp')));
  } finally {
    stub.restore();
  }
});

test('fetchOfficialItems: maxAgeHours より古い記事は除外される', async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  const html = [
    rowHtml('新しい記事', '/new.html', '2026/8/24'),
    rowHtml('古い記事', '/old.html', '2026/7/1'),
  ].join('\n');
  const stub = stubFetch({ 'https://age.example.jp/news/': textResponse(html) });
  try {
    const items = await fetchOfficialItems(
      { defaults: { retry: 0 }, sites: [testSite('age', 'https://age.example.jp/news/')] },
      { now: NOW, maxAgeHours: 168 }
    );
    assert.equal(items.length, 1);
    assert.equal(items[0].title, '新しい記事');
  } finally {
    stub.restore();
    console.warn = originalWarn;
  }
});

test('fetchOfficialItems: 日付が取れない記事は現在時刻が入る', async () => {
  const stub = stubFetch({
    'https://nodate.example.jp/news/': textResponse(rowHtml('日付なし記事', '/n.html', '')),
  });
  try {
    const items = await fetchOfficialItems(
      { defaults: { retry: 0 }, sites: [testSite('nodate', 'https://nodate.example.jp/news/')] },
      { now: NOW, maxAgeHours: 168 }
    );
    assert.equal(items.length, 1);
    assert.equal(items[0].publishedAt, NOW.toISOString());
  } finally {
    stub.restore();
  }
});

test('fetchOfficialItems: タイトルに「抽選」があれば ips に lottery が入る', async () => {
  const html = [
    rowHtml('【抽選販売】プレミアムカードコレクション', '/l.html', '2026/8/24'),
    rowHtml('デッキ紹介ページを更新', '/d.html', '2026/8/24'),
  ].join('\n');
  const stub = stubFetch({ 'https://lot.example.jp/news/': textResponse(html) });
  try {
    const items = await fetchOfficialItems(
      { defaults: { retry: 0 }, sites: [testSite('lot', 'https://lot.example.jp/news/')] },
      { now: NOW }
    );
    assert.equal(items.length, 2);
    assert.deepEqual(items[0].ips, ['pokemon', 'lottery']);
    assert.deepEqual(items[1].ips, ['pokemon']);
  } finally {
    stub.restore();
  }
});

test('fetchOfficialItems: 取得0件でも throw せず warn だけ', async () => {
  const warns = [];
  const originalWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  const stub = stubFetch({
    'https://empty.example.jp/news/': textResponse('<div>構造が変わった</div>'),
  });
  try {
    const items = await fetchOfficialItems(
      { defaults: { retry: 0 }, sites: [testSite('empty', 'https://empty.example.jp/news/')] },
      { now: NOW }
    );
    assert.deepEqual(items, []);
    assert.ok(warns.some((w) => w.includes('取得0件')));
  } finally {
    stub.restore();
    console.warn = originalWarn;
  }
});

test('fetchOfficialItems: Shift_JIS のページを正しくデコードする', async () => {
  // Shift_JIS バイト列を作る（Node標準では encode できないので手で組む）
  const sjisTitle = Buffer.from([0x83, 0x4a, 0x81, 0x5b, 0x83, 0x68]); // "カード"
  const body = Buffer.concat([
    Buffer.from('<li class="row"><a href="/s.html"><h3>', 'ascii'),
    sjisTitle,
    Buffer.from('</h3></a><span class="d">2026/8/24</span></li>', 'ascii'),
  ]);
  const stub = stubFetch({
    'https://sjis.example.jp/news/': {
      ok: true,
      status: 200,
      statusText: 'OK',
      url: 'https://sjis.example.jp/news/',
      headers: { get: () => 'text/html; charset=Shift_JIS' },
      text: async () => body.toString('latin1'),
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    },
  });
  try {
    const items = await fetchOfficialItems(
      {
        defaults: { retry: 0 },
        sites: [testSite('sjis', 'https://sjis.example.jp/news/', { charset: 'shift_jis' })],
      },
      { now: NOW }
    );
    assert.equal(items.length, 1);
    assert.equal(items[0].title, 'カード');
  } finally {
    stub.restore();
  }
});

test('fetchOfficialItems: 同一記事は複数サイトにまたがっても1件に畳まれる', async () => {
  const originalWarn = console.warn;
  console.warn = () => {};
  const html = rowHtml('同じ記事', '/same.html', '2026/8/24');
  const stub = stubFetch({
    'https://dup.example.jp/news/': textResponse(html),
    'https://dup.example.jp/news2/': textResponse(html),
  });
  try {
    const items = await fetchOfficialItems(
      {
        defaults: { retry: 0 },
        sites: [
          testSite('dup1', 'https://dup.example.jp/news/'),
          testSite('dup2', 'https://dup.example.jp/news2/'),
        ],
      },
      { now: NOW }
    );
    assert.equal(items.length, 1);
  } finally {
    stub.restore();
    console.warn = originalWarn;
  }
});

test('fetchOfficialItems: サイト定義が空なら warn して空配列', async () => {
  const originalWarn = console.warn;
  const warns = [];
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    assert.deepEqual(await fetchOfficialItems({ sites: [] }, { now: NOW }), []);
    assert.deepEqual(await fetchOfficialItems(null, { now: NOW }), []);
    assert.equal(warns.length, 2);
  } finally {
    console.warn = originalWarn;
  }
});

/* ================================================================== */
/* config/official-sites.json 自体の健全性                             */
/* ================================================================== */

test('config: 全サイトの正規表現がコンパイルでき、IDが一意', async () => {
  const cfg = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
  assert.ok(Array.isArray(cfg.sites) && cfg.sites.length > 0);

  const ids = new Set();
  // IPキーは config/sources.json を唯一の情報源とする。
  // ここに直書きすると、IPを追加するたびにこのテストが偽陽性で落ちるため。
  const sourcesPath = new URL('../config/sources.json', import.meta.url);
  const sources = JSON.parse(await readFile(sourcesPath, 'utf-8'));
  const allowedIps = new Set(Object.keys(sources.ips || {}));
  assert.ok(allowedIps.size >= 10, 'sources.json から IPキーを読めていること');

  for (const site of cfg.sites) {
    assert.ok(site.id, 'id が必要');
    assert.ok(!ids.has(site.id), `id 重複: ${site.id}`);
    ids.add(site.id);

    assert.match(site.url, /^https:\/\//, `${site.id}: url は https`);
    assert.ok(Array.isArray(site.ips) && site.ips.length > 0, `${site.id}: ips が必要`);
    for (const ip of site.ips) {
      assert.ok(allowedIps.has(ip), `${site.id}: 未定義のIPキー ${ip}`);
    }
    assert.ok(['html', 'html-grouped', 'json', 'rss'].includes(site.type), `${site.id}: 未知の type`);
    assert.ok(typeof site.note === 'string' && site.note.length > 0, `${site.id}: note が必要`);

    for (const key of ['itemPattern', 'linkPattern', 'titlePattern', 'datePattern', 'entryPattern', 'titleFilter']) {
      if (site[key] === undefined) continue;
      assert.ok(toRegExp(site[key]) instanceof RegExp, `${site.id}.${key} がコンパイルできない`);
    }
    if (site.type === 'html' || site.type === 'html-grouped') {
      assert.ok(site.itemPattern, `${site.id}: itemPattern が必要`);
    }
    if (site.type === 'html-grouped') {
      assert.ok(site.entryPattern, `${site.id}: entryPattern が必要`);
    }
    if (site.type === 'json') {
      assert.ok(site.linkTemplate && site.linkTemplate.includes('{path}'), `${site.id}: linkTemplate が必要`);
    }
  }

  // ポケモンセンターオンラインは bot ブロックのため無効であること
  const pco = cfg.sites.find((s) => s.id === 'pokemoncenter-online');
  assert.ok(pco, 'pokemoncenter-online の定義が必要');
  assert.equal(pco.enabled, false);
  assert.match(pco.note, /bot/i);
});
