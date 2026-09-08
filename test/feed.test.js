/**
 * 区画D: src/feed.js のユニットテスト（ネット不要）
 *
 *   node --test test/feed.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildFeedJson,
  toFeedItem,
  detectKind,
  truncate,
  writeFeedJson,
  ensureIpCoverage,
  FEED_VERSION,
  SUMMARY_MAX,
  URGENT_KEEP_HOURS,
} from '../src/feed.js';

/** CONTRACT.md の FeedItem のキー（過不足なく一致すること） */
const FEED_ITEM_KEYS = [
  'id',
  'title',
  'url',
  'sourceName',
  'publishedAt',
  'summary',
  'ips',
  'intentTags',
  'score',
  'thumbnail',
  'isRanked',
  'rank',
  'kind',
  // 第2フェーズ: 応募導線
  'tier',
  'destUrl',
  'destLabel',
  'startsAt',
  'deadline',
  'applyVerified',
  'destIsEntry',
  'otherShops',
].sort();

/**
 * テスト用の RankedItem を作る
 * @param {Partial<any>} over
 */
function ranked(over = {}) {
  return {
    id: over.id ?? 'id-0000000000000',
    // 同じ商品名は1件に集約される仕様なので、既定のタイトルは id ごとに変える。
    // 同一商品としてまとめられる挙動を試したいテストは title を明示すること。
    title: over.title ?? `テスト記事${over.id ?? ''}`,
    url: over.url ?? 'https://example.com/a',
    sourceName: over.sourceName ?? '4Gamer',
    sourceId: over.sourceId ?? '4gamer',
    sourceWeight: 1.0,
    summary: over.summary ?? '概要',
    publishedAt: over.publishedAt ?? '2026-08-23T00:00:00.000Z',
    ips: over.ips ?? ['pokemon'],
    feedUrl: 'https://example.com/rss',
    score: over.score ?? 1,
    breakdown: { recency: 1, intent: 0, ip: 0, source: 0, cluster: 0 },
    intentTags: over.intentTags ?? [],
    clusterSize: 1,
    dupUrls: [],
    ...over,
  };
}

// ────────────────────────────────────────────────────────────
// detectKind
// ────────────────────────────────────────────────────────────

test('detectKind: sourceId が x- で始まれば x', () => {
  assert.equal(detectKind({ sourceId: 'x-list-tcg', sourceName: '@someone' }), 'x');
  // 「公式」を含んでいても x- が優先
  assert.equal(detectKind({ sourceId: 'x-official-poke', sourceName: 'ポケモン公式' }), 'x');
});

test('detectKind: sourceName に「公式」を含む / sourceId が official- で始まれば official', () => {
  assert.equal(detectKind({ sourceId: 'poke-news', sourceName: 'ポケモン公式' }), 'official');
  assert.equal(detectKind({ sourceId: 'official-onepiece', sourceName: 'ONE PIECEカードゲーム' }), 'official');
});

test('detectKind: それ以外は news', () => {
  assert.equal(detectKind({ sourceId: '4gamer', sourceName: '4Gamer' }), 'news');
  assert.equal(detectKind({}), 'news');
});

// ────────────────────────────────────────────────────────────
// truncate / toFeedItem
// ────────────────────────────────────────────────────────────

test('truncate: 200字を超えたら切り詰める', () => {
  const long = 'あ'.repeat(300);
  const out = truncate(long, SUMMARY_MAX);
  assert.equal(Array.from(out).length, SUMMARY_MAX);
  assert.ok(out.endsWith('…'));

  const short = 'みじかい';
  assert.equal(truncate(short, SUMMARY_MAX), short);
});

test('toFeedItem: CONTRACT.md の FeedItem のキーと完全一致する', () => {
  const fi = toFeedItem(ranked());
  assert.deepEqual(Object.keys(fi).sort(), FEED_ITEM_KEYS);
});

test('toFeedItem: summary は200字で切られ、thumbnail は既定 null', () => {
  const fi = toFeedItem(ranked({ summary: 'い'.repeat(500) }));
  assert.equal(Array.from(fi.summary).length, SUMMARY_MAX);
  assert.equal(fi.thumbnail, null);
});

test('toFeedItem: isRanked/rank を指定できる。未指定なら false/null', () => {
  const plain = toFeedItem(ranked());
  assert.equal(plain.isRanked, false);
  assert.equal(plain.rank, null);

  const top = toFeedItem(ranked(), { isRanked: true, rank: 2 });
  assert.equal(top.isRanked, true);
  assert.equal(top.rank, 2);
});

test('toFeedItem: publishedAt は ISO8601 に正規化される', () => {
  const fi = toFeedItem(ranked({ publishedAt: 'Sat, 23 Aug 2026 09:00:00 +0900' }));
  assert.equal(fi.publishedAt, '2026-08-23T00:00:00.000Z');
});

test('toFeedItem: 欠損フィールドがあっても落ちずに既定値で埋める', () => {
  const fi = toFeedItem({});
  assert.deepEqual(Object.keys(fi).sort(), FEED_ITEM_KEYS);
  assert.equal(fi.id, '');
  assert.deepEqual(fi.ips, []);
  assert.deepEqual(fi.intentTags, []);
  assert.equal(fi.score, 0);
  assert.equal(fi.kind, 'news');
});

// ────────────────────────────────────────────────────────────
// buildFeedJson
// ────────────────────────────────────────────────────────────

test('buildFeedJson: トップレベルのスキーマが CONTRACT.md 通り', () => {
  const now = new Date('2026-08-23T09:00:00.000Z');
  const feed = buildFeedJson({ ranked: [ranked()], top: [], tweetUrl: null, now });

  assert.deepEqual(Object.keys(feed).sort(), ['generatedAt', 'items', 'ranking', 'version']);
  assert.equal(feed.version, FEED_VERSION);
  assert.equal(feed.generatedAt, '2026-08-23T09:00:00.000Z');
  assert.deepEqual(Object.keys(feed.ranking).sort(), ['date', 'top', 'tweetUrl']);
  // JST基準の日付
  assert.equal(feed.ranking.date, '2026-08-23');
  assert.equal(feed.ranking.tweetUrl, null);
  assert.ok(Array.isArray(feed.items));
});

test('buildFeedJson: items は publishedAt 降順（最新が先頭）', () => {
  const input = [
    ranked({ id: 'old', publishedAt: '2026-08-20T00:00:00.000Z', url: 'https://example.com/old' }),
    ranked({ id: 'newest', publishedAt: '2026-08-23T00:00:00.000Z', url: 'https://example.com/newest' }),
    ranked({ id: 'mid', publishedAt: '2026-08-22T00:00:00.000Z', url: 'https://example.com/mid' }),
  ];
  const feed = buildFeedJson({ ranked: input, now: new Date('2026-08-23T09:00:00.000Z') });
  assert.deepEqual(feed.items.map((i) => i.id), ['newest', 'mid', 'old']);
});

test('buildFeedJson: items は maxItems で切られる（既定50）', () => {
  const input = Array.from({ length: 80 }, (_, i) =>
    ranked({
      id: `id-${String(i).padStart(3, '0')}`,
      url: `https://example.com/${i}`,
      // i が大きいほど古い
      publishedAt: new Date(Date.UTC(2026, 7, 23, 0, 0, 0) - i * 60_000).toISOString(),
    })
  );

  const feedDefault = buildFeedJson({ ranked: input, now: new Date('2026-08-23T09:00:00.000Z') });
  assert.equal(feedDefault.items.length, 50);
  assert.equal(feedDefault.items[0].id, 'id-000', '最新が先頭');

  const feedSmall = buildFeedJson({ ranked: input, maxItems: 5, now: new Date('2026-08-23T09:00:00.000Z') });
  assert.equal(feedSmall.items.length, 5);
});

test('buildFeedJson: TOP N のアイテムには items 側にも isRanked/rank が付く', () => {
  const a = ranked({ id: 'a', url: 'https://example.com/a', publishedAt: '2026-08-21T00:00:00.000Z' });
  const b = ranked({ id: 'b', url: 'https://example.com/b', publishedAt: '2026-08-23T00:00:00.000Z' });
  const c = ranked({ id: 'c', url: 'https://example.com/c', publishedAt: '2026-08-22T00:00:00.000Z' });

  const feed = buildFeedJson({
    ranked: [a, b, c],
    top: [c, a], // rank1 = c, rank2 = a
    now: new Date('2026-08-23T09:00:00.000Z'),
  });

  const byId = Object.fromEntries(feed.items.map((i) => [i.id, i]));
  assert.equal(byId.c.isRanked, true);
  assert.equal(byId.c.rank, 1);
  assert.equal(byId.a.isRanked, true);
  assert.equal(byId.a.rank, 2);
  assert.equal(byId.b.isRanked, false);
  assert.equal(byId.b.rank, null);
});

test('buildFeedJson: ranking.top は rank 昇順で FeedItem 形式', () => {
  const a = ranked({ id: 'a', url: 'https://example.com/a', publishedAt: '2026-08-21T00:00:00.000Z' });
  const b = ranked({ id: 'b', url: 'https://example.com/b', publishedAt: '2026-08-23T00:00:00.000Z' });
  const c = ranked({ id: 'c', url: 'https://example.com/c', publishedAt: '2026-08-22T00:00:00.000Z' });

  const feed = buildFeedJson({ ranked: [a, b, c], top: [b, c, a], now: new Date('2026-08-23T09:00:00.000Z') });

  assert.deepEqual(feed.ranking.top.map((i) => i.rank), [1, 2, 3]);
  assert.deepEqual(feed.ranking.top.map((i) => i.id), ['b', 'c', 'a']);
  for (const t of feed.ranking.top) {
    assert.deepEqual(Object.keys(t).sort(), FEED_ITEM_KEYS);
    assert.equal(t.isRanked, true);
  }
});

test('buildFeedJson: tweetUrl は未投稿なら null、投稿済みならそのURL', () => {
  const now = new Date('2026-08-23T09:00:00.000Z');
  assert.equal(buildFeedJson({ ranked: [], now }).ranking.tweetUrl, null);
  assert.equal(buildFeedJson({ ranked: [], now, tweetUrl: '' }).ranking.tweetUrl, null);
  assert.equal(
    buildFeedJson({ ranked: [], now, tweetUrl: 'https://x.com/u/status/1' }).ranking.tweetUrl,
    'https://x.com/u/status/1'
  );
});

test('buildFeedJson: 引数なし（該当ニュースなし）でも壊れないスキーマを返す', () => {
  const feed = buildFeedJson();
  assert.equal(feed.version, FEED_VERSION);
  assert.deepEqual(feed.items, []);
  assert.deepEqual(feed.ranking.top, []);
  assert.equal(feed.ranking.tweetUrl, null);
});

// ────────────────────────────────────────────────────────────
// writeFeedJson
// ────────────────────────────────────────────────────────────

test('writeFeedJson: ディレクトリを作って整形JSONで書き出す', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tcgbot-feed-'));
  const target = path.join(dir, 'public', 'feed.json');

  const feed = buildFeedJson({
    ranked: [ranked({ id: 'a', url: 'https://example.com/a' })],
    top: [ranked({ id: 'a', url: 'https://example.com/a' })],
    now: new Date('2026-08-23T09:00:00.000Z'),
  });

  const result = await writeFeedJson(feed, target);
  assert.equal(result.itemCount, 1);
  assert.ok(result.bytes > 0);

  const text = await readFile(target, 'utf8');
  assert.ok(text.includes('\n  "version": 1'), '整形（インデント2）されていること');
  const parsed = JSON.parse(text);
  assert.deepEqual(parsed, JSON.parse(JSON.stringify(feed)));
});

// --- 第2フェーズ: 応募導線フィールドの引き回し ---

test('toFeedItem: destUrl/destLabel/deadline がそのまま通る', () => {
  const fi = toFeedItem(
    ranked({
      destUrl: 'https://p-bandai.jp/item/item-1000012345/',
      destLabel: 'プレミアムバンダイ',
      startsAt: '2026-08-28T03:00:00.000Z',
      deadline: '2026-09-03T14:59:00.000Z',
      tier: 'official',
    })
  );
  assert.equal(fi.destUrl, 'https://p-bandai.jp/item/item-1000012345/');
  assert.equal(fi.destLabel, 'プレミアムバンダイ');
  assert.equal(fi.startsAt, '2026-08-28T03:00:00.000Z');
  assert.equal(fi.deadline, '2026-09-03T14:59:00.000Z');
  assert.equal(fi.tier, 'official');
});

test('toFeedItem: 応募導線フィールドが無ければ null', () => {
  const fi = toFeedItem(ranked());
  assert.equal(fi.destUrl, null);
  assert.equal(fi.destLabel, null);
  assert.equal(fi.startsAt, null);
  assert.equal(fi.deadline, null);
});

test('toFeedItem: http(s) 以外の destUrl はフィードに載せない', () => {
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'ftp://example.com', '', null, 42]) {
    const fi = toFeedItem(ranked({ destUrl: bad }));
    assert.equal(fi.destUrl, null, `${String(bad)} が通ってしまった`);
  }
});

test('toFeedItem: 壊れた日時の deadline は null になる', () => {
  const fi = toFeedItem(ranked({ deadline: 'いつか' }));
  assert.equal(fi.deadline, null);
});

// ────────────────────────────────────────────────────────────
// ジャンルの取りこぼし（利用者から「ドラゴンボールが出ない」と指摘のあった件）
//
// 収集段階では全ジャンル揃っているのに、フィード50件を組む時点で
// 受付中の抽選（数が多い）が枠を食い尽くし、少数ジャンルが丸ごと消えていた。
// ここで守るのは3つ。優先度の高い順に:
//   1. 24時間以内が締切の受付中案件は必ず残る（アプリの存在意義）
//   2. ジャンルが丸ごと消えない
//   3. 1つの情報源が枠の40%を超えて占領しない
// ────────────────────────────────────────────────────────────

/** CONTRACT.md の対象IP（lottery は横断タグなので除く） */
const IP_KEYS = [
  'pokemon', 'onepiece', 'dragonball', 'gundam', 'hololive', 'yugioh',
  'duelmasters', 'mtg', 'newtcg', 'digimon', 'battlespirits', 'aikatsu',
  'carddass', 'vanguard', 'weiss', 'unionarena',
];

const NOW = new Date('2026-09-06T11:24:00.000Z');

/**
 * 2026-09-06 の実測（収集396件）に近い偏りのデータを作る。
 * ポケカ・新作が大量にあり、少数ジャンルは1〜10件しかない状態。
 */
function skewedCollection(now = NOW) {
  const counts = {
    pokemon: 120, newtcg: 76, mtg: 32, weiss: 24, hololive: 23, onepiece: 18,
    battlespirits: 16, digimon: 12, gundam: 11, yugioh: 10, duelmasters: 10,
    dragonball: 10, vanguard: 10, aikatsu: 9, unionarena: 7, carddass: 1,
  };
  const sources = ['抽選まとめ', 'カードラボ', 'ファミマ', '4Gamer', 'ミントモール', '電ホビ'];
  const out = [];
  let n = 0;
  for (const [ip, count] of Object.entries(counts)) {
    for (let i = 0; i < count; i++) {
      n++;
      // 多いジャンルほど特定の情報源に偏る（現実と同じ形）
      const src = ip === 'pokemon' ? sources[0] : ip === 'newtcg' ? sources[1] : sources[n % sources.length];
      const isLottery = ip === 'pokemon' || ip === 'newtcg' || n % 2 === 0;
      const hasDeadline = isLottery && i % 3 === 0;
      const hours = 2 + (i % 40) * 6;
      out.push(ranked({
        id: `${ip}-${i}`,
        url: `https://example.com/${ip}/${i}`,
        sourceName: src,
        sourceId: src,
        publishedAt: new Date(now.getTime() - n * 60_000).toISOString(),
        ips: isLottery ? ['lottery', ip] : [ip],
        intentTags: isLottery ? ['抽選'] : [],
        tier: 'shop',
        destUrl: hasDeadline ? `https://shop.example.com/${ip}/${i}` : null,
        deadline: hasDeadline ? new Date(now.getTime() + hours * 3600_000).toISOString() : null,
      }));
    }
  }
  return out.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}

test('buildFeedJson: 収集にあるジャンルが50件の中から丸ごと消えない', () => {
  const feed = buildFeedJson({ ranked: skewedCollection(), now: NOW, maxItems: 50 });
  assert.equal(feed.items.length, 50);

  const present = new Set();
  for (const it of feed.items) for (const ip of it.ips) present.add(ip);
  const missing = IP_KEYS.filter((k) => !present.has(k));
  assert.deepEqual(missing, [], `フィードから消えたジャンル: ${missing.join(', ')}`);
});

test('buildFeedJson: 24時間以内が締切の受付中案件は1件も落とさない', () => {
  const all = skewedCollection();
  const feed = buildFeedJson({ ranked: all, now: NOW, maxItems: 50 });
  const kept = new Set(feed.items.map((i) => i.id));

  const urgent = all.filter((it) => {
    const dl = Date.parse(it.deadline);
    return it.destUrl && Number.isFinite(dl)
      && dl > NOW.getTime() && dl <= NOW.getTime() + URGENT_KEEP_HOURS * 3600_000;
  });
  assert.ok(urgent.length > 0, 'テストデータに今日締切が無い');
  const lost = urgent.filter((it) => !kept.has(it.id)).map((it) => it.id);
  assert.deepEqual(lost, [], `今日締切が落ちた: ${lost.join(', ')}`);
});

test('buildFeedJson: 1つの情報源が枠の40%を超えて占領しない', () => {
  const feed = buildFeedJson({ ranked: skewedCollection(), now: NOW, maxItems: 50 });
  const bySource = new Map();
  for (const it of feed.items) bySource.set(it.sourceName, (bySource.get(it.sourceName) || 0) + 1);
  for (const [name, n] of bySource) {
    assert.ok(n <= 20, `${name} が ${n}件で40%(20件)を超えた`);
  }
});

test('ensureIpCoverage: そのジャンルが1つの情報源にしか無くても、情報源の上限で消さない', () => {
  const now = NOW.getTime();
  const many = Array.from({ length: 60 }, (_, i) => ranked({
    id: `big-${i}`,
    sourceName: 'まとめサイト',
    ips: ['lottery', 'pokemon'],
    publishedAt: new Date(now - i * 60_000).toISOString(),
  }));
  // ドラゴンボールは同じ情報源に1件だけ（上限に達したあとに出てくる）
  const rare = ranked({
    id: 'db-1',
    sourceName: 'まとめサイト',
    ips: ['dragonball'],
    publishedAt: new Date(now - 999 * 60_000).toISOString(),
  });
  const out = ensureIpCoverage([...many, rare], [], {
    maxItems: 20, minPerIp: 4, perSourceCap: 8, now,
  });
  assert.ok(out.some((i) => i.id === 'db-1'), '唯一のドラゴンボール記事が落ちた');
});

test('ensureIpCoverage: 今日締切が枠より多いときは、締切をジャンル確保より優先する', () => {
  const now = NOW.getTime();
  const urgent = Array.from({ length: 12 }, (_, i) => ranked({
    id: `u-${i}`,
    sourceName: `店${i}`,
    ips: ['lottery', 'pokemon'],
    destUrl: `https://shop.example.com/${i}`,
    deadline: new Date(now + (i + 1) * 3600_000).toISOString(),
    publishedAt: new Date(now - i * 60_000).toISOString(),
  }));
  const others = Array.from({ length: 30 }, (_, i) => ranked({
    id: `o-${i}`,
    sourceName: 'ニュース',
    ips: [IP_KEYS[i % IP_KEYS.length]],
    publishedAt: new Date(now - (100 + i) * 60_000).toISOString(),
  }));
  const out = ensureIpCoverage([...urgent, ...others], [], {
    maxItems: 10, minPerIp: 4, mustKeep: urgent, now,
  });
  assert.equal(out.length, 10);
  // 締切が近い10件がそのまま残る
  assert.deepEqual(
    out.map((i) => i.id).sort(),
    urgent.slice(0, 10).map((i) => i.id).sort(),
  );
});

test('ensureIpCoverage: minPerIp:0 でも従来どおり新しい順で埋まる', () => {
  const now = NOW.getTime();
  const list = Array.from({ length: 30 }, (_, i) => ranked({
    id: `n-${i}`,
    publishedAt: new Date(now - i * 60_000).toISOString(),
  }));
  const out = ensureIpCoverage(list, [], { maxItems: 5, minPerIp: 0, now });
  assert.deepEqual(out.map((i) => i.id), ['n-0', 'n-1', 'n-2', 'n-3', 'n-4']);
});
