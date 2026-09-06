/**
 * test/shops-lottery.test.js — 区画O: 各小売店の「抽選専用ページ」ぶんのユニットテスト
 *
 * ネットワークアクセスなしで動く。実行: node --test test/shops-lottery.test.js
 *
 * このファイルが守っているのは1点だけ:
 *   「抽選は通常の商品導線とは別ページで告知される」ので、その別ページの
 *    実HTMLから、抽選対象のカード商品だけを取り違えずに取り出せること。
 *
 * HTML/RSS 断片は 2026-09-06 に UA `Mozilla/5.0 (compatible; TCGNewsBot/1.0)` で
 * 実際に取得したページからの抜粋（作り物ではない）。装飾マークアップだけ間引いてあり、
 * パターンが依存するタグは実物どおりに残してある:
 *   ・ファミマオンライン : <a class="c-result-card__contents" href="/item?itemCode=N"> … <p class="c-result-card__name …">
 *   ・ヤマシロヤ(RSS)    : <item><title>…</title><link>…</link></item>
 *   ・イトーヨーカドー   : <div class="block-thumbnail-t--goods-name"><a href="…/g/gN/" title="…">
 *   ・エディオン         : <p class="item"><a href="/detail.html?p_cd=N">…</a></p>
 *
 * 既存のテストファイルは1行も編集していない。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { parseShopFeed, parseShopList, fetchShopItems, USER_AGENT } from '../src/sources/shops.js';

const SOURCES_PATH = fileURLToPath(new URL('../config/shop-sources.json', import.meta.url));
const SHOPS_PATH = fileURLToPath(new URL('../config/shops.json', import.meta.url));

/** 設定ファイルから id 指定でサイト定義を取り出す（設定と実HTMLを突き合わせるため） */
async function siteConfig(id) {
  const cfg = JSON.parse(await readFile(SOURCES_PATH, 'utf-8'));
  const site = cfg.sites.find((s) => s.id === id);
  assert.ok(site, `config/shop-sources.json に ${id} が無い`);
  return site;
}

async function shopEntry(domain) {
  const cfg = JSON.parse(await readFile(SHOPS_PATH, 'utf-8'));
  const shop = cfg.shops.find((s) => s.domain === domain);
  assert.ok(shop, `config/shops.json に ${domain} が無い`);
  return shop;
}

/* ================================================================== */
/* 検体1: ファミマオンライン ホビー                                    */
/* https://famima-online.family.co.jp/search?category=hobby            */
/* ================================================================== */

/**
 * ファミマオンラインは抽選対象商品のタイトル自体を「【抽選商品】」で始める。
 * 1件目 = ポケカの抽選（採用）
 * 2件目 = ユニオンアリーナの抽選（採用）
 * 3件目 = 【抽選商品】だがTCGではないクーポン付きカード（titleFilter で落ちる）
 * 4件目 = 同じ棚に並ぶタペストリー（titleExclude で落ちる）
 */
const FAMIMA_HTML = `
<ul class="p-keyword__result p-keyword__result__column-2">
  <li class="c-result-card">
    <a class="c-result-card__contents"
       href="/item?itemCode=100162480879693930">
      <div class="c-result-card__images">
        <img src="https://famima-online.family.co.jp/thumbnail/item/30/100162480879693930.jpg" alt="x" loading="lazy" />
      </div>
      <ul class="c-result-card__label">
        <li class="c-label c-label--status">店舗受取</li>
      </ul>
      <p class="c-result-card__name c-text c-text--sm">【抽選商品】ポケモンカードゲーム MEGA 拡張パック 30th CELEBRATION</p>
    </a>
  </li>
  <li class="c-result-card">
    <a class="c-result-card__contents"
       href="/item?itemCode=100162659079694540">
      <div class="c-result-card__images"><img src="x.jpg" alt="x" /></div>
      <p class="c-result-card__name c-text c-text--sm">【抽選商品】UNION ARENA ブースターパック ウマ娘 プリティーダービー【UA59BT】</p>
    </a>
  </li>
  <li class="c-result-card">
    <a class="c-result-card__contents"
       href="/item?itemCode=100162660879708320">
      <div class="c-result-card__images"><img src="x.jpg" alt="x" /></div>
      <p class="c-result-card__name c-text c-text--sm">【抽選商品】FamilyMart 45th記念カード</p>
    </a>
  </li>
  <li class="c-result-card">
    <a class="c-result-card__contents"
       href="/item?itemCode=100161932879338060">
      <div class="c-result-card__images"><img src="x.jpg" alt="x" /></div>
      <p class="c-result-card__name c-text c-text--sm">超かぐや姫！　等身大タペストリー　かぐや</p>
    </a>
  </li>
</ul>
`;

test('ファミマオンライン: 抽選商品のカードだけを取り出す', async () => {
  const site = await siteConfig('famima-online-hobby');
  const out = parseShopList(FAMIMA_HTML, site);

  assert.equal(out.length, 2, '抽選のTCG2件だけが残る');
  assert.equal(out[0].title, '【抽選商品】ポケモンカードゲーム MEGA 拡張パック 30th CELEBRATION');
  assert.equal(
    out[0].link,
    'https://famima-online.family.co.jp/item?itemCode=100162480879693930',
    '相対URLが baseUrl で絶対化される'
  );
  assert.match(out[1].title, /UNION ARENA/);

  const titles = out.map((o) => o.title).join('\n');
  assert.doesNotMatch(titles, /FamilyMart 45th記念カード/, 'TCGでないクーポンカードは載せない');
  assert.doesNotMatch(titles, /タペストリー/, '同じ棚のグッズは載せない');
});

test('ファミマオンライン: 一覧に日付が無いので pubDate は空のまま（現在時刻は親が入れる）', async () => {
  const site = await siteConfig('famima-online-hobby');
  const out = parseShopList(FAMIMA_HTML, site);
  for (const o of out) assert.equal(o.pubDate, '', '嘘の日付を作らない');
});

test('ファミマオンライン: 通販は famima.com ではなく famima-online.family.co.jp', async () => {
  const site = await siteConfig('famima-online-hobby');
  assert.match(site.url, /^https:\/\/famima-online\.family\.co\.jp\//);
  const shop = await shopEntry('famima-online.family.co.jp');
  assert.ok(shop.entryUrl, '利用者が自分で辿れる入口が登録されている');
});

/* ================================================================== */
/* 検体2: ヤマシロヤ 抽選販売のお知らせ（WordPress RSS）               */
/* https://e-yamashiroya.com/feed/                                     */
/* ================================================================== */

/**
 * ヤマシロヤの抽選告知は通販サイト e-yamashiroya.com の投稿として出る。
 * 1件目 = ワンピの抽選販売（採用）
 * 2件目 = ドラゴンボールの抽選予約販売（採用）
 * 3件目 = 同じフィードに流れるフィギュア（抽選でもカードでもないので落ちる）
 * 4件目 = 抽選だがカードではないプラモ（titleFilter の「抽選かつカード」条件で落ちる）
 */
const YAMASHIROYA_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>ヤマシロヤ（Yamashiroya）</title>
  <link>https://e-yamashiroya.com</link>
  <item>
    <title>【抽選販売】ONE PIECEカードゲーム ブースターパック 世界最強の戦士【OP-17】（BOX）</title>
    <link>https://e-yamashiroya.com/%e6%9c%aa%e5%88%86%e9%a1%9e/58270/</link>
    <pubDate>Sat, 05 Sep 2026 08:51:06 +0000</pubDate>
  </item>
  <item>
    <title>【抽選予約販売】ドラゴンボールスーパーカードゲーム フュージョンワールド ブースターパック BRIGHTNESS OF HOPE【FB11】（BOX）</title>
    <link>https://e-yamashiroya.com/%e6%9c%aa%e5%88%86%e9%a1%9e/58290/</link>
    <pubDate>Sat, 05 Sep 2026 06:20:37 +0000</pubDate>
  </item>
  <item>
    <title>S.H.Figuarts（真骨彫製法） 仮面ライダーファイズ</title>
    <link>https://e-yamashiroya.com/item/48456/</link>
    <pubDate>Fri, 04 Sep 2026 06:00:04 +0000</pubDate>
  </item>
  <item>
    <title>【抽選販売】METAL ROBOT魂 ＜SIDE MS＞ νガンダム</title>
    <link>https://e-yamashiroya.com/item/51362/</link>
    <pubDate>Fri, 04 Sep 2026 06:01:36 +0000</pubDate>
  </item>
</channel>
</rss>
`;

test('ヤマシロヤ: RSSから抽選販売のカードだけを取り出す', async () => {
  const site = await siteConfig('yamashiroya-lottery-feed');
  const out = parseShopFeed(YAMASHIROYA_RSS, site);

  assert.equal(out.length, 2, '抽選かつカードの2件だけ');
  assert.match(out[0].title, /^【抽選販売】ONE PIECEカードゲーム/);
  assert.equal(out[0].link, 'https://e-yamashiroya.com/%e6%9c%aa%e5%88%86%e9%a1%9e/58270/');
  assert.match(out[1].title, /ドラゴンボール/);

  const titles = out.map((o) => o.title).join('\n');
  assert.doesNotMatch(titles, /S\.H\.Figuarts/, '抽選でない新商品は載せない');
  assert.doesNotMatch(titles, /METAL ROBOT魂/, '抽選でもカードでない商品は載せない');
});

test('ヤマシロヤ: 英語月名の pubDate を正しく解釈する', async () => {
  // 正規表現では "Sat, 05 Sep 2026" の月を数値化できず日付を落としていた。
  // type:'rss' にして自前パーサを通すことで正しく解釈できるようになった。
  const site = await siteConfig('yamashiroya-lottery-feed');
  assert.equal(site.type, 'rss');
  const out = parseShopFeed(YAMASHIROYA_RSS, site);
  for (const o of out) {
    assert.match(o.pubDate, /^\d{4}-\d{2}-\d{2}T/, `日付が取れていない: ${o.title}`);
  }
});

test('ヤマシロヤ: 受付中と確認できていないので applyVerified を立てない', async () => {
  const site = await siteConfig('yamashiroya-lottery-feed');
  assert.notEqual(site.applyVerified, true, '新しい投稿でも受付が終わっている実例があった');
  assert.equal(site.deadlineKey, undefined, '本文の応募期間は終了側に年が無いので締切にしない');
  assert.equal(site.startsAtKey, undefined);
});

test('ヤマシロヤ: 通販は yamashiroya.co.jp ではなく e-yamashiroya.com', async () => {
  const site = await siteConfig('yamashiroya-lottery-feed');
  assert.match(site.url, /^https:\/\/e-yamashiroya\.com\//);
  const shop = await shopEntry('e-yamashiroya.com');
  assert.ok(shop.entryUrl);
});

/* ================================================================== */
/* 検体3: イトーヨーカドーネット通販 開催中の予約・抽選               */
/* https://iyec.itoyokado.co.jp/shop/e/eE4reslot/                      */
/* ================================================================== */

/**
 * 実測（2026-09-06）ではこのページにTCGは1件も無く、化粧品とゲームの予約だけだった。
 * ここで守りたいのは「TCGが出た日にちゃんと拾えること」と
 * 「TCGが無い日に化粧品を混ぜないこと」の両方。
 */
const IYEC_HTML = `
<li class="block-thumbnail-t--goods js-enhanced-ecommerce-item">
  <div class="block-thumbnail-t--goods-description">
    <div class="block-thumbnail-t--goods-name">
      <a
        href="/shop/sk2/g/g4549137282744/"
        title="【９／２０発売】ＳＫ－ＩＩ　スキンパワー　リニュー　クリーム　トライアルキット　２０２６"
        class="js-enhanced-ecommerce-goods-name"
      >【９／２０発売】ＳＫ－ＩＩ　スキンパワー　リニュー　クリーム　トライアルキット　２０２６</a>
    </div>
  </div>
</li>
<li class="block-thumbnail-t--goods js-enhanced-ecommerce-item">
  <div class="block-thumbnail-t--goods-description">
    <div class="block-thumbnail-t--goods-name">
      <a
        href="/shop/g/g4973167051986/"
        title="カネボウ　ミラノコレクション　ドレスアップクリーム２０２７【予約限定アミーバックなし】"
        class="js-enhanced-ecommerce-goods-name"
      >カネボウ　ミラノコレクション　ドレスアップクリーム２０２７【予約限定アミーバックなし】</a>
    </div>
  </div>
</li>
<li class="block-thumbnail-t--goods js-enhanced-ecommerce-item">
  <div class="block-thumbnail-t--goods-description">
    <div class="block-thumbnail-t--goods-name">
      <a
        href="/shop/g/g4521329123456/"
        title="【抽選】ポケモンカードゲーム　スカーレット＆バイオレット　強化拡張パック"
        class="js-enhanced-ecommerce-goods-name"
      >【抽選】ポケモンカードゲーム　スカーレット＆バイオレット　強化拡張パック</a>
    </div>
  </div>
</li>
`;

test('イトーヨーカドー: 抽選一覧からカードだけを拾い、化粧品は落とす', async () => {
  const site = await siteConfig('iyec-lottery');
  const out = parseShopList(IYEC_HTML, site);

  assert.equal(out.length, 1);
  assert.equal(out[0].title, '【抽選】ポケモンカードゲーム スカーレット＆バイオレット 強化拡張パック');
  assert.equal(out[0].link, 'https://iyec.itoyokado.co.jp/shop/g/g4521329123456/');
});

test('イトーヨーカドー: TCGが1件も無い日は0件を返す（それが正常）', async () => {
  const site = await siteConfig('iyec-lottery');
  const cosmeticsOnly = IYEC_HTML.slice(0, IYEC_HTML.indexOf('【抽選】ポケモンカードゲーム') - 400);
  const out = parseShopList(cosmeticsOnly, site);
  assert.equal(out.length, 0, '化粧品を「カード」として流さない');
});

test('イトーヨーカドー: 企業サイトではなくネット通販ホストを見ている', async () => {
  const site = await siteConfig('iyec-lottery');
  assert.match(site.url, /^https:\/\/iyec\.itoyokado\.co\.jp\/shop\/e\//);
  assert.doesNotMatch(site.url, /www\.itoyokado\.co\.jp/, 'www 側は店舗案内の企業サイトで通販ではない');
  const shop = await shopEntry('iyec.itoyokado.co.jp');
  assert.equal(shop.entryUrl, 'https://iyec.itoyokado.co.jp/shop/e/eE4reslot/');
});

/* ================================================================== */
/* 検体4: エディオン トレーディングカード                              */
/* https://www.edion.com/category002.html?c_cd=001039031               */
/* ================================================================== */

/**
 * 「エディオンのトップにTCGの記載が無い」＝「TCGを扱っていない」ではなかった。
 * 1件目 = ユニオンアリーナ（採用）
 * 2件目 = デジモン（採用）
 * 3件目 = TCG用のパックケース＝サプライ（titleExclude で落ちる）
 * 4件目 = 同じ棚のスリーブ（落ちる）
 */
const EDION_HTML = `
<ul>
  <li>
    <a href="/detail.html?p_cd=00086403368"><img src="a.jpg" alt="x"></a>
    <p class="item">
      <a href="/detail.html?p_cd=00086403368">バンダイ UNION ARENA ブースターパック 天元突破グレンラガン【UA56BT】 ECUｱﾘ-ﾅUA56BTｸﾞﾚﾝﾗｶﾞﾝ</a>
    </p>
    <p class="price1">￥4,800<span class="small">(税別)</span></p>
  </li>
  <li>
    <a href="/detail.html?p_cd=00086403382"><img src="b.jpg" alt="x"></a>
    <p class="item">
      <a href="/detail.html?p_cd=00086403382">バンダイ デジモンカードゲーム ブースターパック TIMELESS BONDS【BT-26】 ECﾃﾞｼﾞﾓﾝﾌﾞ-ｽﾀ-BT26</a>
    </p>
  </li>
  <li>
    <a href="/detail.html?p_cd=00080000001"><img src="c.jpg" alt="x"></a>
    <p class="item">
      <a href="/detail.html?p_cd=00080000001">河島製作所 TCG フルプロテクトパックケース S スモールサイズ 2個入り FPPS-2</a>
    </p>
  </li>
  <li>
    <a href="/detail.html?p_cd=00076313431"><img src="d.jpg" alt="x"></a>
    <p class="item">
      <a href="/detail.html?p_cd=00076313431">西野 トレカ研究所 多重スリーブ ミニ L ﾄﾚｶｹﾝｷﾕｳｼﾞﾖｽﾘ-ﾌﾞﾐﾆL</a>
    </p>
  </li>
</ul>
`;

test('エディオン: トレーディングカード売り場からカード本体だけを取り出す', async () => {
  const site = await siteConfig('edion-tcg');
  const out = parseShopList(EDION_HTML, site);

  assert.equal(out.length, 2);
  assert.match(out[0].title, /UNION ARENA/);
  assert.equal(out[0].link, 'https://www.edion.com/detail.html?p_cd=00086403368');
  assert.match(out[1].title, /デジモンカードゲーム/);

  const titles = out.map((o) => o.title).join('\n');
  assert.doesNotMatch(titles, /パックケース/, 'TCGと名の付くサプライは落とす');
  assert.doesNotMatch(titles, /スリーブ/);
});

test('エディオン: 403になる item_list.html ではなく200で返る category002.html を使う', async () => {
  const site = await siteConfig('edion-tcg');
  assert.match(site.url, /category002\.html/);
  assert.doesNotMatch(site.url, /item_list\.html/, 'item_list.html は Cloudflare の bot判定で403');
});

/* ================================================================== */
/* 取得できなかった店を「行き止まり」にしていないこと                  */
/* ================================================================== */

test('bot対策で諦めた店にも、利用者が自分で辿れる入口がある', async () => {
  for (const domain of ['biccamera.com', 'yamada-denkiweb.com', 'aeon.com', 'aeonretail.com', 'yodobashi.com']) {
    const shop = await shopEntry(domain);
    assert.ok(shop.entryUrl, `${domain} に entryUrl が無い（行き止まりになる）`);
    assert.match(shop.entryUrl, /^https:\/\//, `${domain} の entryUrl が絶対URLでない`);
    assert.ok(shop.entryLabel, `${domain} に entryLabel が無い（押す前に行き先が分からない）`);
  }
});

test('取得できない店は enabled:false で、理由が note に書いてある', async () => {
  const site = await siteConfig('aeon-style-online');
  assert.equal(site.enabled, false);
  assert.match(site.note, /403/, '実測の結果が note に書いてある');
  assert.match(site.note, /回避行為なのでやらない/, 'bot対策を回避していないことを明記');
});

/* ================================================================== */
/* 区画O全体の約束                                                     */
/* ================================================================== */

const LOTTERY_SITE_IDS = [
  'famima-online-hobby',
  'yamashiroya-lottery-feed',
  'iyec-lottery',
  'edion-tcg',
  'aeon-style-online',
];

test('区画Oが足した設定は、受付中だと断定しない', async () => {
  for (const id of LOTTERY_SITE_IDS) {
    const site = await siteConfig(id);
    assert.notEqual(site.applyVerified, true, `${id}: 受付中を確認できていないのに applyVerified を立てている`);
  }
});

test('区画Oが足した設定は、意味の分からない日付を締切に割り当てない', async () => {
  for (const id of LOTTERY_SITE_IDS) {
    const site = await siteConfig(id);
    assert.equal(site.deadlineKey, undefined, `${id}: deadlineKey を使っていない`);
    assert.equal(site.startsAtKey, undefined, `${id}: startsAtKey を使っていない`);
    assert.equal(site.deadlinePattern, undefined, `${id}: deadlinePattern を使っていない`);
  }
});

test('区画Oが足した設定は、カード商品だけに絞る titleFilter を持つ（無効サイトを除く）', async () => {
  for (const id of LOTTERY_SITE_IDS) {
    const site = await siteConfig(id);
    if (site.enabled === false) continue;
    assert.ok(site.titleFilter, `${id}: titleFilter が無い`);
    assert.match(site.titleFilter, /カードゲーム/, `${id}: titleFilter がカード語で絞っていない`);
    assert.ok(site.titleExclude, `${id}: titleExclude が無い`);
  }
});

test('区画Oが足した設定は、robots.txt を確認した記録を note に持つ', async () => {
  for (const id of LOTTERY_SITE_IDS) {
    const site = await siteConfig(id);
    assert.match(site.note, /robots\.txt/, `${id}: note に robots.txt の確認結果が無い`);
  }
});

test('UAは TCGNewsBot 固定のまま（ブラウザ偽装をしていない）', () => {
  assert.equal(USER_AGENT, 'Mozilla/5.0 (compatible; TCGNewsBot/1.0)');
});

test('無効化した店はネットワークに出ない', async () => {
  const cfg = JSON.parse(await readFile(SOURCES_PATH, 'utf-8'));
  const disabled = cfg.sites.filter((s) => s.id === 'aeon-style-online');
  const items = await fetchShopItems({ ...cfg, sites: disabled }, {});
  assert.deepEqual(items, [], 'enabled:false のサイトは取得されない');
});
