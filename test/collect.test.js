/**
 * test/collect.test.js — 収集ロジックのユニットテスト（ネットワーク不使用）
 * 実行: node --test test/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  normalizeForMatch,
  keywordMatches,
  matchIps,
  hasLotteryIntent,
  makeItemId,
  buildGoogleNewsUrl,
  buildFeedTasks,
  runPool,
  collectAll,
  LOTTERY_HINTS,
} from '../src/collect.js';

import { isXReadEnabled, fetchXItems } from '../src/sources/xlists.js';
import { clearResolveCache } from '../src/resolve.js';

const SOURCES_PATH = new URL('../config/sources.json', import.meta.url);

/* ------------------------------------------------------------------ */
/* 正規化・キーワードマッチ                                            */
/* ------------------------------------------------------------------ */

test('normalizeForMatch: 全角半角・大小文字・記号・空白を吸収する', () => {
  assert.equal(normalizeForMatch('ＭＴＧ'), 'mtg');
  assert.equal(normalizeForMatch('MTG'), 'mtg');
  assert.equal(normalizeForMatch('ﾎﾟｹﾓﾝｶｰﾄﾞ'), 'ポケモンカード');
  assert.equal(normalizeForMatch('デュエル・マスターズ'), 'デュエルマスターズ');
  assert.equal(normalizeForMatch('スカーレット＆バイオレット'), 'スカーレットバイオレット');
  assert.equal(normalizeForMatch('マジック：ザ・ギャザリング'), 'マジックザギャザリング');
  assert.equal(normalizeForMatch('  ポケモン カード  '), 'ポケモンカード');
  assert.equal(normalizeForMatch(null), '');
});

test('keywordMatches: 空白入りキーワードは AND 条件（順不同）', () => {
  const text = normalizeForMatch('新作のトレーディングカードゲームが始動する');
  assert.equal(keywordMatches(text, 'トレーディングカードゲーム 始動'), true);
  assert.equal(keywordMatches(text, '始動 トレーディングカードゲーム'), true, '順不同でマッチ');
  assert.equal(keywordMatches(text, 'トレーディングカードゲーム 終了'), false);
  assert.equal(keywordMatches(text, ''), false);
});

/* ------------------------------------------------------------------ */
/* IP判定                                                              */
/* ------------------------------------------------------------------ */

const IPS = {
  pokemon: { keywords: ['ポケモンカード', 'ポケカ', 'スカーレット&バイオレット'] },
  onepiece: { keywords: ['ワンピースカード', 'ONE PIECEカードゲーム', 'OPCG'] },
  dragonball: { keywords: ['フュージョンワールド', 'DBSCG'] },
  mtg: { keywords: ['マジック：ザ・ギャザリング', 'MTG'] },
  duelmasters: { keywords: ['デュエル・マスターズ', 'デュエマ'] },
  newtcg: { keywords: ['新作カードゲーム', 'TCG 発表'] },
  lottery: { keywords: ['抽選販売', '再販'] },
};

test('matchIps: タイトルからIPキーを判定する', () => {
  assert.deepEqual(matchIps('ポケモンカードの新弾が発売', IPS), ['pokemon']);
  assert.deepEqual(matchIps('ﾎﾟｹｶ 抽選', IPS), ['pokemon'], '半角カナも吸収');
  assert.deepEqual(matchIps('スカーレット＆バイオレット新セット', IPS), ['pokemon'], '全角＆を吸収');
  assert.deepEqual(matchIps('ONE PIECEカードゲーム 頂上決戦', IPS), ['onepiece']);
  assert.deepEqual(matchIps('マジック：ザ・ギャザリング 新セット', IPS), ['mtg']);
  assert.deepEqual(
    matchIps('マジック・ザ・ギャザリングの話', IPS),
    ['mtg'],
    '中黒/コロンの表記ゆれを吸収してマッチする'
  );
  assert.deepEqual(matchIps('デュエルマスターズ 新弾', IPS), ['duelmasters'], '中黒の有無を吸収');
  assert.deepEqual(matchIps('TCGが発表された', IPS), ['newtcg'], '空白入りキーワードのAND');
});

test('matchIps: 複数IPにまたがる場合は全部返す / 無関係なら空', () => {
  const got = matchIps('ポケモンカードとワンピースカードのコラボ', IPS);
  assert.deepEqual(got.sort(), ['onepiece', 'pokemon']);
  assert.deepEqual(matchIps('今日の天気は晴れです', IPS), []);
  assert.deepEqual(matchIps('', IPS), []);
});

test('matchIps: lottery は返さない（横断タグとして別扱い）', () => {
  assert.equal(matchIps('抽選販売の再販情報', IPS).includes('lottery'), false);
});

test('hasLotteryIntent: 抽選/予約/受注/再販/応募/当選 を検出', () => {
  for (const w of LOTTERY_HINTS) {
    assert.equal(hasLotteryIntent(`テスト${w}テスト`), true, `${w} を検出できること`);
  }
  assert.equal(hasLotteryIntent('ただの発売日情報'), false);
  assert.equal(hasLotteryIntent('抽　選'), true, '全角スペース入りも吸収');
});

/* ------------------------------------------------------------------ */
/* ID / URL 組み立て                                                   */
/* ------------------------------------------------------------------ */

test('makeItemId: 16文字の安定ID。表記ゆれでも同一', () => {
  const a = makeItemId('ポケモンカード 抽選販売', 'https://example.com/a');
  const b = makeItemId('ポケモンカード　抽選販売', 'https://example.com/a');
  const c = makeItemId('ポケモンカード 抽選販売', 'https://example.com/b');
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('buildGoogleNewsUrl: クエリをURLエンコードして組み立てる', () => {
  const url = buildGoogleNewsUrl('ポケモンカード 抽選');
  assert.equal(
    url,
    `https://news.google.com/rss/search?q=${encodeURIComponent('ポケモンカード 抽選')}&hl=ja&gl=JP&ceid=JP:ja`
  );
  assert.ok(url.includes('hl=ja'));
});

/* ------------------------------------------------------------------ */
/* config/sources.json の妥当性                                        */
/* ------------------------------------------------------------------ */

test('config/sources.json: 契約どおりのIPキーとフィード定義を持つ', async () => {
  const cfg = JSON.parse(await readFile(SOURCES_PATH, 'utf8'));
  const expected = [
    'pokemon',
    'onepiece',
    'dragonball',
    'gundam',
    'hololive',
    'yugioh',
    'duelmasters',
    'mtg',
    'newtcg',
    // 第2フェーズで追加。プレミアムバンダイ等で実際に流通しているカードゲーム。
    // バッジが出ないと「何のカードか分からない」ため、実データに合わせて拡張した。
    'digimon',
    'battlespirits',
    'aikatsu',
    'carddass',
    // 小売店の実データに存在した主要TCG
    'vanguard',
    'weiss',
    // 区画M: ユニオンアリーナ（バンダイのクロスIP TCG）
    'unionarena',
    'lottery',
  ];
  assert.deepEqual(Object.keys(cfg.ips), expected);

  for (const [key, def] of Object.entries(cfg.ips)) {
    assert.ok(def.label, `${key}: label 必須`);
    assert.ok(def.weight >= 0.5 && def.weight <= 1.5, `${key}: weight は 0.5〜1.5`);
    assert.ok(Array.isArray(def.keywords) && def.keywords.length > 0, `${key}: keywords 必須`);
    assert.ok(def.hashtag.startsWith('#'), `${key}: hashtag は # 始まり`);
  }

  assert.ok(cfg.feeds.length >= 7, 'ニュースRSSは7本以上');
  const ids = new Set();
  for (const f of cfg.feeds) {
    assert.ok(f.id && !ids.has(f.id), `feed id は一意: ${f.id}`);
    ids.add(f.id);
    assert.match(f.url, /^https:\/\//);
    assert.ok(f.weight >= 0.5 && f.weight <= 1.5);
    assert.equal(f.type, 'rss');
  }

  assert.equal(cfg.googleNews.enabled, true);
  // クエリは 18本 → 90本に拡充（遊戯王・デュエマ等の取りこぼし対策）。
  // 上限90は取得時間と相手サーバ負荷の都合。詳細な検証は test/queries.test.js。
  assert.ok(cfg.googleNews.queries.length >= 12 && cfg.googleNews.queries.length <= 120);
  const ipKeys = new Set(Object.keys(cfg.ips));
  for (const q of cfg.googleNews.queries) {
    assert.ok(q.query, 'query 必須');
    assert.ok(Array.isArray(q.ips) && q.ips.length > 0, `${q.id}: ips 必須`);
    for (const ip of q.ips) assert.ok(ipKeys.has(ip), `${q.id}: 未知のIPキー ${ip}`);
    assert.equal(q.weight, 1.0);
  }
});

test('buildFeedTasks: feeds と googleNews からタスクを作る', async () => {
  const cfg = JSON.parse(await readFile(SOURCES_PATH, 'utf8'));
  const tasks = buildFeedTasks(cfg);
  assert.equal(tasks.length, cfg.feeds.length + cfg.googleNews.queries.length);
  assert.equal(tasks.filter((t) => t.origin === 'google').length, cfg.googleNews.queries.length);
  for (const t of tasks) assert.match(t.url, /^https:\/\//);

  // googleNews を無効にすると RSS だけになる
  const off = buildFeedTasks({ ...cfg, googleNews: { ...cfg.googleNews, enabled: false } });
  assert.equal(off.length, cfg.feeds.length);
  assert.deepEqual(buildFeedTasks({}), []);
  assert.deepEqual(buildFeedTasks(null), []);
});

/* ------------------------------------------------------------------ */
/* 同時実行プール                                                      */
/* ------------------------------------------------------------------ */

test('runPool: 同時実行数を超えない / 失敗しても他は続行する', async () => {
  let running = 0;
  let peak = 0;
  const input = Array.from({ length: 20 }, (_, i) => i);

  const results = await runPool(input, 4, async (n) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 1));
    running--;
    if (n % 5 === 0) throw new Error(`fail-${n}`);
    return n * 2;
  });

  assert.ok(peak <= 4, `同時実行のピークは4以下（実測 ${peak}）`);
  assert.equal(results.length, 20);
  assert.equal(results[1].ok, true);
  assert.equal(results[1].value, 2);
  assert.equal(results[0].ok, false);
  assert.match(results[0].error.message, /fail-0/);
  assert.equal(results.filter((r) => r.ok).length, 16);
});

test('runPool: 空配列でも動く', async () => {
  assert.deepEqual(await runPool([], 6, async () => 1), []);
});

/* ------------------------------------------------------------------ */
/* collectAll（fetch をスタブしてネットワーク不使用で検証）            */
/* ------------------------------------------------------------------ */

function rssWithItems(items) {
  const body = items
    .map(
      (it) => `<item>
        <title><![CDATA[${it.title}]]></title>
        <link>${it.link}</link>
        <pubDate>${it.pubDate}</pubDate>
        <description><![CDATA[${it.desc || ''}]]></description>
      </item>`
    )
    .join('\n');
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>テストフィード</title>${body}</channel></rss>`;
}

function stubFetch(routes) {
  return async (url) => {
    const key = String(url);
    const body = routes[key];
    if (body === undefined) {
      return { ok: false, status: 404, statusText: 'Not Found', url: key, text: async () => '' };
    }
    if (body instanceof Error) throw body;
    return { ok: true, status: 200, statusText: 'OK', url: key, text: async () => body };
  };
}

test('collectAll: IPにマッチしない記事を捨て、lottery を横断付与する', async () => {
  clearResolveCache();
  const now = new Date('2026-08-23T00:00:00Z');
  const recent = 'Fri, 22 Aug 2026 09:00:00 +0900';
  const old = 'Mon, 01 Jun 2026 09:00:00 +0900';

  const feedUrl = 'https://feed.test/a.xml';
  const xml = rssWithItems([
    { title: 'ポケモンカード ハイクラスパックの抽選販売が決定', link: 'https://a.test/1?utm_source=rss', pubDate: recent },
    { title: '本日の株式市況まとめ', link: 'https://a.test/2', pubDate: recent },
    { title: 'ワンピースカード 新弾レビュー', link: 'https://a.test/3', pubDate: recent },
    { title: 'ポケモンカード 過去の抽選情報', link: 'https://a.test/4', pubDate: old },
    { title: 'ポケモンカード ハイクラスパックの抽選販売が決定', link: 'https://a.test/1', pubDate: recent },
  ]);

  const config = {
    ips: IPS,
    feeds: [{ id: 'testfeed', name: 'テスト', url: feedUrl, weight: 1.0, type: 'rss' }],
    googleNews: { enabled: false, queries: [] },
  };

  const orig = globalThis.fetch;
  globalThis.fetch = stubFetch({ [feedUrl]: xml });
  try {
    const items = await collectAll(config, { now, maxAgeHours: 48, concurrency: 3 });

    assert.equal(items.length, 2, '無関係記事・古い記事・重複URLが除外されること');

    const p = items.find((i) => i.ips.includes('pokemon'));
    assert.ok(p);
    assert.equal(p.url, 'https://a.test/1', 'utm_* が除去されていること');
    assert.deepEqual(p.ips.sort(), ['lottery', 'pokemon']);
    assert.equal(p.sourceName, 'テスト');
    assert.equal(p.sourceId, 'testfeed');
    assert.equal(p.sourceWeight, 1.0);
    assert.equal(p.feedUrl, feedUrl);
    assert.match(p.id, /^[0-9a-f]{16}$/);
    assert.equal(p.publishedAt, '2026-08-22T00:00:00.000Z');

    const o = items.find((i) => i.ips.includes('onepiece'));
    assert.deepEqual(o.ips, ['onepiece'], '抽選語がなければ lottery は付かない');
  } finally {
    globalThis.fetch = orig;
  }
});

test('collectAll: lotteryしか付かない記事（TCG無関係の抽選）は捨てる', async () => {
  clearResolveCache();
  const now = new Date('2026-08-23T00:00:00Z');
  const query = 'トレカ 抽選販売';
  const gUrl = buildGoogleNewsUrl(query);

  // 実URLをオフラインデコードできるIDを作る（ネットワークに出ない）
  const real = 'https://hobby.watch.impress.co.jp/docs/news/1.html';
  const bytes = Buffer.from(real, 'utf8');
  const id = Buffer.concat([
    Buffer.from([0x08, 0x13, 0x22, bytes.length]),
    bytes,
    Buffer.from([0x00, 0xd2, 0x01]),
  ]).toString('base64url');

  const xml = rssWithItems([
    {
      title: '限定グッズの抽選販売が開始 - HOBBY Watch',
      link: `https://news.google.com/rss/articles/${id}?oc=5`,
      pubDate: 'Fri, 22 Aug 2026 09:00:00 +0900',
    },
  ]);

  const config = {
    ips: IPS,
    feeds: [],
    googleNews: {
      enabled: true,
      queries: [{ id: 'gn-lottery', query, ips: ['lottery'], weight: 1.0 }],
    },
  };

  const orig = globalThis.fetch;
  globalThis.fetch = stubFetch({ [gUrl]: xml });
  try {
    const items = await collectAll(config, { now });
    // 「限定グッズの抽選販売」はTCGのIPに1つもマッチしないため対象外。
    // これを通すと、アウトドアブランドやスニーカーの抽選情報まで混入する。
    assert.equal(items.length, 0);
  } finally {
    globalThis.fetch = orig;
  }
});

test('collectAll: googleNews 由来はクエリのIPを最低保証する', async () => {
  clearResolveCache();
  const now = new Date('2026-08-23T00:00:00Z');
  const query = 'ポケモンカード 抽選';
  const gUrl = buildGoogleNewsUrl(query);

  const real = 'https://hobby.watch.impress.co.jp/docs/news/1.html';
  const bytes = Buffer.from(real, 'utf8');
  const id = Buffer.concat([
    Buffer.from([0x08, 0x13, 0x22, bytes.length]),
    bytes,
    Buffer.from([0x00, 0xd2, 0x01]),
  ]).toString('base64url');

  // タイトルにIP名が無くても、クエリに紐づく pokemon が最低保証される
  const xml = rssWithItems([
    {
      title: '30周年記念カードセットの抽選販売が開始 - HOBBY Watch',
      link: `https://news.google.com/rss/articles/${id}?oc=5`,
      pubDate: 'Fri, 22 Aug 2026 09:00:00 +0900',
    },
  ]);

  const config = {
    ips: IPS,
    feeds: [],
    googleNews: {
      enabled: true,
      queries: [{ id: 'gn-pokemon', query, ips: ['pokemon'], weight: 1.0 }],
    },
  };

  const orig = globalThis.fetch;
  globalThis.fetch = stubFetch({ [gUrl]: xml });
  try {
    const items = await collectAll(config, { now });
    assert.equal(items.length, 1);
    assert.ok(items[0].ips.includes('pokemon'), 'クエリのIPが最低保証されること');
    assert.ok(items[0].ips.includes('lottery'), '抽選タグが横断付与されること');
    assert.equal(items[0].url, real, 'Googleリダイレクトがオフライン解決されていること');
    assert.equal(items[0].sourceId, 'gn-pokemon');
  } finally {
    globalThis.fetch = orig;
  }
});

test('collectAll: 一部フィードが失敗してもスキップして続行する', async () => {
  clearResolveCache();
  const now = new Date('2026-08-23T00:00:00Z');
  const okUrl = 'https://feed.test/ok.xml';
  const ngUrl = 'https://feed.test/ng.xml';

  const config = {
    ips: IPS,
    feeds: [
      { id: 'ok', name: 'OK', url: okUrl, weight: 1.0, type: 'rss' },
      { id: 'ng', name: 'NG', url: ngUrl, weight: 1.0, type: 'rss' },
    ],
    googleNews: { enabled: false, queries: [] },
  };

  const xml = rssWithItems([
    { title: 'フュージョンワールド 予約開始', link: 'https://b.test/1', pubDate: 'Fri, 22 Aug 2026 09:00:00 +0900' },
  ]);

  const orig = globalThis.fetch;
  const origWarn = console.warn;
  const warnings = [];
  console.warn = (...a) => warnings.push(a.join(' '));
  globalThis.fetch = stubFetch({ [okUrl]: xml }); // ngUrl は 404
  try {
    const items = await collectAll(config, { now });
    assert.equal(items.length, 1);
    assert.deepEqual(items[0].ips.sort(), ['dragonball', 'lottery']);
    assert.ok(warnings.some((w) => w.includes('ng')), '失敗フィードは console.warn される');
  } finally {
    globalThis.fetch = orig;
    console.warn = origWarn;
  }
});

test('collectAll: 全フィード失敗時のみ throw する', async () => {
  clearResolveCache();
  const config = {
    ips: IPS,
    feeds: [{ id: 'ng', name: 'NG', url: 'https://feed.test/ng.xml', weight: 1.0, type: 'rss' }],
    googleNews: { enabled: false, queries: [] },
  };

  const orig = globalThis.fetch;
  const origWarn = console.warn;
  console.warn = () => {};
  globalThis.fetch = stubFetch({});
  try {
    await assert.rejects(() => collectAll(config, { now: new Date('2026-08-23T00:00:00Z') }), /全フィードの取得に失敗/);
  } finally {
    globalThis.fetch = orig;
    console.warn = origWarn;
  }
});

test('collectAll: フィード定義が空なら空配列（throw しない）', async () => {
  clearResolveCache();
  const items = await collectAll({ ips: IPS, feeds: [], googleNews: { enabled: false, queries: [] } }, {});
  assert.deepEqual(items, []);
});

/* ------------------------------------------------------------------ */
/* X読み取り（既定無効）                                               */
/* ------------------------------------------------------------------ */

test('isXReadEnabled: フラグとトークンの両方が揃った時だけ true', () => {
  assert.equal(isXReadEnabled({}), false);
  assert.equal(isXReadEnabled({ X_READ_ENABLED: 'true' }), false);
  assert.equal(isXReadEnabled({ X_BEARER_TOKEN: 'abc' }), false);
  assert.equal(isXReadEnabled({ X_READ_ENABLED: 'false', X_BEARER_TOKEN: 'abc' }), false);
  assert.equal(isXReadEnabled({ X_READ_ENABLED: 'true', X_BEARER_TOKEN: 'abc' }), true);
  assert.equal(isXReadEnabled({ X_READ_ENABLED: 'TRUE', X_BEARER_TOKEN: 'abc' }), true);
});

test('fetchXItems: 無効時は空配列を返す（ネットワークに出ない）', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('無効時にfetchしてはいけない');
  };
  try {
    assert.deepEqual(await fetchXItems(undefined, { env: {} }), []);
    assert.deepEqual(await fetchXItems({ searches: [] }, { env: { X_READ_ENABLED: 'true' } }), []);
  } finally {
    globalThis.fetch = orig;
  }
});

test('fetchXItems: 有効でも config が enabled:false ならスキップ', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('スキップされるはず');
  };
  try {
    const got = await fetchXItems(
      { enabled: false, searches: [{ id: 'x', query: 'a', ips: ['pokemon'] }] },
      { env: { X_READ_ENABLED: 'true', X_BEARER_TOKEN: 'tok' } }
    );
    assert.deepEqual(got, []);
  } finally {
    globalThis.fetch = orig;
  }
});

test('fetchXItems: 有効時は RawItem[] に変換する', async () => {
  const orig = globalThis.fetch;
  const origWarn = console.warn;
  console.warn = () => {};
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /^https:\/\/api\.x\.com\/2\/tweets\/search\/recent\?/);
    assert.equal(init.headers.authorization, 'Bearer tok');
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        data: [{ id: '1234567890', author_id: 'u1', text: 'ポケモンカードの抽選販売が開始されました', created_at: '2026-08-22T00:00:00.000Z' }],
        includes: { users: [{ id: 'u1', username: 'tcg_news', name: 'TCGニュース' }] },
      }),
    };
  };
  try {
    const got = await fetchXItems(
      { enabled: true, searches: [{ id: 'x-pokemon', query: 'ポケカ 抽選', ips: ['pokemon', 'lottery'], weight: 1.1 }] },
      { env: { X_READ_ENABLED: 'true', X_BEARER_TOKEN: 'tok' } }
    );
    assert.equal(got.length, 1);
    assert.equal(got[0].url, 'https://x.com/tcg_news/status/1234567890');
    assert.equal(got[0].sourceName, '@tcg_news');
    assert.equal(got[0].kind, 'x');
    assert.deepEqual(got[0].ips, ['pokemon', 'lottery']);
    assert.match(got[0].id, /^[0-9a-f]{16}$/);
  } finally {
    globalThis.fetch = orig;
    console.warn = origWarn;
  }
});

test('fetchXItems: API エラー時も throw せず空配列', async () => {
  const orig = globalThis.fetch;
  const origWarn = console.warn;
  const warnings = [];
  console.warn = (...a) => warnings.push(a.join(' '));
  globalThis.fetch = async () => ({ ok: false, status: 403, statusText: 'Forbidden', text: async () => 'no access' });
  try {
    const got = await fetchXItems(
      { enabled: true, searches: [{ id: 'x1', query: 'a', ips: ['pokemon'] }] },
      { env: { X_READ_ENABLED: 'true', X_BEARER_TOKEN: 'tok' } }
    );
    assert.deepEqual(got, []);
    assert.ok(warnings.some((w) => w.includes('403')));
  } finally {
    globalThis.fetch = orig;
    console.warn = origWarn;
  }
});

test('config/x-sources.json は既定で無効になっている', async () => {
  const cfg = JSON.parse(await readFile(new URL('../config/x-sources.json', import.meta.url), 'utf8'));
  assert.equal(cfg.enabled, false);
  assert.ok(Array.isArray(cfg.searches) && cfg.searches.length > 0);
  for (const s of cfg.searches) assert.ok(Array.isArray(s.ips) && s.ips.length > 0);
});

test('collectAll: 検索ノイズ（カード関連語を含まない記事）にはIP最低保証を適用しない', async () => {
  clearResolveCache();
  const now = new Date('2026-08-23T00:00:00Z');
  const query = 'ワンピースカード 抽選';
  const gUrl = buildGoogleNewsUrl(query);

  // Googleニュースが「抽選」つながりで拾ってくる無関係な記事
  const xml = rssWithItems([
    {
      title: '5/29抽選｜アークテリクス 2024年に抽選している人気モデルまとめ',
      link: 'https://snkrdunk.com/articles/15490',
      pubDate: 'Fri, 22 Aug 2026 09:00:00 +0900',
    },
  ]);

  const config = {
    ips: IPS,
    feeds: [],
    googleNews: {
      enabled: true,
      queries: [{ id: 'gn-op', query, ips: ['onepiece'], weight: 1.0 }],
    },
  };

  const orig = globalThis.fetch;
  globalThis.fetch = stubFetch({ [gUrl]: xml });
  try {
    const items = await collectAll(config, { now });
    assert.equal(items.length, 0, 'アウトドアブランドの抽選情報が混入してはいけない');
  } finally {
    globalThis.fetch = orig;
  }
});
