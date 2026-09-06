/**
 * test/shops.test.js — 区画I: 小売店の抽選・予約ページ監視のユニットテスト
 *
 * ネットワークアクセスなしで動く。実行: node --test test/shops.test.js
 * HTML / JSON 断片は 2026-08-30 に実際に取得したページ・APIレスポンスからの抜粋（作り物ではない）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  parseShopList,
  parseShopJson,
  fetchShopItems,
  fetchSiteEntries,
  resolveUrlTemplate,
  toIsoDate,
  makeItemId,
  USER_AGENT,
  HARD_CONCURRENCY_LIMIT,
} from '../src/sources/shops.js';

const CONFIG_PATH = fileURLToPath(new URL('../config/shop-sources.json', import.meta.url));

/** 設定ファイルから id 指定でサイト定義を取り出す */
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
 * https://www.c-labo-online.jp/new?num=120 の抜粋。
 * 1件目=書籍（そのまま採用）、2件目=内袋未開封（titleExcludeで落ちる）、
 * 3件目=相対URL（baseUrlで絶対化されるか）、4件目=検索ページ由来の入れ子span。
 */
const CLABO_HTML = `
<ul class="flex_layout flex_wrap reset_list_style tiled_list async_image_loader">
  <li class="list_item_cell wrapped_item flex_layout list_item_407122">
    <div class="item_data">
      <a href="https://www.c-labo-online.jp/product/407122" class="item_data_link">
        <div class="list_item_data">
          <p class="item_name">
<span class="goods_name">[書籍]LoveLive!Days 2026年10月号[ラブカ PRカード+オリジナルA4クリアファイル付] [2608/28]</span>
          </p>
          <p class="stock">在庫数10</p>
        </div>
      </a>
    </div>
  </li>
  <li class="list_item_cell wrapped_item flex_layout list_item_407001">
    <div class="item_data">
      <a href="https://www.c-labo-online.jp/product/407001" class="item_data_link">
        <div class="list_item_data">
          <p class="item_name">
<span class="goods_name">[内袋未開封]「ストレングス」「デッドマスター」2枚セット ※DIVINE CROSS カートン封入特典</span>
          </p>
        </div>
      </a>
    </div>
  </li>
  <li class="list_item_cell wrapped_item flex_layout list_item_406900">
    <div class="item_data">
      <a href="/product/406900" class="item_data_link">
        <div class="list_item_data">
          <p class="item_name">
<span class="goods_name">[新品ボックス]デュエル・マスターズTCG 逆札篇 第1弾 逆転神VS切札竜【DM26-RP1】(1BOX=30パック) [再販/2609]</span>
          </p>
        </div>
      </a>
    </div>
  </li>
  <li class="list_item_cell wrapped_item flex_layout list_item_406800">
    <div class="item_data">
      <a href="https://www.c-labo-online.jp/product/406800" class="item_data_link">
        <div class="list_item_data">
          <p class="item_name">
<span class="goods_name">【<span class="result_emphasis text-12r"><b>予約</b></span>】[新品]ヴァイスシュヴァルツ トライアルデッキ 『ステラソラ』[2610/16]</span>
          </p>
        </div>
      </a>
    </div>
  </li>
</ul>
`;

/**
 * https://rdc-api-catalog-gateway-api.rakuten.co.jp/books/search-items?...&luckyDrawFlg=1
 * のレスポンス抜粋（フィールドは実物どおり、説明文だけ削っている）。
 */
const RAKUTEN_JSON = {
  header: { hit_count: 4, start: 0, cached: true },
  items: [
    {
      item_url: 'https://books.rakuten.co.jp/rb/18737983/',
      title: '【抽選販売】初音ミク　マジック：ザ・ギャザリング Secret Lair Miku Fan Merch Bundle【クレジットカード決済限定】',
      stock_status_text: '入荷予約（入荷次第発送）',
      creation_time: '2026-06-01T22:00:31.000Z',
      release_date: '20260916',
    },
    {
      item_url: 'https://books.rakuten.co.jp/rb/18506278/',
      title: 'ドラゴンボールスーパーカードゲーム フュージョンワールド ブースターパック CROSS FORCE [FB10]',
      stock_status_text: '入荷予約（入荷次第発送）',
      creation_time: '2026-01-15T19:30:30.000Z',
      release_date: '20260613',
    },
    {
      // カード関連ではないので titleFilter で落ちるべき
      item_url: 'https://books.rakuten.co.jp/rb/18782030/',
      title: 'Google Fitbit Air 限定モデル Pokemon Sleep',
      stock_status_text: '入荷予約（入荷次第発送）',
      creation_time: '2026-08-20T10:00:00.000Z',
    },
    {
      // item_url が無いので捨てられるべき
      title: 'URLの無い壊れた行',
      creation_time: '2026-08-29T00:00:00.000Z',
    },
  ],
};

/* ================================================================== */
/* parseShopList（HTML・純関数）                                       */
/* ================================================================== */

test('parseShopList: カードラボの新着一覧から title / link を取り出す', async () => {
  const site = await siteConfig('c-labo-new');
  const items = parseShopList(CLABO_HTML, site);

  // 内袋未開封は titleExclude で落ちるので3件
  assert.equal(items.length, 3);

  assert.equal(
    items[0].title,
    '[書籍]LoveLive!Days 2026年10月号[ラブカ PRカード+オリジナルA4クリアファイル付] [2608/28]'
  );
  assert.equal(items[0].link, 'https://www.c-labo-online.jp/product/407122');
  // 一覧ページに日付が無いサイトなので pubDate は空文字（親が現在時刻を入れる約束）
  assert.equal(items[0].pubDate, '');
});

test('parseShopList: titleExclude で封入特典のバラ売りを落とす', async () => {
  const site = await siteConfig('c-labo-new');
  const titles = parseShopList(CLABO_HTML, site).map((i) => i.title);
  assert.ok(!titles.some((t) => t.includes('内袋未開封')), '内袋未開封が残っている');
});

test('parseShopList: 相対URLを baseUrl で絶対化する', async () => {
  const site = await siteConfig('c-labo-new');
  const items = parseShopList(CLABO_HTML, site);
  const dm = items.find((i) => i.title.includes('デュエル・マスターズ'));
  assert.ok(dm, 'デュエマの行が取れていない');
  assert.equal(dm.link, 'https://www.c-labo-online.jp/product/406900');
});

test('parseShopList: goods_name に入れ子spanがあってもタイトルを取り切る', async () => {
  const site = await siteConfig('c-labo-new');
  const items = parseShopList(CLABO_HTML, site);
  const ws = items.find((i) => i.title.includes('ヴァイスシュヴァルツ'));
  assert.ok(ws, '入れ子spanの行が取れていない');
  // <span class="result_emphasis"><b>予約</b></span> が剥がされて1本の文字列になる
  assert.equal(ws.title, '【予約】[新品]ヴァイスシュヴァルツ トライアルデッキ 『ステラソラ』[2610/16]');
});

test('parseShopList: itemPattern が無い設定は空配列（JSONサイトを誤ってHTMLで通しても壊れない）', async () => {
  const site = await siteConfig('rakuten-books-lottery');
  assert.deepEqual(parseShopList('<html>whatever</html>', site), []);
  assert.deepEqual(parseShopList('', { itemPattern: '<li>([\\s\\S]*?)</li>' }), []);
  assert.deepEqual(parseShopList(null, null), []);
});

test('parseShopList: maxItemsPerSite を超えない', () => {
  const html = Array.from({ length: 10 }, (_, i) =>
    `<li class="list_item_cell x"><a href="/product/${i}"></a><p class="item_name">商品${i}</p></li>`
  ).join('');
  const items = parseShopList(html, {
    baseUrl: 'https://example.jp',
    itemPattern: '<li class="list_item_cell[^"]*">([\\s\\S]*?)</li>',
    linkPattern: 'href="([^"]+)"',
    titlePattern: '<p class="item_name">([\\s\\S]*?)</p>',
    maxItemsPerSite: 3,
  });
  assert.equal(items.length, 3);
});

/* ================================================================== */
/* parseShopJson（JSON・純関数）                                       */
/* ================================================================== */

test('parseShopJson: 楽天ブックス抽選APIから title / link を取り出す', async () => {
  const site = await siteConfig('rakuten-books-lottery');
  const items = parseShopJson(RAKUTEN_JSON, site);

  // Fitbit は titleFilter で落ち、URL無し行も落ちるので2件
  assert.equal(items.length, 2);
  assert.ok(items[0].title.startsWith('【抽選販売】初音ミク'));
  assert.equal(items[0].link, 'https://books.rakuten.co.jp/rb/18737983/');
  assert.ok(items[1].title.includes('フュージョンワールド'));

  // このサイトは dateKey を設定していないので pubDate は空
  assert.equal(items[0].pubDate, '');
});

test('parseShopJson: dateKey + dateFormat:iso で creation_time を pubDate にする', async () => {
  const site = await siteConfig('rakuten-books-tcg-new');
  const items = parseShopJson(RAKUTEN_JSON, site);
  const db = items.find((i) => i.title.includes('フュージョンワールド'));
  assert.ok(db);
  assert.equal(db.pubDate, '2026-01-15T19:30:30.000Z');
});

test('parseShopJson: 配列でない / listKey が無いレスポンスは空配列', () => {
  assert.deepEqual(parseShopJson({}, { listKey: 'items' }), []);
  assert.deepEqual(parseShopJson({ items: 'not-an-array' }, { listKey: 'items' }), []);
  assert.deepEqual(parseShopJson(null, null), []);
});

test('parseShopJson: linkTemplate の {path} 差し込みと重複除去', () => {
  const site = {
    baseUrl: 'https://www.hareruya2.com',
    listKey: 'products',
    titleKey: 'title',
    pathKey: 'handle',
    linkTemplate: 'https://www.hareruya2.com/products/{path}',
  };
  const items = parseShopJson(
    { products: [{ title: 'テスト商品', handle: 'test-item' }, { title: 'テスト商品', handle: 'test-item' }] },
    site
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].link, 'https://www.hareruya2.com/products/test-item');
});

/* ================================================================== */
/* 小物                                                                */
/* ================================================================== */

test('resolveUrlTemplate: {env:NAME} を置換し、未設定なら null と欠落名を返す', () => {
  const ok = resolveUrlTemplate('https://x.jp/api?id={env:APP_ID}', { APP_ID: 'abc123' });
  assert.equal(ok.url, 'https://x.jp/api?id=abc123');
  assert.deepEqual(ok.missing, []);

  const ng = resolveUrlTemplate('https://x.jp/api?id={env:APP_ID}&k={env:KEY}', { APP_ID: 'a' });
  assert.equal(ng.url, null);
  assert.deepEqual(ng.missing, ['KEY']);

  // プレースホルダが無いURLはそのまま
  assert.equal(resolveUrlTemplate('https://x.jp/', {}).url, 'https://x.jp/');
});

test('toIsoDate: ISO文字列はそのまま、壊れた値は空文字', () => {
  assert.equal(toIsoDate('2026-08-27T17:20:31.000Z'), '2026-08-27T17:20:31.000Z');
  assert.equal(toIsoDate('なんでもない文字列'), '');
  assert.equal(toIsoDate(''), '');
  assert.equal(toIsoDate(null), '');
});

test('makeItemId: 正規化タイトル+URL から16桁の安定IDを作る', () => {
  const a = makeItemId('ポケモンカードゲーム MEGA', 'https://books.rakuten.co.jp/rb/1/');
  const b = makeItemId('ポケモンカードゲーム　MEGA！', 'https://books.rakuten.co.jp/rb/1/');
  assert.equal(a.length, 16);
  assert.equal(a, b, '記号・空白のゆれで別IDになってはいけない');
  assert.notEqual(a, makeItemId('ポケモンカードゲーム MEGA', 'https://books.rakuten.co.jp/rb/2/'));
});

test('UA はブラウザになりすまさない（bot対策の回避をしない担保）', () => {
  assert.equal(USER_AGENT, 'Mozilla/5.0 (compatible; TCGNewsBot/1.0)');
  assert.ok(HARD_CONCURRENCY_LIMIT <= 3, '同時実行は3以下でなければならない');
});

/* ================================================================== */
/* fetchShopItems（fetch をスタブして検証）                            */
/* ================================================================== */

/** globalThis.fetch を差し替えて、呼ばれたURLを記録する */
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

/** console.warn / console.log を黙らせる（テスト出力を汚さない） */
function muteConsole() {
  const warn = console.warn;
  const log = console.log;
  const warnings = [];
  console.warn = (...a) => warnings.push(a.join(' '));
  console.log = () => {};
  return {
    warnings,
    restore() {
      console.warn = warn;
      console.log = log;
    },
  };
}

const jsonResponse = (obj) =>
  new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
const htmlResponse = (html) =>
  new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });

test('fetchShopItems: RawItem に kind/tier/destUrl/destLabel が必ず入る', async () => {
  const config = {
    defaults: { weight: 1.35, retry: 0, delayMs: 0 },
    sites: [
      {
        id: 'shop-a',
        name: 'テスト書店',
        destLabel: 'テスト書店',
        url: 'https://example.jp/api',
        baseUrl: 'https://example.jp',
        ips: ['dragonball'],
        weight: 1.35,
        enabled: true,
        type: 'json',
        listKey: 'items',
        titleKey: 'title',
        pathKey: 'item_url',
      },
    ],
  };

  const f = stubFetch(() =>
    jsonResponse({ items: [{ title: 'ドラゴンボール フュージョンワールド 抽選販売', item_url: 'https://example.jp/p/1' }] })
  );
  const c = muteConsole();
  try {
    const items = await fetchShopItems(config, { now: new Date('2026-08-30T00:00:00Z') });
    assert.equal(items.length, 1);
    const it = items[0];
    assert.equal(it.kind, 'shop');
    assert.equal(it.tier, 'shop');
    assert.equal(it.destUrl, it.url);
    assert.equal(it.destUrl, 'https://example.jp/p/1');
    assert.equal(it.destLabel, 'テスト書店');
    assert.equal(it.sourceId, 'shop-a');
    assert.equal(it.sourceWeight, 1.35);
    assert.equal(it.id.length, 16);
    // ips: 設定のもの + タイトルに抽選語があるので lottery が足される
    assert.deepEqual(it.ips.sort(), ['dragonball', 'lottery']);
    // 日付が取れないサイトなので publishedAt は now
    assert.equal(it.publishedAt, '2026-08-30T00:00:00.000Z');
    assert.equal(it.startsAt, null);
    assert.equal(it.deadline, null);
  } finally {
    f.restore();
    c.restore();
  }
});

test('fetchShopItems: ips 未設定のサイトは空配列のまま（親がタイトルから判定する）', async () => {
  const config = {
    defaults: { retry: 0, delayMs: 0 },
    sites: [
      {
        id: 'shop-noip',
        name: '店',
        url: 'https://example.jp/api',
        baseUrl: 'https://example.jp',
        enabled: true,
        type: 'json',
        listKey: 'items',
        titleKey: 'title',
        pathKey: 'item_url',
      },
    ],
  };
  const f = stubFetch(() => jsonResponse({ items: [{ title: '普通の商品名', item_url: 'https://example.jp/p/9' }] }));
  const c = muteConsole();
  try {
    const items = await fetchShopItems(config, {});
    assert.deepEqual(items[0].ips, []);
  } finally {
    f.restore();
    c.restore();
  }
});

test('fetchShopItems: enabled:false のサイトは一切fetchしない', async () => {
  const config = {
    defaults: { retry: 0, delayMs: 0 },
    sites: [
      { id: 'blocked', name: 'ブロックされた店', url: 'https://blocked.example/', enabled: false, type: 'html' },
      {
        id: 'ok',
        name: 'OKな店',
        url: 'https://ok.example/api',
        baseUrl: 'https://ok.example',
        enabled: true,
        type: 'json',
        listKey: 'items',
        titleKey: 'title',
        pathKey: 'item_url',
      },
    ],
  };
  const f = stubFetch(() => jsonResponse({ items: [{ title: '商品', item_url: 'https://ok.example/p/1' }] }));
  const c = muteConsole();
  try {
    await fetchShopItems(config, {});
    assert.equal(f.calls.length, 1);
    assert.ok(!f.calls.some((x) => x.url.includes('blocked.example')), 'enabled:false のサイトを叩いている');
  } finally {
    f.restore();
    c.restore();
  }
});

test('fetchShopItems: 環境変数が未設定のサイトはスキップして warn する', async () => {
  const config = {
    defaults: { retry: 0, delayMs: 0 },
    sites: [
      { id: 'needs-key', name: 'APIキーが要る店', url: 'https://api.example/?k={env:MISSING_KEY}', enabled: true, type: 'json' },
    ],
  };
  const f = stubFetch(() => jsonResponse({ items: [] }));
  const c = muteConsole();
  try {
    const items = await fetchShopItems(config, { env: {} });
    assert.deepEqual(items, []);
    assert.equal(f.calls.length, 0);
    assert.ok(c.warnings.some((w) => w.includes('MISSING_KEY')));
  } finally {
    f.restore();
    c.restore();
  }
});

test('fetchShopItems: 1サイトが失敗しても throw せず、他のサイトは生き残る', async () => {
  const config = {
    defaults: { retry: 0, delayMs: 0 },
    sites: [
      { id: 'ng', name: 'ダメな店', url: 'https://ng.example/api', enabled: true, type: 'json', listKey: 'items' },
      {
        id: 'ok',
        name: 'OKな店',
        url: 'https://ok.example/api',
        baseUrl: 'https://ok.example',
        enabled: true,
        type: 'json',
        listKey: 'items',
        titleKey: 'title',
        pathKey: 'item_url',
      },
    ],
  };
  const f = stubFetch((url) => {
    if (url.includes('ng.example')) return new Response('nope', { status: 403 });
    return jsonResponse({ items: [{ title: '生き残った商品', item_url: 'https://ok.example/p/1' }] });
  });
  const c = muteConsole();
  try {
    const items = await fetchShopItems(config, {});
    assert.equal(items.length, 1);
    assert.equal(items[0].sourceId, 'ok');
    assert.ok(c.warnings.some((w) => w.includes('取得失敗') && w.includes('ng')));
  } finally {
    f.restore();
    c.restore();
  }
});

test('fetchShopItems: 全サイト失敗でも throw せず空配列を返す', async () => {
  const config = {
    defaults: { retry: 0, delayMs: 0 },
    sites: [{ id: 'ng', name: 'ダメな店', url: 'https://ng.example/api', enabled: true, type: 'json', listKey: 'items' }],
  };
  const f = stubFetch(() => {
    throw new TypeError('fetch failed');
  });
  const c = muteConsole();
  try {
    const items = await fetchShopItems(config, {});
    assert.deepEqual(items, []);
  } finally {
    f.restore();
    c.restore();
  }
});

test('fetchShopItems: 取得0件は warn するだけで throw しない', async () => {
  const config = {
    defaults: { retry: 0, delayMs: 0 },
    sites: [
      {
        id: 'empty',
        name: '空の店',
        url: 'https://empty.example/api',
        baseUrl: 'https://empty.example',
        enabled: true,
        type: 'json',
        listKey: 'items',
        titleKey: 'title',
        pathKey: 'item_url',
      },
    ],
  };
  const f = stubFetch(() => jsonResponse({ items: [] }));
  const c = muteConsole();
  try {
    const items = await fetchShopItems(config, {});
    assert.deepEqual(items, []);
    assert.ok(c.warnings.some((w) => w.includes('取得0件') && w.includes('empty')));
  } finally {
    f.restore();
    c.restore();
  }
});

test('fetchShopItems: 有効サイトが0件でも throw しない', async () => {
  const c = muteConsole();
  try {
    assert.deepEqual(await fetchShopItems({ sites: [] }, {}), []);
    assert.deepEqual(await fetchShopItems(null, {}), []);
    assert.ok(c.warnings.some((w) => w.includes('有効な小売店サイト設定が0件')));
  } finally {
    c.restore();
  }
});

test('fetchShopItems: 送信ヘッダのUAがブラウザ偽装になっていない', async () => {
  const config = {
    defaults: { retry: 0, delayMs: 0 },
    sites: [
      {
        id: 'ua',
        name: '店',
        url: 'https://ua.example/api',
        baseUrl: 'https://ua.example',
        enabled: true,
        type: 'json',
        listKey: 'items',
        titleKey: 'title',
        pathKey: 'item_url',
      },
    ],
  };
  const f = stubFetch(() => jsonResponse({ items: [] }));
  const c = muteConsole();
  try {
    await fetchShopItems(config, {});
    const ua = f.calls[0].init.headers['user-agent'];
    assert.equal(ua, 'Mozilla/5.0 (compatible; TCGNewsBot/1.0)');
    assert.ok(!/Chrome|Safari\/\d|Firefox/.test(ua), 'ブラウザになりすましている');
  } finally {
    f.restore();
    c.restore();
  }
});

test('fetchShopItems: 日付が取れるサイトは maxAgeHours で足切りされる', async () => {
  const config = {
    defaults: { retry: 0, delayMs: 0 },
    sites: [
      {
        id: 'dated',
        name: '店',
        url: 'https://dated.example/api',
        baseUrl: 'https://dated.example',
        enabled: true,
        type: 'json',
        listKey: 'items',
        titleKey: 'title',
        pathKey: 'item_url',
        dateKey: 'creation_time',
        dateFormat: 'iso',
      },
    ],
  };
  const f = stubFetch(() =>
    jsonResponse({
      items: [
        { title: '新しい商品', item_url: 'https://dated.example/p/1', creation_time: '2026-08-29T00:00:00.000Z' },
        { title: '古い商品', item_url: 'https://dated.example/p/2', creation_time: '2026-01-01T00:00:00.000Z' },
      ],
    })
  );
  const c = muteConsole();
  try {
    const items = await fetchShopItems(config, { now: new Date('2026-08-30T00:00:00Z'), maxAgeHours: 168 });
    assert.equal(items.length, 1);
    assert.equal(items[0].title, '新しい商品');
    assert.equal(items[0].publishedAt, '2026-08-29T00:00:00.000Z');
  } finally {
    f.restore();
    c.restore();
  }
});

test('fetchShopItems: 同一商品が複数サイト定義に出ても1件に統合される', async () => {
  const site = (id) => ({
    id,
    name: '楽天ブックス',
    destLabel: '楽天ブックス',
    url: `https://api.example/${id}`,
    baseUrl: 'https://books.rakuten.co.jp',
    enabled: true,
    type: 'json',
    listKey: 'items',
    titleKey: 'title',
    pathKey: 'item_url',
  });
  const config = { defaults: { retry: 0, delayMs: 0 }, sites: [site('a'), site('b')] };
  const f = stubFetch(() =>
    jsonResponse({ items: [{ title: '同じ商品', item_url: 'https://books.rakuten.co.jp/rb/1/' }] })
  );
  const c = muteConsole();
  try {
    const items = await fetchShopItems(config, {});
    assert.equal(items.length, 1);
  } finally {
    f.restore();
    c.restore();
  }
});

test('fetchSiteEntries: html型は parseShopList を通る', async () => {
  const site = await siteConfig('c-labo-new');
  const f = stubFetch(() => htmlResponse(CLABO_HTML));
  try {
    const entries = await fetchSiteEntries({ ...site, resolvedUrl: site.url });
    assert.equal(entries.length, 3);
    assert.ok(entries[0].link.startsWith('https://www.c-labo-online.jp/product/'));
  } finally {
    f.restore();
  }
});

/* ================================================================== */
/* 設定ファイル自体の健全性                                            */
/* ================================================================== */

test('config/shop-sources.json: 全サイトが必須キーを持ち、id が一意', async () => {
  const cfg = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
  assert.ok(Array.isArray(cfg.sites) && cfg.sites.length > 0);

  const ids = new Set();
  for (const s of cfg.sites) {
    assert.ok(s.id, 'id が無いサイトがある');
    assert.ok(!ids.has(s.id), `id が重複: ${s.id}`);
    ids.add(s.id);
    assert.ok(s.url, `${s.id}: url が無い`);
    assert.ok(s.name, `${s.id}: name が無い`);
    assert.ok(s.note, `${s.id}: note（調査メモ）が無い`);
    // rss は小売店のお知らせがWordPress等のRSSで出ている場合に使う
    assert.ok(['html', 'json', 'rss'].includes(s.type), `${s.id}: type が不正`);
    assert.ok(Array.isArray(s.ips), `${s.id}: ips が配列でない`);
    assert.equal(typeof s.enabled, 'boolean', `${s.id}: enabled が boolean でない`);
    // 無効サイトは必ず理由を note に書く約束
    if (s.enabled === false) {
      assert.ok(s.note.includes('enabled:false の理由'), `${s.id}: 無効化の理由が note に無い`);
    }
  }
});

test('config/shop-sources.json: 有効サイトの正規表現が全てコンパイルできる', async () => {
  const cfg = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
  for (const s of cfg.sites.filter((x) => x.enabled !== false)) {
    for (const key of ['itemPattern', 'linkPattern', 'titlePattern', 'datePattern', 'titleFilter', 'titleExclude']) {
      if (!s[key]) continue;
      assert.doesNotThrow(() => new RegExp(s[key]), `${s.id}.${key} が正規表現として壊れている`);
    }
  }
});

test('config/shop-sources.json: 有効な html サイトは itemPattern/linkPattern/titlePattern が揃っている', async () => {
  const cfg = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
  for (const s of cfg.sites.filter((x) => x.enabled !== false && x.type === 'html')) {
    assert.ok(s.itemPattern, `${s.id}: itemPattern が無い`);
    assert.ok(s.linkPattern, `${s.id}: linkPattern が無い`);
    assert.ok(s.titlePattern, `${s.id}: titlePattern が無い`);
    assert.ok(s.baseUrl, `${s.id}: baseUrl が無い`);
  }
});

test('config/shop-sources.json: 小売店のweightは公式(1.4)を超えない', async () => {
  const cfg = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
  for (const s of cfg.sites) {
    if (typeof s.weight !== 'number') continue;
    assert.ok(s.weight <= 1.4, `${s.id}: weight ${s.weight} が公式(1.4)以上`);
    assert.ok(s.weight >= 0.5, `${s.id}: weight ${s.weight} が下限0.5未満`);
  }
});
