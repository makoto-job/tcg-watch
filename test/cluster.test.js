import { test } from 'node:test';
import assert from 'node:assert';

import {
  normalizeTitle,
  bigrams,
  similarity,
  clusterItems,
  DEFAULT_CLUSTER_THRESHOLD,
} from '../src/cluster.js';

// ---------------------------------------------------------------------------
// RawItem テスト用ファクトリ（区画Aに依存しない自前実装）
// ---------------------------------------------------------------------------
let seq = 0;
/**
 * @param {Partial<import('../src/cluster.js').RawItem>} o
 */
function makeItem(o = {}) {
  seq += 1;
  return {
    id: o.id ?? `test${String(seq).padStart(4, '0')}`,
    title: o.title ?? `テスト記事${seq}`,
    url: o.url ?? `https://example.com/news/${seq}`,
    sourceName: o.sourceName ?? '4Gamer',
    sourceId: o.sourceId ?? '4gamer',
    sourceWeight: o.sourceWeight ?? 1.0,
    summary: o.summary ?? '',
    publishedAt: o.publishedAt ?? '2026-08-23T00:00:00.000Z',
    ips: o.ips ?? ['pokemon'],
    feedUrl: o.feedUrl ?? 'https://example.com/rss',
  };
}

// ---------------------------------------------------------------------------
// normalizeTitle
// ---------------------------------------------------------------------------
test('normalizeTitle: 全角英数はNFKCで半角小文字化される', () => {
  assert.strictEqual(normalizeTitle('ＰＯＫＥＭＯＮ　ＴＣＧ'), 'pokemon tcg');
  assert.strictEqual(normalizeTitle('ｶｰﾄﾞ'), 'カド'); // 半角カナ→全角、長音符は記号として除去
});

test('normalizeTitle: メディア名サフィックスが落ちる', () => {
  assert.strictEqual(
    normalizeTitle('ポケモンカード新弾「熱風のアリーナ」抽選販売決定 - 4Gamer.net'),
    'ポケモンカド新弾熱風のアリナ抽選販売決定',
  );
  assert.strictEqual(
    normalizeTitle('ポケモンカード新弾「熱風のアリーナ」抽選販売決定｜ファミ通.com'),
    'ポケモンカド新弾熱風のアリナ抽選販売決定',
  );
  // 区切り以降が20文字を超える場合はサフィックスとみなさない
  const long = 'ポケモンカード新弾 - 抽選販売の受付が本日から全国の店舗で一斉にスタートします';
  assert.ok(normalizeTitle(long).includes('全国の店舗'));
});

test('normalizeTitle: 記号・約物・連続空白が除去される', () => {
  assert.strictEqual(
    normalizeTitle('【速報】ポケカ、抽選販売が決定！　…詳細は？'),
    '速報ポケカ抽選販売が決定 詳細は',
  );
  assert.strictEqual(normalizeTitle('  a   b  '), 'a b');
  assert.strictEqual(normalizeTitle(''), '');
  assert.strictEqual(normalizeTitle(null), '');
});

test('normalizeTitle: 冪等（2回かけても同じ）', () => {
  const t = '【ポケカ】新弾「ＸＹ」抽選販売が決定｜ファミ通.com';
  const once = normalizeTitle(t);
  assert.strictEqual(normalizeTitle(once), once);
});

// ---------------------------------------------------------------------------
// bigrams / similarity
// ---------------------------------------------------------------------------
test('bigrams: 文字bigramのSetを返す', () => {
  assert.deepStrictEqual([...bigrams('abcd')], ['ab', 'bc', 'cd']);
  assert.strictEqual(bigrams('').size, 0);
  assert.deepStrictEqual([...bigrams('a')], ['a']);
});

test('similarity: 同一文字列は1', () => {
  assert.strictEqual(similarity('ポケモンカード新弾抽選販売', 'ポケモンカード新弾抽選販売'), 1);
});

test('similarity: 空文字は0', () => {
  assert.strictEqual(similarity('', 'ポケモンカード'), 0);
  assert.strictEqual(similarity('ポケモンカード', ''), 0);
});

test('similarity: 無関係なタイトルは低い', () => {
  const s = similarity(
    'ポケモンカード新弾「熱風のアリーナ」抽選販売決定 - 4Gamer.net',
    '遊戯王OCG 世界大会2026の日程が発表｜ファミ通.com',
  );
  assert.ok(s < 0.2, `無関係なのに類似度が高い: ${s}`);
});

test('similarity: 表記ゆれのある同一ニュースは閾値を超える', () => {
  const s = similarity(
    'ポケモンカード新弾「熱風のアリーナ」抽選販売決定 - 4Gamer.net',
    '【ポケカ】ポケモンカード新弾「熱風のアリーナ」抽選販売が決定｜ファミ通.com',
  );
  assert.ok(
    s >= DEFAULT_CLUSTER_THRESHOLD,
    `同一ニュースなのに閾値未満: ${s} < ${DEFAULT_CLUSTER_THRESHOLD}`,
  );
  assert.ok(s <= 1);
});

// ---------------------------------------------------------------------------
// clusterItems
// ---------------------------------------------------------------------------
test('clusterItems: 同一ネタの別メディア記事が1クラスタにまとまる', () => {
  const a = makeItem({
    title: 'ポケモンカード新弾「熱風のアリーナ」抽選販売決定 - 4Gamer.net',
    url: 'https://4gamer.net/a',
    sourceName: '4Gamer',
    publishedAt: '2026-08-23T01:00:00.000Z',
  });
  const b = makeItem({
    title: '【ポケカ】ポケモンカード新弾「熱風のアリーナ」抽選販売が決定｜ファミ通.com',
    url: 'https://famitsu.com/b',
    sourceName: 'ファミ通',
    publishedAt: '2026-08-23T00:30:00.000Z',
  });
  const c = makeItem({
    title: '遊戯王OCG 世界大会2026の開催日程が発表 - 電ファミ',
    url: 'https://denfami.com/c',
    ips: ['yugioh'],
    publishedAt: '2026-08-23T02:00:00.000Z',
  });

  const clusters = clusterItems([a, b, c]);
  assert.strictEqual(clusters.length, 2);
  assert.strictEqual(clusters[0].length, 2);
  assert.strictEqual(clusters[1].length, 1);
  assert.strictEqual(clusters[1][0].id, c.id);
  // クラスタ内は publishedAt 昇順（最初に報じた順）
  assert.deepStrictEqual(
    clusters[0].map((i) => i.id),
    [b.id, a.id],
  );
});

test('clusterItems: 同一URLはタイトルが違っても同一クラスタ', () => {
  const a = makeItem({
    title: 'まったく関係のない見出しＡ',
    url: 'https://example.com/same',
    publishedAt: '2026-08-23T03:00:00.000Z',
  });
  const b = makeItem({
    title: '共通点ゼロの別見出しＢ 遊戯王世界大会',
    url: 'https://example.com/same/', // 末尾スラッシュ差は吸収
    publishedAt: '2026-08-23T01:00:00.000Z',
  });
  const clusters = clusterItems([a, b]);
  assert.strictEqual(clusters.length, 1);
  assert.strictEqual(clusters[0].length, 2);
  assert.strictEqual(clusters[0][0].id, b.id); // 昇順
});

test('clusterItems: 空配列/不正入力でも落ちない', () => {
  assert.deepStrictEqual(clusterItems([]), []);
  assert.deepStrictEqual(clusterItems(undefined), []);
  const c = clusterItems([makeItem({ title: '' }), makeItem({ title: '' })]);
  // タイトル空同士はURLが違えば別クラスタ（誤結合しない）
  assert.strictEqual(c.length, 2);
});

test('clusterItems: threshold を上げると分離する', () => {
  const a = makeItem({
    title: 'ポケモンカード新弾「熱風のアリーナ」抽選販売決定 - 4Gamer.net',
    url: 'https://4gamer.net/x',
  });
  const b = makeItem({
    title: '【ポケカ】ポケモンカード新弾「熱風のアリーナ」抽選販売が決定｜ファミ通.com',
    url: 'https://famitsu.com/y',
  });
  assert.strictEqual(clusterItems([a, b], { threshold: 0.99 }).length, 2);
  assert.strictEqual(clusterItems([a, b], { threshold: 0.55 }).length, 1);
});

test('clusterItems: 全件が別ネタなら件数分のクラスタになる', () => {
  const items = [
    makeItem({ title: 'ワンピースカードゲーム 新弾の予約が開始', url: 'https://a.example/1', ips: ['onepiece'] }),
    makeItem({ title: 'ドラゴンボールSCG フュージョンワールド 収録カード公開', url: 'https://a.example/2', ips: ['dragonball'] }),
    makeItem({ title: 'MTG 新セットの発売日が決定', url: 'https://a.example/3', ips: ['mtg'] }),
  ];
  assert.strictEqual(clusterItems(items).length, 3);
});
