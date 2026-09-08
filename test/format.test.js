// test/format.test.js
// Node標準テストランナー / ネットワークアクセスなし
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  weightedLength,
  truncateToWeight,
  buildThread,
  buildSingle,
  normalizeHashtags,
  ipLabel,
  formatDateJst,
  formatDateTimeJst,
  isApplyOpen,
  isApplyUpcoming,
  cleanTitle,
  kindMarker,
  urgencyLine,
  followLine,
  headerHashtags,
  IP_LABELS,
  MAX_TWEET_WEIGHT,
  URL_WEIGHT,
} from '../src/format.js';

// ---------------------------------------------------------------------------
// RankedItem テスト用ファクトリ（他区画に依存しない）
// ---------------------------------------------------------------------------

let seq = 0;
/** @returns {object} RankedItem 相当 */
function makeItem(overrides = {}) {
  seq += 1;
  return {
    // 受付中だと確認済みのものを既定にする（未確認の挙動は個別テストで検証）
    applyVerified: true,
    id: `id${String(seq).padStart(16, '0')}`.slice(0, 16),
    title: `テストタイトル${seq}`,
    url: `https://example.com/article/${seq}`,
    sourceName: '4Gamer',
    sourceId: 'fourgamer',
    sourceWeight: 1.0,
    summary: '',
    publishedAt: '2026-08-23T03:30:00.000Z', // JST 12:30
    ips: ['pokemon'],
    feedUrl: 'https://example.com/rss',
    score: 10,
    breakdown: { recency: 1, intent: 1, ip: 1, source: 1, cluster: 1 },
    intentTags: [],
    clusterSize: 1,
    dupUrls: [],
    ...overrides,
  };
}

const DATE = new Date('2026-08-23T00:00:00.000Z'); // JST 8/23 09:00

// ---------------------------------------------------------------------------
// weightedLength
// ---------------------------------------------------------------------------

test('weightedLength: 英数記号は1文字=1', () => {
  assert.equal(weightedLength('abc'), 3);
  assert.equal(weightedLength('Hello, world!'), 13);
  assert.equal(weightedLength(''), 0);
  assert.equal(weightedLength('a'.repeat(280)), 280);
});

test('weightedLength: 日本語は1文字=2', () => {
  assert.equal(weightedLength('あいう'), 6);
  assert.equal(weightedLength('ポケモンカード'), 14);
  // 全角記号「」も重み2（0x300C は 0x10FF 超、軽量範囲外）
  assert.equal(weightedLength('「」'), 4);
});

test('weightedLength: 軽量範囲の境界', () => {
  assert.equal(weightedLength(String.fromCodePoint(0x10ff)), 1); // 範囲内
  assert.equal(weightedLength(String.fromCodePoint(0x1100)), 2); // 範囲外
  assert.equal(weightedLength('‐'), 1); // 0x2010–0x201F
  assert.equal(weightedLength('′'), 1); // 0x2032–0x2037
  assert.equal(weightedLength('…'), 2); // … は軽量範囲外＝2
});

test('weightedLength: サロゲートペアは1コードポイント（絵文字=2）', () => {
  assert.equal('🥇'.length, 2); // UTF-16 では2要素
  assert.equal(weightedLength('🥇'), 2); // だが重みは2（=1コードポイント×2）
  assert.equal(weightedLength('🥇🥈🥉'), 6);
});

test('weightedLength: URLは実長に関係なく一律23', () => {
  assert.equal(weightedLength('https://a.co'), URL_WEIGHT);
  assert.equal(weightedLength(`https://example.com/${'x'.repeat(500)}`), URL_WEIGHT);
  assert.equal(weightedLength('http://example.com/a?b=1&c=2'), URL_WEIGHT);
  // 複数URL + 日本語の混在
  assert.equal(
    weightedLength('あ https://example.com/a https://example.com/b'),
    2 + 1 + URL_WEIGHT + 1 + URL_WEIGHT,
  );
});

// ---------------------------------------------------------------------------
// truncateToWeight
// ---------------------------------------------------------------------------

test('truncateToWeight: 上限以内ならそのまま返す', () => {
  assert.equal(truncateToWeight('あいう', 10), 'あいう');
  assert.equal(truncateToWeight('あいう', 6), 'あいう');
});

test('truncateToWeight: 必ず上限以内に収まる', () => {
  const src = '日本語のとても長いタイトル'.repeat(20);
  for (const cap of [4, 5, 10, 21, 50, 137]) {
    const out = truncateToWeight(src, cap);
    assert.ok(weightedLength(out) <= cap, `cap=${cap} weight=${weightedLength(out)}`);
  }
});

test('truncateToWeight: URLの途中では切らない', () => {
  const url = 'https://example.com/very/long/article/path';
  const text = `あいうえおかきくけこ ${url}`;
  const out = truncateToWeight(text, 30);
  assert.ok(weightedLength(out) <= 30);
  // URL は「まるごと含まれる」か「まったく含まれない」かのどちらか
  const partial = out.includes('https://') && !out.includes(url);
  assert.equal(partial, false, `URLが途中で切られた: ${out}`);
});

test('truncateToWeight: 省略記号が入らないほど小さい上限では空文字', () => {
  assert.equal(truncateToWeight('あいう', 1), '');
  assert.equal(truncateToWeight('あいう', 0), '');
  assert.equal(truncateToWeight('あいう', -5), '');
});

// ---------------------------------------------------------------------------
// 補助関数
// ---------------------------------------------------------------------------

test('ipLabel: lottery は主IPから除外される', () => {
  assert.equal(ipLabel(makeItem({ ips: ['lottery', 'pokemon'] })), 'ポケカ');
  assert.equal(ipLabel(makeItem({ ips: ['lottery'] })), '抽選');
  assert.equal(ipLabel(makeItem({ ips: [] })), '');
  assert.equal(ipLabel(makeItem({ ips: ['unknown_ip'] })), '');
});

test('normalizeHashtags: #付与・重複除去・最大4個', () => {
  assert.deepEqual(
    normalizeHashtags(['ポケカ', '#ポケカ', '#ワンピカード', '遊戯王', '#MTG', '#デュエマ']),
    ['#ポケカ', '#ワンピカード', '#遊戯王', '#MTG'],
  );
  assert.deepEqual(normalizeHashtags([]), []);
  assert.deepEqual(normalizeHashtags(null), []);
  assert.deepEqual(normalizeHashtags(['', '  ', '#']), []);
});

test('日付は Asia/Tokyo で整形される', () => {
  // 2026-08-22T23:10:00Z = JST 2026-08-23 08:10（日付をまたぐ）
  assert.equal(formatDateJst('2026-08-22T23:10:00.000Z'), '8/23');
  assert.equal(formatDateTimeJst('2026-08-22T23:10:00.000Z'), '8/23 08:10');
  assert.equal(formatDateTimeJst('2026-08-23T03:30:00.000Z'), '8/23 12:30');
  assert.equal(formatDateTimeJst('not-a-date'), '');
  assert.equal(formatDateTimeJst(''), '');
});

// ---------------------------------------------------------------------------
// buildThread
// ---------------------------------------------------------------------------

/** 全ツイートが 280weight 以内であることを検証 */
function assertAllWithinLimit(tweets) {
  tweets.forEach((t, i) => {
    assert.equal(typeof t.text, 'string');
    const w = weightedLength(t.text);
    assert.ok(
      w <= MAX_TWEET_WEIGHT,
      `tweet[${i}] が ${w} weight で上限超過:\n${t.text}`,
    );
    assert.ok(t.text.trim().length > 0, `tweet[${i}] が空`);
  });
}

test('buildThread: 見出し + 各順位で N+1 本になる', () => {
  const top = [
    makeItem({ title: '「テラスタルフェスex」抽選販売が受付開始', ips: ['pokemon', 'lottery'], intentTags: ['抽選', '予約'], clusterSize: 3 }),
    makeItem({ title: '新弾『ROMANCE DAWN』収録カード公開', ips: ['onepiece'] }),
    makeItem({ title: '25th ANNIVERSARY 再販決定', ips: ['yugioh'], clusterSize: 2 }),
  ];
  const tweets = buildThread(top, { date: DATE, hashtags: ['#ポケカ', '#ワンピカード', '#遊戯王'] });

  assert.equal(tweets.length, 4);
  assertAllWithinLimit(tweets);

  const head = tweets[0].text;
  assert.match(head, /^【8\/23 TCG注目ニュース TOP3】/);
  assert.ok(head.includes('🥇') && head.includes('🥈') && head.includes('🥉'));
  assert.ok(head.includes('くわしくはリプ欄に👇'));
  assert.ok(head.includes('#ポケカ'));
  // 1本目にリンクは載せない
  assert.equal(/https?:\/\//.test(head), false, '見出しにURLが含まれている');

  // 2本目以降は必ず該当記事のURLで終わる
  top.forEach((item, i) => {
    assert.ok(tweets[i + 1].text.endsWith(item.url), `tweet[${i + 1}] の末尾がURLでない`);
  });
});

test('buildThread: メタ行（日時/媒体/タグ/クラスタ）が入る', () => {
  const tweets = buildThread(
    [makeItem({ sourceName: 'HOBBY Watch', intentTags: ['抽選', '予約', '再販', '無視される4つ目'], clusterSize: 3 })],
    { date: DATE },
  );
  const detail = tweets[1].text;
  assert.ok(detail.includes('📅 8/23 12:30 ／ HOBBY Watch'), detail);
  assert.ok(detail.includes('🏷 抽選 予約 再販'), detail);
  assert.equal(detail.includes('無視される4つ目'), false, 'intentTags が3個を超えている');
  assert.ok(detail.includes('📰 他2媒体が報道'), detail);
});

test('buildThread: clusterSize が1なら報道行は出ない', () => {
  const tweets = buildThread([makeItem({ clusterSize: 1 })], { date: DATE });
  assert.equal(tweets[1].text.includes('📰'), false);
});

test('buildThread: 1件/2件/3件/5件のどれでも壊れない', () => {
  for (const n of [1, 2, 3, 4, 5]) {
    const top = Array.from({ length: n }, (_, i) =>
      makeItem({
        title: `${i + 1}件目のニュースタイトル`,
        ips: [['pokemon', 'onepiece', 'yugioh', 'gundam', 'mtg'][i]],
        intentTags: i % 2 === 0 ? ['抽選'] : [],
        clusterSize: i + 1,
      }),
    );
    const tweets = buildThread(top, { date: DATE, hashtags: ['#ポケカ', '#TCG'] });
    assert.equal(tweets.length, n + 1, `n=${n}`);
    assertAllWithinLimit(tweets);
    assert.ok(tweets[0].text.includes(`TOP${n}】`), `n=${n} の見出しが不正`);
  }
});

test('buildThread: 極端に長いタイトル/要約/URLでも全ツイートが280weight以内', () => {
  const monster = () =>
    makeItem({
      title: 'ポケモンカードゲーム完全新規拡張パック抽選販売受付開始のお知らせ'.repeat(12),
      summary: 'これは非常に長い要約テキストです。'.repeat(40),
      sourceName: 'とてもとても長い媒体名のニュースサイト編集部'.repeat(3),
      url: `https://example.com/${'segment/'.repeat(60)}article`,
      intentTags: ['抽選予約受付開始のお知らせ'.repeat(5), '再販', '予約'],
      ips: ['pokemon', 'lottery'],
      clusterSize: 9,
    });

  for (const n of [1, 3, 5]) {
    const top = Array.from({ length: n }, monster);
    const tweets = buildThread(top, {
      date: DATE,
      hashtags: ['#とても長いハッシュタグその1', '#とても長いハッシュタグその2', '#3', '#4'],
    });
    assertAllWithinLimit(tweets);
    // 長くてもURLは必ず残る
    for (let i = 1; i <= n; i += 1) {
      assert.ok(tweets[i].text.includes('https://example.com/'), `tweet[${i}] からURLが消えた`);
    }
  }
});

test('buildThread: summary が無い/タイトルと同一でも壊れない', () => {
  const t1 = buildThread([makeItem({ summary: undefined })], { date: DATE });
  assertAllWithinLimit(t1);
  const item = makeItem();
  const t2 = buildThread([makeItem({ summary: item.title, title: item.title })], { date: DATE });
  assertAllWithinLimit(t2);
});

test('buildThread: 空配列なら空配列', () => {
  assert.deepEqual(buildThread([], { date: DATE }), []);
  assert.deepEqual(buildThread(null, { date: DATE }), []);
});

test('buildThread: オプション省略でも動く', () => {
  const tweets = buildThread([makeItem()]);
  assert.equal(tweets.length, 2);
  assertAllWithinLimit(tweets);
});

test('buildThread: IPラベルがタイトル先頭に付与され、二重表記にならない', () => {
  const a = buildThread([makeItem({ title: '「新弾」発売', ips: ['pokemon'] })], { date: DATE });
  assert.ok(a[0].text.includes('🥇 ポケカ「新弾」発売'), a[0].text);
  // タイトルが既にラベルで始まる場合は重複させない
  const b = buildThread([makeItem({ title: '遊戯王 25th 再販', ips: ['yugioh'] })], { date: DATE });
  assert.ok(b[0].text.includes('🥇 遊戯王 25th 再販'), b[0].text);
  assert.equal(b[0].text.includes('遊戯王 遊戯王'), false);
});

// ---------------------------------------------------------------------------
// buildSingle
// ---------------------------------------------------------------------------

test('buildSingle: 文字列を返し280weight以内', () => {
  const top = [
    makeItem({ title: '「テラスタルフェスex」抽選販売が受付開始', ips: ['pokemon', 'lottery'] }),
    makeItem({ title: '新弾『ROMANCE DAWN』収録カード公開', ips: ['onepiece'] }),
    makeItem({ title: '25th ANNIVERSARY 再販決定', ips: ['yugioh'] }),
  ];
  const text = buildSingle(top, { date: DATE, hashtags: ['#ポケカ', '#ワンピカード'] });
  assert.equal(typeof text, 'string');
  assert.ok(weightedLength(text) <= MAX_TWEET_WEIGHT, `weight=${weightedLength(text)}`);
  assert.match(text, /^【8\/23 TCG注目ニュース TOP3】/);
  assert.ok(text.includes(top[0].url), '1位のリンクが無い');
  // 2位・3位のリンクは載せない
  assert.equal(text.includes(top[1].url), false);
  assert.equal(text.includes(top[2].url), false);
});

test('buildSingle: 件数・長さがどうであれ280weight以内', () => {
  for (const n of [1, 2, 3, 4, 5]) {
    for (const long of [false, true]) {
      const top = Array.from({ length: n }, (_, i) =>
        makeItem({
          title: long ? 'ものすごく長いタイトルの記事です'.repeat(15) : `記事${i + 1}`,
          ips: ['pokemon'],
        }),
      );
      const text = buildSingle(top, {
        date: DATE,
        hashtags: ['#ポケカ', '#ワンピカード', '#遊戯王', '#デュエマ'],
      });
      assert.ok(
        weightedLength(text) <= MAX_TWEET_WEIGHT,
        `n=${n} long=${long} weight=${weightedLength(text)}\n${text}`,
      );
    }
  }
});

test('buildSingle: 空配列なら空文字', () => {
  assert.equal(buildSingle([], { date: DATE }), '');
  assert.equal(buildSingle(undefined), '');
});

// ---------------------------------------------------------------------------
// 第2フェーズ: 応募導線（destUrl / destLabel / deadline）
// すべて任意フィールド。無ければ従来と完全に同じ出力になること。
// ---------------------------------------------------------------------------

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
/** DATE(JST 8/23 09:00) からの相対 ISO8601 */
const rel = (ms) => new Date(DATE.getTime() + ms).toISOString();

test('destUrl があるとき、記事URLではなく応募URLが載る', () => {
  const item = makeItem({
    title: '「30th CELEBRATION」抽選販売',
    url: 'https://news.example.com/article/x',
    destUrl: 'https://p-bandai.jp/item/item-1000012345/',
    destLabel: 'プレミアムバンダイ',
    deadline: rel(5 * DAY),
    tier: 'official',
  });
  const tweets = buildThread([item], { date: DATE });
  assertAllWithinLimit(tweets);

  const detail = tweets[1].text;
  assert.ok(detail.includes(item.destUrl), '応募URLが載っていない');
  assert.equal(detail.includes(item.url), false, '記事URLも載ってしまっている（重み23が二重）');
  assert.ok(detail.endsWith(item.destUrl), '末尾が応募URLでない');
});

test('destUrl があるとき 🛒 店名の行が入る', () => {
  const tweets = buildThread(
    [makeItem({ destUrl: 'https://p-bandai.jp/item/1/', destLabel: 'プレミアムバンダイ' })],
    { date: DATE },
  );
  assert.ok(tweets[1].text.includes('🛒 プレミアムバンダイ'), tweets[1].text);
});

test('deadline があるとき ⏰ 行が入る', () => {
  const tweets = buildThread([makeItem({ deadline: '2026-08-28T03:00:00.000Z' })], { date: DATE });
  assert.ok(tweets[1].text.includes('⏰ 8/28 12:00まで'), tweets[1].text);
});

test('締切切れの deadline は載せない（防御的）', () => {
  const tweets = buildThread([makeItem({ deadline: rel(-DAY) })], { date: DATE });
  assert.equal(tweets[1].text.includes('⏰'), false, '期限切れの締切が載っている');
});

test('見出しツイート: 応募できるものがあれば直接応募できる旨を入れる', () => {
  const applicable = buildThread(
    [makeItem({ destUrl: 'https://p-bandai.jp/item/1/', deadline: rel(2 * DAY) })],
    { date: DATE },
  );
  assert.ok(applicable[0].text.includes('※リプ欄から直接応募できます👇'), applicable[0].text);
  assertAllWithinLimit(applicable);

  // 締切切れなら従来の文言のまま
  const expired = buildThread(
    [makeItem({ destUrl: 'https://p-bandai.jp/item/1/', deadline: rel(-DAY) })],
    { date: DATE },
  );
  assert.ok(expired[0].text.includes('くわしくはリプ欄に👇'), expired[0].text);
});

test('後方互換: destUrl/deadline が null なら従来と完全に同じ出力', () => {
  const base = () => ({
    title: '「テラスタルフェスex」抽選販売が受付開始',
    ips: ['pokemon', 'lottery'],
    intentTags: ['抽選', '予約'],
    clusterSize: 3,
    summary: '受付は8月末まで。',
  });
  for (const extra of [
    {},
    { destUrl: null, destLabel: null, deadline: null, startsAt: null, tier: null },
    { destUrl: undefined, destLabel: undefined, deadline: undefined },
    { destUrl: '', destLabel: '', deadline: '' },
  ]) {
    seq = 0;
    const plain = buildThread([makeItem(base())], { date: DATE, hashtags: ['#ポケカ'] });
    seq = 0;
    const withNulls = buildThread([makeItem({ ...base(), ...extra })], { date: DATE, hashtags: ['#ポケカ'] });
    assert.deepEqual(withNulls, plain, `extra=${JSON.stringify(extra)} で出力が変わった`);
    seq = 0;
    const s1 = buildSingle([makeItem(base())], { date: DATE });
    seq = 0;
    const s2 = buildSingle([makeItem({ ...base(), ...extra })], { date: DATE });
    assert.equal(s2, s1, `buildSingle が変わった extra=${JSON.stringify(extra)}`);
  }
});

test('後方互換: 不正な destUrl（javascript: 等）は無視して記事URLを載せる', () => {
  const item = makeItem({ destUrl: 'javascript:alert(1)', destLabel: 'わな' });
  const detail = buildThread([item], { date: DATE })[1].text;
  assert.equal(detail.includes('javascript:'), false);
  assert.ok(detail.endsWith(item.url));
  assert.equal(detail.includes('🛒'), false);
});

test('応募URL+締切+店名を足しても280weight以内（長大な入力との組み合わせ）', () => {
  const monster = () =>
    makeItem({
      title: 'ポケモンカードゲーム完全新規拡張パック抽選販売受付開始のお知らせ'.repeat(12),
      summary: 'これは非常に長い要約テキストです。'.repeat(40),
      sourceName: 'とてもとても長い媒体名のニュースサイト編集部'.repeat(3),
      url: `https://news.example.com/${'segment/'.repeat(60)}article`,
      destUrl: `https://p-bandai.jp/${'item/'.repeat(60)}item-1000012345/`,
      destLabel: 'とてもとても長い店名のオンラインショップ株式会社'.repeat(5),
      deadline: rel(3 * DAY),
      startsAt: rel(HOUR),
      intentTags: ['抽選予約受付開始のお知らせ'.repeat(5), '再販', '予約'],
      ips: ['pokemon', 'lottery'],
      clusterSize: 9,
    });

  for (const n of [1, 3, 5]) {
    const top = Array.from({ length: n }, monster);
    const tweets = buildThread(top, {
      date: DATE,
      hashtags: ['#とても長いハッシュタグその1', '#とても長いハッシュタグその2', '#3', '#4'],
    });
    assertAllWithinLimit(tweets);
    for (let i = 1; i <= n; i += 1) {
      assert.ok(tweets[i].text.includes('https://p-bandai.jp/'), `tweet[${i}] から応募URLが消えた`);
      // 受付開始が未来なら「⏳ 受付開始」、開始済みなら「⏰ 締切」。
      // どちらか一方は必ず残る（文字数を削る際も優先して残す対象）。
      assert.ok(
        tweets[i].text.includes('⏰') || tweets[i].text.includes('⏳'),
        `tweet[${i}] から受付期間の表示が消えた`
      );
    }
    assert.ok(weightedLength(buildSingle(top, { date: DATE })) <= MAX_TWEET_WEIGHT);
  }
});

test('buildSingle: 1位に応募ページがあればそちらを載せる', () => {
  const top = [
    makeItem({ title: 'ポケカ抽選', destUrl: 'https://p-bandai.jp/item/1/', deadline: rel(2 * DAY) }),
    makeItem({ title: '別のニュース' }),
  ];
  const text = buildSingle(top, { date: DATE });
  assert.ok(weightedLength(text) <= MAX_TWEET_WEIGHT);
  assert.ok(text.includes('▼1位の応募ページ'), text);
  assert.ok(text.includes('https://p-bandai.jp/item/1/'));
  assert.equal(text.includes(top[0].url), false, '記事URLも載っている');
});

test('isApplyOpen: destUrl あり かつ 締切切れでない', () => {
  assert.equal(isApplyOpen(makeItem(), DATE), false);
  assert.equal(isApplyOpen(makeItem({ destUrl: 'https://p-bandai.jp/x' }), DATE), true);
  assert.equal(
    isApplyOpen(makeItem({ destUrl: 'https://p-bandai.jp/x', deadline: rel(-1) }), DATE),
    false,
  );
  assert.equal(
    isApplyOpen(makeItem({ destUrl: 'https://p-bandai.jp/x', deadline: rel(HOUR) }), DATE),
    true,
  );
});

// --- 受付開始前のものを「応募できる」と扱わない ---

test('isApplyOpen: 受付開始が未来なら false（開始前はまだ応募できない）', () => {
  const now = new Date('2026-09-02T12:00:00+09:00');
  const item = {
    destUrl: 'https://books.rakuten.co.jp/rb/1',
    startsAt: '2026-09-14T01:00:00.000Z', // JST 9/14 10:00 開始
    deadline: '2026-09-18T00:59:00.000Z',
  };
  assert.equal(isApplyOpen(item, now), false, '開始前を応募可にしてはいけない');
  assert.equal(isApplyUpcoming(item, now), true);
});

test('isApplyOpen: 受付開始済みで締切前なら true', () => {
  const now = new Date('2026-09-15T12:00:00+09:00');
  const item = {
    applyVerified: true,
    destUrl: 'https://books.rakuten.co.jp/rb/1',
    startsAt: '2026-09-14T01:00:00.000Z',
    deadline: '2026-09-18T00:59:00.000Z',
  };
  assert.equal(isApplyOpen(item, now), true);
  assert.equal(isApplyUpcoming(item, now), false);
});

test('isApplyOpen: startsAt が無ければ従来どおり締切だけで判定する', () => {
  const now = new Date('2026-09-02T12:00:00+09:00');
  assert.equal(isApplyOpen({ applyVerified: true, destUrl: 'https://x.example.com/a' }, now), true);
  assert.equal(
    isApplyOpen(
      { applyVerified: true, destUrl: 'https://x.example.com/a', deadline: '2026-08-01T00:00:00.000Z' },
      now
    ),
    false
  );
  // 未確認のものは、締切が無くても「応募できる」とは扱わない
  assert.equal(isApplyOpen({ destUrl: 'https://x.example.com/a' }, now), false);
});

test('buildThread: 受付開始前は締切ではなく「受付開始」を出す', () => {
  const now = new Date('2026-09-02T12:00:00+09:00');
  const top = [
    {
      title: 'ONE PIECEカードゲーム ブースターパック 世界最強の戦士',
      url: 'https://books.rakuten.co.jp/rb/1',
      destUrl: 'https://books.rakuten.co.jp/rb/1',
      destLabel: '楽天ブックス',
      startsAt: '2026-09-14T01:00:00.000Z',
      deadline: '2026-09-18T00:59:00.000Z',
      ips: ['onepiece'],
      sourceName: '楽天ブックス',
      publishedAt: '2026-09-01T00:00:00.000Z',
      intentTags: ['抽選'],
      clusterSize: 1,
    },
  ];
  const tweets = buildThread(top, { date: now });
  const detail = tweets[1].text;
  assert.ok(detail.includes('⏳'), '受付開始の表示が必要');
  assert.ok(detail.includes('受付開始'), '「受付開始」の文言が必要');
  assert.ok(!detail.includes('⏰'), '開始前に締切だけを出すと今応募できると誤解される');
});

// ---------------------------------------------------------------------------
// 第3フェーズ: 読まれる文面にする
//   - 商品名の前後に付く店側の定型ラベルを落とす
//   - 抽選/予約の区別を [抽選] のマークで残す
//   - 見出しに「いちばん近い締切」を出す
//   - ハッシュタグはIPタグ優先で最大3個
// ---------------------------------------------------------------------------

test('cleanTitle: 先頭の店の定型ラベルを落とす', () => {
  assert.equal(
    cleanTitle('【抽選商品】ポケモンカードゲーム MEGA 拡張パック 30th CELEBRATION'),
    'ポケモンカードゲーム MEGA 拡張パック 30th CELEBRATION',
  );
  assert.equal(
    cleanTitle('※9月12日まで受付※【予約】[新品ボックス]DIVINE CROSS ブースターパック'),
    'DIVINE CROSS ブースターパック',
  );
  assert.equal(
    cleanTitle('【予約商品】 2026年11月14日発売 ホロビート HB-BP01 拡張パック第一弾'),
    'ホロビート HB-BP01 拡張パック第一弾',
  );
});

test('cleanTitle: 末尾の管理番号・購入制限を落とす', () => {
  assert.equal(
    cleanTitle('ONE PIECEカードゲーム ブースターパック 決戦の刻【OP-16】 [再販/2610]'),
    'ONE PIECEカードゲーム ブースターパック 決戦の刻【OP-16】',
  );
  assert.equal(
    cleanTitle('ホロビート HB-BP01 拡張パック第一弾 1BOX（お1人様 4 BOXまで）'),
    'ホロビート HB-BP01 拡張パック第一弾 1BOX',
  );
});

test('cleanTitle: 意味のある見出しは削らない', () => {
  // ホワイトリストに無い語（速報・限定版のような中身のある語）は残す
  assert.equal(cleanTitle('【速報】ポケカ新弾情報'), '【速報】ポケカ新弾情報');
  assert.equal(cleanTitle('「テラスタルフェスex」抽選販売が受付開始'), '「テラスタルフェスex」抽選販売が受付開始');
  assert.equal(cleanTitle('遊戯王 25th 再販'), '遊戯王 25th 再販');
  // 全部が定型ラベルなら、消しすぎずに元のまま返す
  assert.equal(cleanTitle('【予約】'), '【予約】');
  assert.equal(cleanTitle(''), '');
  assert.equal(cleanTitle(null), '');
});

test('kindMarker: 抽選/予約/再販を判定し、本文に既にあるなら付けない', () => {
  assert.equal(kindMarker({ intentTags: ['抽選', '新弾'], title: '【抽選商品】ポケカ新弾' }, 'ポケカ新弾'), '抽選');
  assert.equal(kindMarker({ intentTags: ['予約'], title: '【予約】ワンピ新弾' }, 'ワンピ新弾'), '予約');
  // 整形後のタイトルに既に「再販」があるので二重表記にしない
  assert.equal(kindMarker({ intentTags: [], title: '遊戯王 25th 再販' }, '遊戯王 25th 再販'), '');
  assert.equal(kindMarker({ intentTags: [], title: 'ただの新商品情報' }, 'ただの新商品情報'), '');
  assert.equal(kindMarker({}, ''), '');
});

test('見出し: 抽選と予約が一目で区別できる', () => {
  const tweets = buildThread(
    [
      makeItem({ title: '【抽選商品】ポケモンカードゲーム MEGA 拡張パック', ips: ['pokemon'], intentTags: ['抽選'] }),
      makeItem({ title: '【予約】ONE PIECEカードゲーム 決戦の刻', ips: ['onepiece'], intentTags: ['予約'] }),
    ],
    { date: DATE },
  );
  const head = tweets[0].text;
  // IPラベルと重複するシリーズ名（ポケモンカードゲーム / ONE PIECEカードゲーム）は見出しから落ちる
  assert.ok(head.includes('🥇 [抽選] ポケカ MEGA 拡張パック'), head);
  assert.ok(head.includes('🥈 [予約] ワンピカード 決戦の刻'), head);
  // 店の定型ラベルは残らない
  assert.equal(head.includes('【抽選商品】'), false, head);
  assertAllWithinLimit(tweets);

  // 詳細ツイート（2本目以降）には正式名称が残る＝情報は捨てていない
  assert.ok(tweets[1].text.includes('ポケモンカードゲーム MEGA 拡張パック'), tweets[1].text);
  assert.ok(tweets[2].text.includes('ONE PIECEカードゲーム 決戦の刻'), tweets[2].text);
});

test('見出し: シリーズ名の一部を誤って切らない', () => {
  // 「ヴァイスシュヴァルツロゼ」は別シリーズ。「ヴァイスシュヴァルツ」を切ってはいけない
  const rose = buildThread(
    [makeItem({ title: 'ヴァイスシュヴァルツロゼ ブースターパック ぱれっと', ips: ['weiss'] })],
    { date: DATE },
  );
  assert.ok(rose[0].text.includes('ヴァイスシュヴァルツロゼ ブースターパック ぱれっと'), rose[0].text);

  // 落とすと何の商品か分からなくなる場合（残りが短すぎる）も落とさない
  const short = buildThread([makeItem({ title: 'ポケモンカードゲーム 再販', ips: ['pokemon'] })], { date: DATE });
  assert.ok(short[0].text.includes('ポケモンカードゲーム 再販'), short[0].text);
});

test('urgencyLine: 24時間以内は残り時間、7日以内は日時、それ以外は出さない', () => {
  const now = DATE.getTime();
  const open = (deadline) => ({ applyVerified: true, destUrl: 'https://p-bandai.jp/item/1/', deadline });

  assert.match(urgencyLine([open(rel(3 * HOUR))], now), /^⏰ 最短の締切まで約3時間（8\/23 12:00）$/);
  assert.match(urgencyLine([open(rel(30 * 60 * 1000))], now), /1時間以内/);
  assert.equal(urgencyLine([open(rel(2 * DAY))], now), '⏰ 最短の締切 8/25 09:00');
  // 8日先はまだ緊急ではない。見出しの場所を使わない
  assert.equal(urgencyLine([open(rel(8 * DAY))], now), '');
  // 締切が分からないものしか無ければ出さない（憶測で書かない）
  assert.equal(urgencyLine([makeItem()], now), '');
  assert.equal(urgencyLine([], now), '');
});

test('urgencyLine: 複数あるとき、いちばん近い締切を選ぶ', () => {
  const now = DATE.getTime();
  const open = (deadline) => ({ applyVerified: true, destUrl: 'https://p-bandai.jp/item/1/', deadline });
  const line = urgencyLine([open(rel(5 * DAY)), open(rel(2 * HOUR)), open(rel(3 * DAY))], now);
  assert.match(line, /約2時間/);
});

test('urgencyLine: 締切切れ・受付開始前は「いま応募できるもの」に数えない', () => {
  const now = DATE.getTime();
  // 締切切れ
  assert.equal(
    urgencyLine([{ applyVerified: true, destUrl: 'https://p-bandai.jp/item/1/', deadline: rel(-HOUR) }], now),
    '',
  );
  // 受付開始前は締切ではなく開始日時を知らせる
  const upcoming = urgencyLine(
    [{ applyVerified: true, destUrl: 'https://p-bandai.jp/item/1/', startsAt: rel(2 * DAY), deadline: rel(5 * DAY) }],
    now,
  );
  assert.equal(upcoming, '⏳ 受付開始 8/25 09:00');
});

test('見出し: 最短の締切が入り、280weight以内に収まる', () => {
  const top = [
    makeItem({
      title: '【抽選商品】ポケモンカードゲーム MEGA 拡張パック 30th CELEBRATION',
      ips: ['pokemon'],
      intentTags: ['抽選'],
      destUrl: 'https://famima-online.family.co.jp/item?itemCode=100162480879693930',
      destLabel: 'ファミマオンライン',
      deadline: rel(5 * HOUR),
    }),
    makeItem({ title: '【予約】ONE PIECEカードゲーム 決戦の刻', ips: ['onepiece'], intentTags: ['予約'] }),
    makeItem({ title: 'ホロビート HB-BP01 拡張パック第一弾', ips: ['newtcg'] }),
  ];
  const tweets = buildThread(top, { date: DATE, hashtags: ['#抽選販売'] });
  assertAllWithinLimit(tweets);
  assert.ok(tweets[0].text.includes('⏰ 最短の締切まで約5時間'), tweets[0].text);
  assert.equal(/https?:\/\//.test(tweets[0].text), false, '見出しにURLを入れてはいけない（重み23・課金13倍）');
});

test('見出し: 締切が分かるものが無い日は緊急行を出さない', () => {
  const tweets = buildThread([makeItem(), makeItem()], { date: DATE });
  assert.equal(tweets[0].text.includes('⏰'), false, tweets[0].text);
  assert.equal(tweets[0].text.includes('⏳'), false, tweets[0].text);
});

test('headerHashtags: IPタグを優先し、合計3個まで', () => {
  const items = [makeItem({ ips: ['pokemon'] }), makeItem({ ips: ['onepiece'] }), makeItem({ ips: ['yugioh'] })];
  // IPタグは2個まで。残り1枠に呼び出し側のタグが入る
  assert.deepEqual(headerHashtags(items, ['#抽選販売']), ['#ポケカ', '#ワンピカード', '#抽選販売']);
  // 重複は除かれる
  assert.deepEqual(headerHashtags(items, ['#ポケカ', '#抽選販売']), ['#ポケカ', '#ワンピカード', '#抽選販売']);
  // 4個以上にはならない
  assert.equal(headerHashtags(items, ['#a', '#b', '#c', '#d']).length, 3);
  assert.deepEqual(headerHashtags([], []), []);
});

test('followLine: 同じ日付なら常に同じ・日付が変われば入れ替わる', () => {
  assert.equal(followLine(DATE), followLine(new Date(DATE)));
  const seen = new Set();
  for (let i = 0; i < 8; i += 1) seen.add(followLine(new Date(DATE.getTime() + i * DAY)));
  assert.ok(seen.size >= 2, '毎日まったく同じ文面だとXの重複判定に触れる');
  assert.equal(typeof followLine(undefined), 'string');
});

test('詳細: 締切不明でも受付確認済みなら、締切が分からないことを隠さない', () => {
  const verified = buildThread(
    [makeItem({ destUrl: 'https://pao-onlineshop.com/view/item/1', destLabel: '通販のPAO', applyVerified: true })],
    { date: DATE },
  );
  assert.ok(verified[1].text.includes('✅ 受付中（締切は店ページで確認）'), verified[1].text);

  // 受付を確認できていないものに「受付中」とは書かない（誤情報は情報が無いことより有害）
  const unverified = buildThread(
    [makeItem({ destUrl: 'https://pao-onlineshop.com/view/item/1', destLabel: '通販のPAO', applyVerified: false })],
    { date: DATE },
  );
  assert.equal(unverified[1].text.includes('✅'), false, unverified[1].text);
});

test('詳細: 🛒 と同じ店名を 📅 にも書かない', () => {
  const tweets = buildThread(
    [
      makeItem({
        sourceName: 'ファミマオンライン ホビー（抽選商品）',
        destUrl: 'https://famima-online.family.co.jp/item?itemCode=1',
        destLabel: 'ファミマオンライン',
        deadline: rel(2 * DAY),
      }),
    ],
    { date: DATE },
  );
  const detail = tweets[1].text;
  assert.ok(detail.includes('📅 8/23 12:30'), detail);
  assert.equal(detail.includes('📅 8/23 12:30 ／ ファミマオンライン'), false, detail);
  assert.ok(detail.includes('🛒 ファミマオンライン'), detail);
});

test('IP_LABELS: 対象17IPすべてにラベルがある', () => {
  const keys = [
    'pokemon', 'onepiece', 'dragonball', 'gundam', 'hololive', 'yugioh', 'duelmasters',
    'mtg', 'newtcg', 'digimon', 'battlespirits', 'aikatsu', 'carddass', 'vanguard',
    'weiss', 'unionarena', 'lottery',
  ];
  for (const k of keys) assert.ok(IP_LABELS[k], `${k} のラベルが無い`);
  assert.equal(ipLabel({ ips: ['unionarena'] }), 'ユニオンアリーナ');
});

test('buildSingle: 締切が分かるなら1ツイート版にも入れ、280weight以内', () => {
  const top = [
    makeItem({
      title: '【抽選商品】ポケモンカードゲーム MEGA 拡張パック',
      ips: ['pokemon'],
      intentTags: ['抽選'],
      destUrl: 'https://famima-online.family.co.jp/item?itemCode=1',
      deadline: rel(4 * HOUR),
    }),
    makeItem({ title: '【予約】ONE PIECEカードゲーム 決戦の刻', ips: ['onepiece'] }),
  ];
  const text = buildSingle(top, { date: DATE, hashtags: ['#抽選販売'] });
  assert.ok(weightedLength(text) <= MAX_TWEET_WEIGHT, `weight=${weightedLength(text)}`);
  assert.ok(text.includes('⏰ 最短の締切まで約4時間'), text);
  assert.ok(text.includes('#ポケカ'), text);
});

test('誇張表現を文面に混ぜない（抽選情報は信頼が生命線）', () => {
  const banned = ['絶対', '確実に当た', '今すぐ', '激アツ', '爆買い', '神'];
  const top = [
    makeItem({
      title: '【抽選商品】ポケモンカードゲーム MEGA 拡張パック',
      intentTags: ['抽選'],
      destUrl: 'https://famima-online.family.co.jp/item?itemCode=1',
      destLabel: 'ファミマオンライン',
      deadline: rel(2 * HOUR),
    }),
    makeItem({ title: '【予約】ONE PIECEカードゲーム 決戦の刻', ips: ['onepiece'], intentTags: ['予約'] }),
  ];
  const texts = [
    ...buildThread(top, { date: DATE, hashtags: ['#抽選販売'] }).map((t) => t.text),
    buildSingle(top, { date: DATE, hashtags: ['#抽選販売'] }),
  ];
  for (const text of texts) {
    for (const word of banned) {
      assert.equal(text.includes(word), false, `煽り表現「${word}」が入っている:\n${text}`);
    }
  }
});
