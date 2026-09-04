import { test } from 'node:test';
import assert from 'node:assert';
import { readFile } from 'node:fs/promises';

import { scoreItem, rankItems, selectTop, DEFAULT_SCORING } from '../src/score.js';

// ---------------------------------------------------------------------------
// RawItem テスト用ファクトリ（区画Aに依存しない自前実装）
// ---------------------------------------------------------------------------
let seq = 0;
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

const NOW = new Date('2026-08-23T12:00:00.000Z');
/** n時間前のISO文字列 */
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600000).toISOString();

const FILE_CFG = JSON.parse(
  await readFile(new URL('../config/scoring.json', import.meta.url), 'utf8'),
);

// ---------------------------------------------------------------------------
// config/scoring.json
// ---------------------------------------------------------------------------
test('config/scoring.json: 必要なキーが揃っている', () => {
  for (const k of Object.keys(DEFAULT_SCORING.weights)) {
    assert.ok(Number.isFinite(FILE_CFG.weights[k]), `weights.${k} がない`);
  }
  const total = Object.values(FILE_CFG.weights).reduce((a, b) => a + b, 0);
  assert.strictEqual(total, 100, '重みの合計は100');
  assert.ok(Number.isFinite(FILE_CFG.recency.halfLifeHours));
  assert.ok(Number.isFinite(FILE_CFG.recency.maxAgeHours));
  assert.ok(Number.isFinite(FILE_CFG.clusterThreshold));
  assert.ok(Number.isFinite(FILE_CFG.selection.maxPerIp));
  for (const [key, entry] of Object.entries(FILE_CFG.intentKeywords)) {
    assert.ok(Number.isFinite(entry.score), `${key}.score`);
    assert.ok(typeof entry.tag === 'string' && entry.tag.length > 0, `${key}.tag`);
    assert.ok(Array.isArray(entry.patterns) && entry.patterns.length > 0, `${key}.patterns`);
  }
});

// ---------------------------------------------------------------------------
// scoreItem
// ---------------------------------------------------------------------------
test('scoreItem: 新しい記事のほうが高スコア', () => {
  const fresh = makeItem({ title: 'ポケカ新弾の情報', publishedAt: hoursAgo(1) });
  const old = makeItem({ title: 'ポケカ新弾の情報', publishedAt: hoursAgo(36) });
  const a = scoreItem(fresh, FILE_CFG, NOW, 1);
  const b = scoreItem(old, FILE_CFG, NOW, 1);
  assert.ok(a.score > b.score, `${a.score} > ${b.score}`);
  assert.ok(a.breakdown.recency > b.breakdown.recency);
});

test('scoreItem: 半減期どおりに recency が減衰する', () => {
  const item = makeItem({ title: 'ニュース', publishedAt: hoursAgo(12) }); // halfLife = 12h
  const { breakdown } = scoreItem(item, FILE_CFG, NOW, 1);
  assert.ok(Math.abs(breakdown.recency - FILE_CFG.weights.recency * 0.5) < 0.01);
});

test('scoreItem: maxAgeHours を超えたら recency は 0', () => {
  // 設定値を直接参照する。config/scoring.json の maxAgeHours を変えても壊れない
  const limit = FILE_CFG.recency.maxAgeHours;
  const item = makeItem({ title: 'ニュース', publishedAt: hoursAgo(limit + 1) });
  const { breakdown } = scoreItem(item, FILE_CFG, NOW, 1);
  assert.strictEqual(breakdown.recency, 0);
});

test('scoreItem: 期間内なら古くても recency は 0 より大きい', () => {
  const limit = FILE_CFG.recency.maxAgeHours;
  const item = makeItem({ title: 'ニュース', publishedAt: hoursAgo(limit - 1) });
  const { breakdown } = scoreItem(item, FILE_CFG, NOW, 1);
  assert.ok(breakdown.recency >= 0);
  const fresh = scoreItem(makeItem({ title: 'ニュース', publishedAt: hoursAgo(1) }), FILE_CFG, NOW, 1);
  assert.ok(fresh.breakdown.recency > breakdown.recency, '新しい記事の方が高いこと');
});

test('scoreItem: 「抽選」入りは無しより高スコアで intentTags に記録される', () => {
  const withKw = makeItem({
    title: 'ポケモンカード「熱風のアリーナ」抽選販売の受付開始',
    publishedAt: hoursAgo(2),
  });
  const without = makeItem({ title: 'ポケモンカードの話題まとめ記事ではない普通の記事', publishedAt: hoursAgo(2) });
  const a = scoreItem(withKw, FILE_CFG, NOW, 1);
  const b = scoreItem(without, FILE_CFG, NOW, 1);
  assert.ok(a.score > b.score, `${a.score} > ${b.score}`);
  assert.ok(a.intentTags.includes('抽選'));
  assert.deepStrictEqual(b.intentTags, []);
  assert.strictEqual(b.breakdown.intent, 0);
});

test('scoreItem: intentTags はスコア降順・重複なし', () => {
  const item = makeItem({
    title: 'ポケカ新弾の抽選販売が決定',
    summary: '大会情報もあわせて公開。抽選予約の受付開始。',
    publishedAt: hoursAgo(1),
  });
  const { intentTags } = scoreItem(item, FILE_CFG, NOW, 1);
  assert.strictEqual(intentTags[0], '抽選'); // 10点が最上位
  assert.strictEqual(new Set(intentTags).size, intentTags.length);
  assert.ok(intentTags.includes('新弾'));
  assert.ok(intentTags.includes('大会'));
});

test('scoreItem: intent は複数マッチしても頭打ちになる', () => {
  const item = makeItem({
    title: '抽選販売 予約開始 再販 新弾 発売日 受注 当選発表 収録カード コラボ 買取 世界大会',
    publishedAt: hoursAgo(0),
  });
  const { breakdown } = scoreItem(item, FILE_CFG, NOW, 1);
  assert.ok(breakdown.intent <= FILE_CFG.weights.intent + 1e-9);
});

test('scoreItem: negativeKeyword でスコアが下がる', () => {
  const base = { title: 'ポケカ新弾の抽選販売が決定', publishedAt: hoursAgo(1) };
  const clean = scoreItem(makeItem(base), FILE_CFG, NOW, 1);
  const dirty = scoreItem(
    makeItem({ ...base, summary: '詐欺に注意' }),
    FILE_CFG,
    NOW,
    1,
  );
  assert.ok(dirty.score < clean.score, `${dirty.score} < ${clean.score}`);
  assert.strictEqual(dirty.breakdown.negative, -FILE_CFG.negativeKeywords.penalty);
  assert.strictEqual(clean.breakdown.negative, 0);
});

test('scoreItem: スコアは0未満にならない', () => {
  const item = makeItem({
    title: 'まとめ 詐欺 アフィリエイト',
    publishedAt: hoursAgo(47),
    sourceWeight: 0.5,
  });
  const { score, breakdown } = scoreItem(item, FILE_CFG, NOW, 1);
  assert.ok(score >= 0);
  assert.ok(breakdown.negative <= 0);
});

test('scoreItem: breakdown の合計が score と一致する', () => {
  const item = makeItem({
    title: 'ポケカ新弾「熱風のアリーナ」抽選販売が決定',
    publishedAt: hoursAgo(3),
    sourceWeight: 1.4,
  });
  const { score, breakdown } = scoreItem(item, FILE_CFG, NOW, 3);
  const sum = Object.values(breakdown).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - score) < 1e-9, `${sum} != ${score}`);
});

test('scoreItem: sourceWeight / clusterSize が効く', () => {
  const base = { title: 'ポケカ新弾情報', publishedAt: hoursAgo(1) };
  const low = scoreItem(makeItem({ ...base, sourceWeight: 0.5 }), FILE_CFG, NOW, 1);
  const high = scoreItem(makeItem({ ...base, sourceWeight: 1.5 }), FILE_CFG, NOW, 1);
  assert.strictEqual(low.breakdown.source, 0);
  assert.strictEqual(high.breakdown.source, FILE_CFG.weights.source);

  const solo = scoreItem(makeItem(base), FILE_CFG, NOW, 1);
  const multi = scoreItem(makeItem(base), FILE_CFG, NOW, 4);
  assert.strictEqual(solo.breakdown.cluster, 0);
  assert.ok(multi.breakdown.cluster > 0);
  // clusterBonusMax 頭打ち
  const huge = scoreItem(makeItem(base), FILE_CFG, NOW, 50);
  assert.strictEqual(huge.breakdown.cluster, FILE_CFG.weights.cluster);
});

test('scoreItem: IP重みが渡されなければ 1.0 として扱う', () => {
  const item = makeItem({ title: 'ニュース', publishedAt: hoursAgo(1), ips: ['pokemon'] });
  const plain = scoreItem(item, FILE_CFG, NOW, 1);
  const weighted = scoreItem(
    item,
    { ...FILE_CFG, ips: { pokemon: { weight: 1.3 } } },
    NOW,
    1,
  );
  assert.ok(weighted.breakdown.ip > plain.breakdown.ip);
  assert.strictEqual(weighted.breakdown.ip, FILE_CFG.weights.ip);
});

test('scoreItem: 設定なしでも既定値で動く', () => {
  const { score } = scoreItem(makeItem({ publishedAt: hoursAgo(1) }), undefined, NOW, 1);
  assert.ok(Number.isFinite(score) && score > 0);
});

// ---------------------------------------------------------------------------
// rankItems
// ---------------------------------------------------------------------------
test('rankItems: 同一クラスタは代表1件に集約され clusterSize / dupUrls が付く', () => {
  const a = makeItem({
    title: 'ポケモンカード新弾「熱風のアリーナ」抽選販売決定 - 4Gamer.net',
    url: 'https://4gamer.net/a',
    sourceWeight: 1.2,
    publishedAt: hoursAgo(2),
  });
  const b = makeItem({
    title: '【ポケカ】ポケモンカード新弾「熱風のアリーナ」抽選販売が決定｜ファミ通.com',
    url: 'https://famitsu.com/b',
    sourceWeight: 0.9,
    publishedAt: hoursAgo(3),
  });
  const c = makeItem({
    title: '遊戯王OCG 世界大会2026の開催日程が発表',
    url: 'https://denfami.com/c',
    ips: ['yugioh'],
    publishedAt: hoursAgo(5),
  });

  const ranked = rankItems([a, b, c], FILE_CFG, NOW);
  assert.strictEqual(ranked.length, 2);

  const rep = ranked.find((r) => r.clusterSize === 2);
  assert.ok(rep, '2件クラスタが見つからない');
  assert.strictEqual(rep.url, a.url, 'sourceWeight最大が代表');
  assert.deepStrictEqual(rep.dupUrls, [b.url]);
  // RawItem のプロパティも保持
  assert.strictEqual(rep.sourceName, a.sourceName);
  assert.deepStrictEqual(rep.ips, a.ips);
});

test('rankItems: score降順にソートされる', () => {
  const items = [
    makeItem({ title: '遊戯王 大会結果', publishedAt: hoursAgo(40), ips: ['yugioh'] }),
    makeItem({ title: 'ポケカ新弾の抽選販売が決定', publishedAt: hoursAgo(1) }),
    makeItem({ title: 'MTG 収録カード公開', publishedAt: hoursAgo(20), ips: ['mtg'] }),
  ];
  const ranked = rankItems(items, FILE_CFG, NOW);
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(ranked[i - 1].score >= ranked[i].score);
  }
  assert.strictEqual(ranked[0].title, 'ポケカ新弾の抽選販売が決定');
});

test('rankItems: 空入力は空配列', () => {
  assert.deepStrictEqual(rankItems([], FILE_CFG, NOW), []);
  assert.deepStrictEqual(rankItems(undefined, FILE_CFG, NOW), []);
});

// ---------------------------------------------------------------------------
// selectTop
// ---------------------------------------------------------------------------
test('selectTop: maxPerIp が効いて同一IPが3件並ばない', () => {
  const items = [
    makeItem({
      title: 'ポケモンカード「熱風のアリーナ」抽選販売の受付を開始',
      publishedAt: hoursAgo(1),
      ips: ['pokemon', 'lottery'],
    }),
    makeItem({
      title: 'ポケモンセンター限定プロモカードの配布が決定',
      publishedAt: hoursAgo(2),
      ips: ['pokemon'],
    }),
    makeItem({
      title: '拡張パック「夜天の翼」の収録内容が公開',
      publishedAt: hoursAgo(3),
      ips: ['pokemon'],
    }),
    makeItem({
      title: 'ONE PIECEカードゲーム 新弾の予約が開始',
      publishedAt: hoursAgo(30),
      ips: ['onepiece'],
    }),
  ];
  const ranked = rankItems(items, FILE_CFG, NOW);
  assert.strictEqual(ranked.length, 4, '別ネタとして4件残ること');

  const top = selectTop(ranked, 3, { maxPerIp: 2 });
  assert.strictEqual(top.length, 3);
  const pokemonCount = top.filter((i) => i.ips.includes('pokemon')).length;
  assert.strictEqual(pokemonCount, 2);
  assert.ok(top.some((i) => i.ips.includes('onepiece')));
});

test('selectTop: 主IPは lottery を除いた最初のIPで判定する', () => {
  const items = [
    makeItem({ id: 'p1', ips: ['lottery', 'pokemon'] }),
    makeItem({ id: 'p2', ips: ['lottery', 'pokemon'] }),
    makeItem({ id: 'p3', ips: ['lottery', 'pokemon'] }),
    makeItem({ id: 'y1', ips: ['lottery', 'yugioh'] }),
  ];
  const top = selectTop(items, 3, { maxPerIp: 2 });
  assert.deepStrictEqual(top.map((i) => i.id), ['p1', 'p2', 'y1']);
});

test('selectTop: 候補が尽きたら制約を無視して埋める', () => {
  const items = [
    makeItem({ id: 'a', ips: ['pokemon'] }),
    makeItem({ id: 'b', ips: ['pokemon'] }),
    makeItem({ id: 'c', ips: ['pokemon'] }),
  ];
  const top = selectTop(items, 3, { maxPerIp: 2 });
  assert.strictEqual(top.length, 3);
  assert.deepStrictEqual(top.map((i) => i.id), ['a', 'b', 'c']);
});

test('selectTop: 全体がn未満ならある分だけ返す', () => {
  const items = [makeItem({ id: 'a' }), makeItem({ id: 'b', ips: ['mtg'] })];
  assert.strictEqual(selectTop(items, 5).length, 2);
  assert.deepStrictEqual(selectTop([], 3), []);
  assert.deepStrictEqual(selectTop(undefined, 3), []);
});

test('selectTop: 既定は n=3 / maxPerIp=2', () => {
  const items = [
    makeItem({ id: 'a', ips: ['pokemon'] }),
    makeItem({ id: 'b', ips: ['pokemon'] }),
    makeItem({ id: 'c', ips: ['yugioh'] }),
    makeItem({ id: 'd', ips: ['mtg'] }),
  ];
  const top = selectTop(items);
  assert.deepStrictEqual(top.map((i) => i.id), ['a', 'b', 'c']);
});

test('selectTop: 重複を返さない', () => {
  const items = [
    makeItem({ id: 'a', ips: ['pokemon'] }),
    makeItem({ id: 'b', ips: ['pokemon'] }),
    makeItem({ id: 'c', ips: ['pokemon'] }),
    makeItem({ id: 'd', ips: ['pokemon'] }),
  ];
  const top = selectTop(items, 4, { maxPerIp: 2 });
  assert.strictEqual(new Set(top.map((i) => i.id)).size, 4);
});
