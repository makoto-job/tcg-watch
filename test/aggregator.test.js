/**
 * test/aggregator.test.js — 区画P: 抽選まとめサイトからの締切データ取得
 *
 * ネットワークアクセスなしで動く。実行: node --test test/aggregator.test.js
 *
 * 検体は 2026-09-06 に実際に取得したページからの抜粋（作り物ではない）。
 *   https://pokeca-navi.jp/lotteries/   … Next.js の RSC ストリーム（self.__next_f.push）の中身
 *   https://nyuka-now.com/archives/2459 … WordPress の見出し＋テーブル
 *
 * このファイルが守っているのは1つ。
 * **まとめサイト由来の締切を、間違った内容で「間に合う」と表示しないこと。**
 *   ・年が確定している締切だけを deadline に入れる
 *   ・受付終了（status:"closed" / 受付終了セクション）のものを取り込まない
 *   ・URLが途中で切れるくらいなら、その項目ごと落とす
 *   ・どこの店の抽選かを取り違えさせない（店名が title に入っている）
 *   ・二次情報なので applyVerified を立てない
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { parseShopList, fetchShopItems, USER_AGENT } from '../src/sources/shops.js';

const CONFIG_PATH = fileURLToPath(new URL('../config/shop-sources.json', import.meta.url));

async function siteConfig(id) {
  const cfg = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
  const site = cfg.sites.find((s) => s.id === id);
  assert.ok(site, `config/shop-sources.json に ${id} が無い`);
  return site;
}

/* ================================================================== */
/* 実サイトの検体                                                      */
/* ================================================================== */

/**
 * ポケカ抽選図鑑 /lotteries/ の生HTMLからの抜粋（先頭3件）。
 * ページ本体は Next.js App Router 製で、データは
 *   <script>self.__next_f.push([1,"…"])</script>
 * の中に RSC ストリームとして入っている。JS文字列の中のJSONなので " が \\" に
 * エスケープされている。以下はその生のバイト列そのまま。
 */
const POKECA_HTML = "{\\\"id\\\":\\\"lot_30beaf0df346d8d6\\\",\\\"tcgTitle\\\":\\\"ポケモンカード\\\",\\\"productName\\\":\\\"30th CELEBRATION BOX\\\",\\\"storeName\\\":\\\"Bee本舗\\\",\\\"storeChain\\\":\\\"Bee本舗\\\",\\\"deadline\\\":\\\"2026-09-06T20:00:00+09:00\\\",\\\"status\\\":\\\"open\\\",\\\"region\\\":\\\"all\\\",\\\"prefecture\\\":\\\"all\\\",\\\"deliveryType\\\":\\\"store\\\",\\\"applicationMethod\\\":\\\"web\\\",\\\"applicationUrl\\\":\\\"https://docs.google.com/forms/d/e/1FAIpQLScMpdHXqGxtGYt3tWmQQwtnxuaU0Hz9eVJfiio_gIJqT3eJZg/viewform\\\",\\\"description\\\":\\\"Bee本舗でのポケモンカード抽選販売。応募期間は9月4日～9月6日20時まで。当選発表は9月16日、購入期限は9月19日までです。詳細は抽選予約ページをご確認ください。\\\",\\\"requirements\\\":[],\\\"thumbnailUrl\\\":\\\"/images/products/30th CELEBRATION BOX.webp\\\",\\\"imageAlt\\\":\\\"30th CELEBRATION BOX 商品画像\\\"},{\\\"id\\\":\\\"lot_425fe1112d45504f\\\",\\\"tcgTitle\\\":\\\"ポケモンカード\\\",\\\"productName\\\":\\\"プレミアムデッキセット エーフィ・ブラッキー\\\",\\\"storeName\\\":\\\"Bee本舗\\\",\\\"storeChain\\\":\\\"Bee本舗\\\",\\\"deadline\\\":\\\"2026-09-06T20:00:00+09:00\\\",\\\"status\\\":\\\"open\\\",\\\"region\\\":\\\"all\\\",\\\"prefecture\\\":\\\"all\\\",\\\"deliveryType\\\":\\\"store\\\",\\\"applicationMethod\\\":\\\"web\\\",\\\"applicationUrl\\\":\\\"https://docs.google.com/forms/d/e/1FAIpQLSeor-I2Hj2JfRjsrW9i4Ev28sxsv271waxZCsV7nh7dpczlig/viewform\\\",\\\"description\\\":\\\"Bee本舗にてポケカ新商品「プレミアムデッキセット エーフィ・ブラッキー」の抽選販売を実施。応募期間は9月4日～9月6日20時まで。当選発表は9月16日、購入期限は9月19日までです。\\\",\\\"requirements\\\":[]},{\\\"id\\\":\\\"lot_d3ecf35e260678b9\\\",\\\"tcgTitle\\\":\\\"ポケモンカード\\\",\\\"productName\\\":\\\"30th CELEBRATION BOX\\\",\\\"storeName\\\":\\\"文教堂書店浦安西友店\\\",\\\"storeChain\\\":\\\"文教堂書店\\\",\\\"deadline\\\":\\\"2026-09-06T20:30:00+09:00\\\",\\\"status\\\":\\\"open\\\",\\\"region\\\":\\\"kanto\\\",\\\"prefecture\\\":\\\"chiba\\\",\\\"deliveryType\\\":\\\"store\\\",\\\"applicationMethod\\\":\\\"web\\\",\\\"applicationUrl\\\":\\\"https://livepocket.jp/t/kv7rf\\\",\\\"description\\\":\\\"店頭レジ配布のシリアルコードが必要。応募期間は9月6日(日)20:30まで。購入は店頭のみとなります。\\\",\\\"requirements\\\":[],\\\"thumbnailUrl\\\":\\\"/images/products/30th CELEBRATION BOX.webp\\\",\\\"imageAlt\\\":\\\"30th CELEBRATION BOX 商品画像\\\"},";

/**
 * 同ページの別の1件。applicationUrl の & が \\u0026 にエスケープされている実例。
 * （242件中3件がこの形。URLを途中で切って出すのは危険なので、項目ごと落とす方を選んでいる）
 */
const POKECA_ESCAPED_AMP_HTML = "{\\\"id\\\":\\\"lot_60693cf1c37c4db3\\\",\\\"tcgTitle\\\":\\\"ポケモンカード\\\",\\\"productName\\\":\\\"スターバース\\\",\\\"storeName\\\":\\\"ガンギ(GANGI)\\\",\\\"storeChain\\\":\\\"ガンギ(GANGI)\\\",\\\"deadline\\\":\\\"2026-09-09T23:59:00+09:00\\\",\\\"status\\\":\\\"open\\\",\\\"region\\\":\\\"all\\\",\\\"prefecture\\\":\\\"all\\\",\\\"deliveryType\\\":\\\"online\\\",\\\"applicationMethod\\\":\\\"web\\\",\\\"applicationUrl\\\":\\\"https://www.gangi.co.jp/blog/drawsale-691?utm_source=x\\u0026utm_medium=social\\u0026utm_campaign=x_drawsale-post\\\",\\\"description\\\":\\\"会員限定の抽選販売です。応募期間は9月9日(水)23:59まで。商品は郵送での受け取りとなります。\\\",\\\"requirements\\\":[]},";

/**
 * 入荷Now の記事からの抜粋。受付中セクションの2店と、
 * 応募受付終了セクションの1店を、実物と同じ順序でつないだもの。
 * 受付中と終了でマークアップが完全に同一であることが分かる。
 */
const NYUKA_HTML = "<h2>抽選・予約応募受付中のストア</h2><h3>ノジマオンライン</h3><figure class=\"wp-block-table is-style-regular\">\r\n        <table style=\"margin-top:10px;\">\r\n        <tbody> <tr>\r\n        <th style=\"width: 30%;\">対象商品</th>\r\n        <td style=\"width: 70%;\">ポケモンカード、ワンピースカード、ドラゴンボールフュージョンワールド新弾各種</td>\r\n        </tr><tr>\r\n            <th style=\"width: 30%;\">対象商品詳細</th>\r\n            <td style=\"width: 70%; word-break: break-all;\">\r\n            <p>シークレット販売会対象商品（複数選択可能、複数IDでのエントリー無効）<br />\r\n<br />\r\n・ポケモンカードゲーム関連<br />\r\n・ワンピースカードゲーム関連<br />\r\n・ドラゴンボール超カードゲーム フュージョンワールド関連<br />\r\n・その他、注目商品（ゲーム系に限らず）</p>\r\n            </td>\r\n            </tr><tr>\r\n            <th style=\"width: 30%;\">販売形式</th>\r\n            <td style=\"width: 70%;\">招待制販売</td>\r\n            </tr><tr>\r\n            <th style=\"width: 30%;\">開始日</th>\r\n            <td style=\"width: 70%;\">9月6日(日)12:00</td>\r\n            </tr><tr>\r\n        <th style=\"width: 30%;\">応募条件</th>\r\n        <td style=\"width: 70%; word-break: break-all;\">\r\n        <p>・エントリーにはノジマオンラインの会員IDが必要</p>\r\n        </td>\r\n        </tr><tr>\r\n                <th style=\"width: 30%;\">詳細ページ</th>\r\n                <td style=\"width: 70%;\"><a href=\"https://contents.online.nojima.co.jp/secret202609/\" target=\"_blank\" rel=\"noopener noreferrer\">ノジマオンラインの詳細ページ</a></td>\r\n                </tr></tbody>\r\n        </table>\r\n        </figure><h3>ポケモンカードゲーム公式</h3><figure class=\"wp-block-table is-style-regular\">\r\n        <table style=\"margin-top:10px;\">\r\n        <tbody> <tr>\r\n        <th style=\"width: 30%;\">対象商品</th>\r\n        <td style=\"width: 70%;\">ポケモンカードゲーム30周年記念イベント 『30th CELEBRATION EVENT』</td>\r\n        </tr><tr>\r\n            <th style=\"width: 30%;\">抽選形式</th>\r\n            <td style=\"width: 70%;\">WEB抽選受付</td>\r\n            </tr><tr>\r\n            <th style=\"width: 30%;\">開始日</th>\r\n            <td style=\"width: 70%;\">9月4日(金)14:00</td>\r\n            </tr><tr>\r\n                                <th style=\"width: 30%;\">終了日</th>\r\n                                <td style=\"width: 70%;\">9月18日(金)12:00</td>\r\n                                </tr><tr>\r\n        <th style=\"width: 30%;\">当選発表</th>\r\n        <td style=\"width: 70%;\">10/2(金)17:00予定</td>\r\n        </tr><tr>\r\n                <th style=\"width: 30%;\">応募ページ</th>\r\n                <td style=\"width: 70%;\"><a href=\"https://www.30th.pokemon-card.com/event/30thevent/entry\" target=\"_blank\" rel=\"noopener noreferrer\">ポケモンカードゲーム公式の応募ページ</a></td>\r\n                </tr></tbody>\r\n        </table>\r\n        </figure><h2>応募受付終了（過去の抽選・予約一覧、直近15件）</h2><h3>イオンスタイルオンライン</h3><p style=\"text-align:center;\"><img decoding=\"async\" style=\"box-shadow: 0 0 0 1px #ddd; margin:10px;\" src=\"https://nyuka-now.com/wp-content/uploads/2026/06/1780883517-67eff8f7a0585556d4f2e7a07158ef81.jpg\" width=\"150px\" height=\"150px\" alt=\"ポケモンカード 30th CELEBRATION カードセット各種\"></p><figure class=\"wp-block-table is-style-regular\">\r\n        <table style=\"margin-top:10px;\">\r\n        <tbody> <tr>\r\n        <th style=\"width: 30%;\">対象商品</th>\r\n        <td style=\"width: 70%;\">ポケモンカード 30th CELEBRATION カードセット各種</td>\r\n        </tr><tr>\r\n            <th style=\"width: 30%;\">抽選形式</th>\r\n            <td style=\"width: 70%;\">WEB抽選受付（当選者にはオンライン販売）</td>\r\n            </tr><tr>\r\n            <th style=\"width: 30%;\">開始日</th>\r\n            <td style=\"width: 70%;\">9月3日(木)11:00</td>\r\n            </tr><tr>\r\n                                <th style=\"width: 30%;\">終了日</th>\r\n                                <td style=\"width: 70%;\">9月4日(金)23:59</td>\r\n                                </tr><tr>\r\n                <th style=\"width: 30%;\">応募ページ</th>\r\n                <td style=\"width: 70%;\"><a href=\"https://aeonretail.com/Page/k-lottery_pokemon_set.aspx\" target=\"_blank\" rel=\"noopener noreferrer\">イオンスタイルオンラインの応募ページ</a></td>\r\n                </tr></tbody>\r\n        </table>\r\n        </figure>";

/* ================================================================== */
/* ポケカ抽選図鑑（有効）                                              */
/* ================================================================== */

test('設定: pokeca-navi-lotteries は有効な html サイトとして登録されている', async () => {
  const site = await siteConfig('pokeca-navi-lotteries');
  assert.equal(site.enabled, true);
  assert.equal(site.type, 'html');
  assert.equal(site.url, 'https://pokeca-navi.jp/lotteries/');
  assert.equal(site.baseUrl, 'https://pokeca-navi.jp');
  assert.ok(site.itemPattern && site.linkPattern && site.titlePattern);
  assert.ok(site.deadlinePattern, '締切を取るために追加したサイトなので deadlinePattern は必須');
  assert.ok(Array.isArray(site.ips) && site.ips.includes('pokemon'));
});

test('設定: まとめサイトの項目は applyVerified を立てない（二次情報だから）', async () => {
  const site = await siteConfig('pokeca-navi-lotteries');
  assert.equal(site.applyVerified, false);
});

test('設定: destLabel にまとめサイト名を入れない（どこの店の抽選か取り違えさせない）', async () => {
  const site = await siteConfig('pokeca-navi-lotteries');
  // destLabel は report.js で「◯◯で確認」というボタン文言になる。
  // 応募先は項目ごとに別の店なので、ここにまとめサイトの名前を書くと
  // 「ポケカ抽選図鑑で確認」と表示しながら実際には店のフォームへ飛ばすことになる。
  assert.ok(site.destLabel, 'destLabel が空だと shops.js が name（＝まとめサイト名）で埋めてしまう');
  assert.ok(!/図鑑|抽選図鑑|pokeca/i.test(site.destLabel), `destLabel にまとめサイト名が入っている: ${site.destLabel}`);
  // 出典は sourceName（name）側で分かるようにする
  assert.ok(/図鑑/.test(site.name), '出典が分かる name になっていない');
});

test('パース: 商品名・店名・締切・応募URL が1件ずつ取れる', async () => {
  const site = await siteConfig('pokeca-navi-lotteries');
  const items = parseShopList(POKECA_HTML, site);
  assert.equal(items.length, 3);

  const [first] = items;
  // 店名は destLabel として項目ごとに取れるようになったので、
  // タイトルは商品名だけにして読みやすくしている。
  assert.equal(first.title, '30th CELEBRATION BOX', '商品名だけであること');
  assert.equal(first.destLabel, 'Bee本舗', '店名が項目ごとに取れていること');
  assert.equal(
    first.link,
    'https://docs.google.com/forms/d/e/1FAIpQLScMpdHXqGxtGYt3tWmQQwtnxuaU0Hz9eVJfiio_gIJqT3eJZg/viewform'
  );
  // 2026-09-06T20:00:00+09:00 → UTC は同日 11:00。9時間ずれていない事の確認。
  assert.equal(first.deadline, '2026-09-06T11:00:00.000Z');

  assert.equal(items[2].link, 'https://livepocket.jp/t/kv7rf');
  assert.equal(items[2].deadline, '2026-09-06T11:30:00.000Z');
  assert.equal(items[2].destLabel, '文教堂書店浦安西友店', '店名は destLabel 側に入る');
});

test('パース: 3件とも締切が取れる（このサイトを使う理由がこれ）', async () => {
  const site = await siteConfig('pokeca-navi-lotteries');
  const items = parseShopList(POKECA_HTML, site);
  assert.equal(items.filter((i) => i.deadline).length, items.length);
});

test('締切: 年はサイトの値をそのまま使う（取得日から推測しない）', async () => {
  const site = await siteConfig('pokeca-navi-lotteries');
  const items = parseShopList(POKECA_HTML, site);
  for (const it of items) {
    assert.match(it.deadline, /^2026-09-06T/, `年月日が元データとずれている: ${it.deadline}`);
  }
  // 元データがタイムゾーン付きISO8601（2026-09-06T20:00:00+09:00）で年を持っているので、
  // 「9/6(日) 20:00」のような年なし表記を解釈する必要がなく、1年ずれる事故が起きない。
  assert.ok(POKECA_HTML.includes('2026-09-06T20:00:00+09:00'));
});

test('締切: 年の無い表記からは締切を作らない', async () => {
  const site = await siteConfig('pokeca-navi-lotteries');
  // 同じページのDOM側には「締切 9/6(日) 20:00」という年なしの表記もある。
  // これを締切として解釈すると年を推測することになるので、解釈しない事を確かめる。
  const yearless = POKECA_HTML.replace(/2026-09-06T\d\d:\d\d:\d\d\+09:00/g, '9/6 20:00');
  const items = parseShopList(yearless, site);
  for (const it of items) {
    assert.equal(it.deadline, '', '年の無い日付から締切を作ってしまっている');
  }
});

test('受付終了: status が open でない項目は取り込まない', async () => {
  const site = await siteConfig('pokeca-navi-lotteries');
  const closed = POKECA_HTML.replace(String.raw`\"status\":\"open\"`, String.raw`\"status\":\"closed\"`);
  const items = parseShopList(closed, site);
  assert.equal(items.length, 2, '受付終了の1件が混ざっている');
  assert.ok(!items.some((i) => i.link.includes('1FAIpQLScMpdHXqGxtGYt3tWmQQwtnxuaU0Hz9eVJfiio_gIJqT3eJZg')));
});

test('URL: エスケープで途中までしか読めない応募URLは、切り詰めずに項目ごと落とす', async () => {
  const site = await siteConfig('pokeca-navi-lotteries');
  const items = parseShopList(POKECA_ESCAPED_AMP_HTML, site);
  // 「https://www.gangi.co.jp/blog/drawsale-691?utm_source=x」まで読めるが、
  // クエリの途中で切れたURLを応募先として出すと、押した先が違う画面になりうる。
  assert.equal(items.length, 0);
});

test('fetchShopItems: 締切・応募先・出典が RawItem に入る', async () => {
  const site = await siteConfig('pokeca-navi-lotteries');
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return new Response(POKECA_HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  };
  try {
    const items = await fetchShopItems(
      { defaults: { retry: 0, delayMs: 0 }, sites: [site] },
      { now: new Date('2026-09-06T09:00:00Z') }
    );
    assert.equal(items.length, 3);
    for (const it of items) {
      assert.equal(it.kind, 'shop');
      assert.equal(it.destUrl, it.url, '応募先が本文URLと別になっている');
      // 応募先は項目ごとに違う。サイト共通のラベルではなく実際の店名が入る
      assert.ok(it.destLabel && it.destLabel !== site.destLabel, `店名が入っていない: ${it.destLabel}`);
      assert.equal(it.applyVerified, false, '二次情報を「応募できる」と断定してはいけない');
      assert.ok(it.deadline, '締切が落ちている');
      assert.equal(it.sourceName, site.name, '出典が分からなくなっている');
      assert.ok(it.ips.includes('pokemon'));
    }
    // bot対策の回避をしない: UAは固定
    assert.equal(seen.length, 1, 'まとめサイトは1回の取得で全件取れる。何度も叩かない');
    assert.equal(seen[0].init.headers['user-agent'], USER_AGENT);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/* ================================================================== */
/* 入荷Now（無効のまま置いてある）                                     */
/* ================================================================== */

test('設定: nyuka-now-pokemon は無効で、理由が note に書いてある', async () => {
  const site = await siteConfig('nyuka-now-pokemon');
  assert.equal(site.enabled, false);
  assert.ok(site.note.includes('enabled:false の理由'));
  assert.equal(site.deadlinePattern, '', '終了日に年が無いので締切としては使えない');
});

test('入荷Now: 応募受付終了セクションの店を拾わない', async () => {
  const site = await siteConfig('nyuka-now-pokemon');
  const items = parseShopList(NYUKA_HTML, site);
  assert.equal(items.length, 2);
  assert.ok(items.every((i) => !/イオンスタイルオンライン/.test(i.title)), '受付終了の店が混ざっている');
  assert.ok(items[0].title.includes('ノジマオンライン'));
  assert.equal(items[0].link, 'https://contents.online.nojima.co.jp/secret202609/');
  assert.equal(items[1].link, 'https://www.30th.pokemon-card.com/event/30thevent/entry');
  // 締切は取らない（終了日が「9月18日(金)12:00」で年が無い）
  assert.ok(items.every((i) => !i.deadline));
});

test('入荷Now: 受付中と受付終了はマークアップが同一（位置でしか分けられない）', () => {
  // enabled:false にしている一番の理由。見出しが変わると終了済みが流れ込む。
  const open = NYUKA_HTML.slice(NYUKA_HTML.indexOf('<h3>ノジマオンライン'), NYUKA_HTML.indexOf('<h3>ポケモンカードゲーム公式'));
  const ended = NYUKA_HTML.slice(NYUKA_HTML.indexOf('<h3>イオンスタイルオンライン'));
  const shape = (s) => (s.match(/<(?:h3|figure|table|th|td)\b/g) || []).join(',');
  assert.ok(shape(open).length > 0);
  assert.equal(shape(open).startsWith('<h3,<figure,<table'), true);
  assert.equal(shape(ended).includes('<figure,<table'), true);
});
