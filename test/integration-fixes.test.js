/**
 * 統合時に見つかった表示品質・スコアリングの問題に対する回帰テスト。
 * ネットワークアクセスなしで動作する。
 */
import { test } from 'node:test';
import assert from 'node:assert';

import { decodeDisplayText, decodeEntities } from '../src/rss.js';
import { stripSourceSuffix, isRedundantSummary } from '../src/collect.js';
import { domainPenalty, scoreItem } from '../src/score.js';

// --- 二重エンコードされたエンティティの復号 ---

test('decodeDisplayText: Googleニュースの二重エンコード &amp;nbsp; を空白にする', () => {
  assert.equal(decodeDisplayText('新弾情報&amp;nbsp;&amp;nbsp;GameWith'), '新弾情報  GameWith');
});

test('decodeDisplayText: 1パスで足りる通常のエンティティも従来どおり復号する', () => {
  assert.equal(decodeDisplayText('ポケカ &amp; 遊戯王'), 'ポケカ & 遊戯王');
  assert.equal(decodeDisplayText('&quot;抽選&quot;'), '"抽選"');
});

test('decodeDisplayText: 2パス目で <script> を復元しない（インジェクション防止）', () => {
  const out = decodeDisplayText('&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;');
  assert.ok(!out.includes('<script>'), `< > が復元されている: ${out}`);
  assert.ok(out.includes('&lt;script&gt;'), `1パス分は復号されるべき: ${out}`);
});

test('decodeDisplayText: 数値参照の &amp;#60; も < に化けない', () => {
  const out = decodeDisplayText('&amp;#60;img&amp;#62;');
  assert.ok(!out.includes('<img>'), out);
});

test('decodeEntities: 既存の1パス動作は変えていない', () => {
  assert.equal(decodeEntities('&amp;nbsp;'), '&nbsp;');
});

// --- 媒体名サフィックスの除去 ---

test('stripSourceSuffix: 末尾が媒体名と一致すれば剥がす', () => {
  assert.equal(
    stripSourceSuffix('新パック「ロケット団の野望」の収録カード一覧 - GameWith', 'GameWith'),
    '新パック「ロケット団の野望」の収録カード一覧'
  );
  assert.equal(
    stripSourceSuffix('ポケカ30周年記念商品の抽選販売が決定｜ファミ通.com', 'ファミ通.com'),
    'ポケカ30周年記念商品の抽選販売が決定'
  );
});

test('stripSourceSuffix: 媒体名と無関係なハイフンは切らない', () => {
  const t = 'ONE PIECEカードゲーム - 最強のリーダーを決める大会が開催';
  assert.equal(stripSourceSuffix(t, 'GameWith'), t);
});

test('stripSourceSuffix: 剥がすと本文が短くなりすぎる場合は残す', () => {
  const t = '速報 - GameWith';
  assert.equal(stripSourceSuffix(t, 'GameWith'), t);
});

test('stripSourceSuffix: sourceName が空なら何もしない', () => {
  const t = '新弾情報 - GameWith';
  assert.equal(stripSourceSuffix(t, ''), t);
});

// --- 要約の冗長判定 ---

test('isRedundantSummary: タイトルの焼き直しは捨てる', () => {
  assert.equal(
    isRedundantSummary(
      '【ポケポケ】新パックの収録カード一覧  GameWith',
      '【ポケポケ】新パックの収録カード一覧'
    ),
    true
  );
});

test('isRedundantSummary: 中身のある要約は残す', () => {
  assert.equal(
    isRedundantSummary(
      'ポケモンは本日、30周年記念商品の追加抽選販売を実施すると発表した。応募受付は8月28日12時から。',
      '「ポケモンカードゲーム」30周年記念商品の追加抽選販売を実施決定'
    ),
    false
  );
});

test('isRedundantSummary: 空の要約は冗長扱い', () => {
  assert.equal(isRedundantSummary('', 'なにかのタイトル'), true);
});

// --- ドメイン単位の減点 ---

test('domainPenalty: 転売系ドメインに減点が乗る', () => {
  const table = { 'snkrdunk.com': 25, 'mercari.com': 20 };
  assert.equal(domainPenalty('https://snkrdunk.com/items/123', table), 25);
  assert.equal(domainPenalty('https://www.snkrdunk.com/items/123', table), 25);
  assert.equal(domainPenalty('https://jp.mercari.com/item/abc', table), 20);
});

test('domainPenalty: 対象外ドメインは0', () => {
  assert.equal(domainPenalty('https://www.4gamer.net/games/1', { 'snkrdunk.com': 25 }), 0);
});

test('domainPenalty: 不正な入力でも落ちない', () => {
  assert.equal(domainPenalty('', { 'snkrdunk.com': 25 }), 0);
  assert.equal(domainPenalty('not a url', { 'snkrdunk.com': 25 }), 0);
  assert.equal(domainPenalty('https://example.com', undefined), 0);
});

test('scoreItem: 転売系ドメインの記事は同条件のニュース記事より低くなる', () => {
  const now = new Date('2026-08-23T12:00:00Z');
  const base = {
    title: 'ポケモンカード 30周年記念セットの抽選販売',
    summary: '',
    sourceWeight: 1.0,
    ips: ['pokemon'],
    publishedAt: '2026-08-23T11:00:00Z',
  };
  const cfg = { domainPenalties: { 'snkrdunk.com': 25 } };
  const news = scoreItem({ ...base, url: 'https://www.4gamer.net/x' }, cfg, now, 1);
  const resale = scoreItem({ ...base, url: 'https://snkrdunk.com/x' }, cfg, now, 1);
  assert.ok(resale.score < news.score, `${resale.score} < ${news.score} であるべき`);
  assert.ok(resale.breakdown.negative < 0);
});

// --- ランキングの同一サイト偏り防止 ---

import { selectTop } from '../src/score.js';

const ri = (id, host, ip, score) => ({
  id,
  title: `記事${id}`,
  url: `https://${host}/${id}`,
  ips: [ip, 'lottery'],
  score,
  publishedAt: '2026-08-23T00:00:00.000Z',
});

test('selectTop: 同一サイトの記事でランキングが埋まらない', () => {
  // 同じプレスリリース配信元の記事が1位と3位に並ぶ事故を防ぐ
  const list = [
    ri('a', 'prtimes.jp', 'pokemon', 90),
    ri('b', 'prtimes.jp', 'onepiece', 85),
    ri('c', 'prtimes.jp', 'pokemon', 80),
    ri('d', '4gamer.net', 'yugioh', 70),
    ri('e', 'famitsu.com', 'mtg', 60),
  ];
  const top = selectTop(list, 3);
  const hosts = top.map((t) => new URL(t.url).hostname);
  assert.equal(top.length, 3);
  assert.equal(new Set(hosts).size, 3, `サイトが分散していない: ${hosts.join(',')}`);
  assert.equal(top[0].id, 'a', 'スコア最上位は維持されること');
});

test('selectTop: www の有無は同一サイトとみなす', () => {
  const list = [
    ri('a', 'www.prtimes.jp', 'pokemon', 90),
    ri('b', 'prtimes.jp', 'onepiece', 85),
    ri('c', '4gamer.net', 'yugioh', 70),
  ];
  const top = selectTop(list, 2);
  assert.deepEqual(top.map((t) => t.id), ['a', 'c']);
});

test('selectTop: 候補が同一サイトしか無ければ制約を緩めて埋める', () => {
  const list = [
    ri('a', 'prtimes.jp', 'pokemon', 90),
    ri('b', 'prtimes.jp', 'onepiece', 85),
    ri('c', 'prtimes.jp', 'yugioh', 80),
  ];
  const top = selectTop(list, 3);
  assert.equal(top.length, 3, '件数が足りなくなるより埋めることを優先する');
});

// --- 公式サイト由来のノイズ対策 ---

import { looksLikeTcg } from '../src/collect.js';

test('looksLikeTcg: プレミアムバンダイのプラモデル商品を弾く', () => {
  // これらは p-bandai の「抽選販売」に実際に並んでいた商品
  assert.equal(looksLikeTcg('【抽選販売】ＭＧ 1/100 RX78FRGMT GUNDAM'), false);
  assert.equal(looksLikeTcg('【抽選販売】３０ＭＳ 櫻木真乃【２０２３年１２月発送】'), false);
  assert.equal(looksLikeTcg('【抽選販売】RG 1/144 ユニコーンガンダム２号機 バンシィ・ノルン'), false);
  assert.equal(looksLikeTcg('【抽選販売】30MS トウカイテイオー from ウマ娘 プリティーダービー'), false);
});

test('looksLikeTcg: カードゲーム商品は通す', () => {
  assert.equal(looksLikeTcg('デジモンカードゲーム リミテッドパック'), true);
  assert.equal(looksLikeTcg('【予約販売】データカードダス アイカツ'), true);
  assert.equal(looksLikeTcg('ポケモンカードゲーム 30周年記念BOX'), true);
  assert.equal(looksLikeTcg('新弾「ロマンスドーン」12パック入り'), true);
});

// --- 短い英字キーワードの誤爆防止 ---

import { matchIps, keywordMatches, normalizeForMatch, normalizeKeepingSpaces, needsWordBoundary } from '../src/collect.js';

const IPS_FIXTURE = {
  mtg: { keywords: ['マジック：ザ・ギャザリング', 'マジック・ザ・ギャザリング', 'MTG', 'Magic: The Gathering'] },
  pokemon: { keywords: ['ポケモンカード', 'ポケカ'] },
  yugioh: { keywords: ['遊戯王', '遊戯王OCG'] },
};

test('needsWordBoundary: 短い英数字語だけを対象にする', () => {
  assert.equal(needsWordBoundary('MTG'), true);
  assert.equal(needsWordBoundary('OCG'), true);
  assert.equal(needsWordBoundary('ポケカ'), false);        // 日本語は対象外
  assert.equal(needsWordBoundary('Magic'), false);        // 5文字以上は対象外
  assert.equal(needsWordBoundary(''), false);
});

test('matchIps: 型番の中の偶然の一致でIPを付けない', () => {
  // p-bandai の抽選販売にあった実際のガンプラ商品名。
  // "RX78FRGMT GUNDAM" の中に "mtg" が含まれるため、以前はMTG扱いされていた
  assert.deepEqual(matchIps('【抽選販売】ＭＧ 1/100 RX78FRGMT GUNDAM', IPS_FIXTURE), []);
  assert.deepEqual(matchIps('【抽選販売】ベストメカコレクション 1/144 RX78FRGMT GUNDAM', IPS_FIXTURE), []);
});

test('matchIps: 本物のMTG表記はこれまでどおり拾う', () => {
  assert.deepEqual(matchIps('MTG 新セット「霊気走破」発売決定', IPS_FIXTURE), ['mtg']);
  assert.deepEqual(matchIps('マジック：ザ・ギャザリング 統率者デッキ', IPS_FIXTURE), ['mtg']);
  assert.deepEqual(matchIps('Magic: The Gathering 新製品情報', IPS_FIXTURE), ['mtg']);
  assert.deepEqual(matchIps('話題の「mtg」がアツい', IPS_FIXTURE), ['mtg']);
});

test('matchIps: 日本語キーワードは従来どおり部分一致で拾う', () => {
  assert.deepEqual(matchIps('最新のポケモンカード情報まとめ', IPS_FIXTURE), ['pokemon']);
  assert.deepEqual(matchIps('遊戯王OCGの新弾', IPS_FIXTURE), ['yugioh']);
});

test('normalizeKeepingSpaces: 記号を空白に潰して境界を残す', () => {
  assert.equal(normalizeKeepingSpaces('Magic: The Gathering'), 'magic the gathering');
  assert.equal(normalizeKeepingSpaces('ＭＴＧ／新弾'), 'mtg 新弾');
});

test('keywordMatches: 空白入りキーワードはAND条件のまま', () => {
  const text = 'Gathering の Magic を語る';
  assert.equal(keywordMatches(normalizeForMatch(text), 'Magic: The Gathering', normalizeKeepingSpaces(text)), false);
});

// --- 記事本体ではないURLの正規化 ---

import { canonicalizeUrl } from '../src/resolve.js';

test('canonicalizeUrl: Yahoo!ニュースの画像・コメントページを記事本体に寄せる', () => {
  const article = 'https://news.yahoo.co.jp/articles/05d74db39cd166d89c8f0dd24e03db7409f1b10d';
  // 画像一覧ページを貼ると読者が記事にたどり着けない
  assert.equal(canonicalizeUrl(article + '/images/000'), article);
  assert.equal(canonicalizeUrl(article + '/images'), article);
  assert.equal(canonicalizeUrl(article + '/comments'), article);
  assert.equal(canonicalizeUrl(article + '/videos/001'), article);
  assert.equal(canonicalizeUrl(article), article, '記事URLはそのまま');
});

test('canonicalizeUrl: Yahoo!の他の形式や他サイトには影響しない', () => {
  assert.equal(canonicalizeUrl('https://news.yahoo.co.jp/pickup/6512345'), 'https://news.yahoo.co.jp/pickup/6512345');
  assert.equal(
    canonicalizeUrl('https://www.4gamer.net/games/256/G025620/20260821033/images/001'),
    'https://www.4gamer.net/games/256/G025620/20260821033/images/001'
  );
});

// --- クラスタ内での応募導線の引き継ぎ ---

import { inheritApplyInfo } from '../src/score.js';

test('inheritApplyInfo: 代表が応募リンクを持たなければ仲間から引き継ぐ', () => {
  // Yahoo!ニュースは外部購入リンクを削除するため destUrl が取れない。
  // 同じ抽選を報じた別媒体から引き継げないと、応募導線が失われる
  const rep = { url: 'https://news.yahoo.co.jp/articles/x', destUrl: null, deadline: null };
  const cluster = [
    rep,
    { url: 'https://inside-games.jp/a', destUrl: 'https://www.amazon.co.jp/dp/B0XXXX', destLabel: 'Amazon', deadline: '2026-08-31T07:59:00.000Z' },
  ];
  const out = inheritApplyInfo(rep, cluster);
  assert.equal(out.destUrl, 'https://www.amazon.co.jp/dp/B0XXXX');
  assert.equal(out.destLabel, 'Amazon');
  assert.equal(out.deadline, '2026-08-31T07:59:00.000Z');
});

test('inheritApplyInfo: 代表が既に持っていれば上書きしない', () => {
  const rep = { url: 'https://a.example/1', destUrl: 'https://p-bandai.jp/item/x', destLabel: 'プレミアムバンダイ' };
  const cluster = [rep, { url: 'https://b.example/1', destUrl: 'https://www.amazon.co.jp/dp/Y', destLabel: 'Amazon' }];
  const out = inheritApplyInfo(rep, cluster);
  assert.equal(out.destUrl, undefined, '代表の値を尊重すること');
});

test('inheritApplyInfo: 公式サイト由来の応募リンクを優先する', () => {
  const rep = { url: 'https://news.example/1', destUrl: null };
  const cluster = [
    rep,
    { url: 'https://blog.example/1', destUrl: 'https://www.amazon.co.jp/dp/Z', destLabel: 'Amazon', kind: 'news' },
    { url: 'https://www.pokemon-card.com/info/1', destUrl: 'https://www.pokemoncenter-online.com/x', destLabel: 'ポケモンセンターオンライン', tier: 'official' },
  ];
  const out = inheritApplyInfo(rep, cluster);
  assert.equal(out.destLabel, 'ポケモンセンターオンライン');
});

test('inheritApplyInfo: 誰も持っていなければ何も返さない', () => {
  const rep = { url: 'https://a.example/1', destUrl: null };
  assert.deepEqual(inheritApplyInfo(rep, [rep, { url: 'https://b.example/1' }]), {});
});

// --- 公式サイト設定の妥当性 ---

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const officialCfg = JSON.parse(readFileSync(join(ROOT, 'config/official-sites.json'), 'utf8'));

test('official-sites: MTG公式は連載コラムを除外する', () => {
  const mtg = officialCfg.sites.find((s) => s.id === 'mtg-jp-official');
  assert.ok(mtg, 'mtg-jp-official が存在すること');
  assert.ok(mtg.titleExclude, 'titleExclude が設定されていること');
  const re = new RegExp(mtg.titleExclude);
  // /reading/topics/ に実際に並んでいたコラム記事
  for (const t of [
    '第68回：『マジック：ザ・ギャザリング | ホビット』統率者ピックアップ｜クロタカの「コラム」',
    '今週のCool Deck：雷神ソーと夏期講習！講義デッキ（パイオニア）｜岩SHOWの「デイリー・デッキ」',
    'プレイテスト｜Making Magic -マジック開発秘話-',
    'とことん！スタンダー道！スーペリア・リアニメイト',
  ]) {
    assert.ok(re.test(t), `コラムが除外されていない: ${t}`);
  }
  // こちらは残すべき製品ニュース
  for (const t of [
    '2026年8月10日 禁止制限告知｜お知らせ',
    '『マジック：ザ・ギャザリング | ホビット』本日発売！｜こちらマジック広報室！！',
    '2026年後半2シーズンのプロモを一挙に公開！',
  ]) {
    assert.ok(!re.test(t), `製品ニュースまで除外している: ${t}`);
  }
});

test('official-sites: ポケモンセンターオンラインは無効のまま（bot対策を回避しない）', () => {
  const pc = officialCfg.sites.find((s) => s.id === 'pokemoncenter-online');
  if (pc) assert.equal(pc.enabled, false);
});

test('official-sites: 全サイトに必要な項目が揃っている', () => {
  for (const s of officialCfg.sites) {
    assert.ok(s.id, 'id が必要');
    assert.ok(s.name, `${s.id}: name が必要`);
    assert.ok(/^https?:\/\//.test(s.url), `${s.id}: url が不正`);
    assert.ok(Array.isArray(s.ips) && s.ips.length > 0, `${s.id}: ips が必要`);
    assert.equal(typeof s.enabled, 'boolean', `${s.id}: enabled が必要`);
  }
});

// --- 応募リンクが「違う店」を指してしまう事故の防止 ---

import { extractDestination } from '../src/enrich.js';

const SHOPS = {
  shops: [
    { domain: 'yodobashi.com', label: 'ヨドバシ', priority: 7 },
    { domain: 'pokemoncenter-online.com', label: 'ポケモンセンターオンライン', aliases: ['ポケセン'], priority: 10 },
    { domain: 'books.rakuten.co.jp', label: '楽天ブックス', priority: 5 },
  ],
  blockedDomains: [],
  anchorBoostWords: ['抽選', '応募', '予約', '購入'],
};

test('extractDestination: 記事が名指しした店のリンクが無ければ、別の店に飛ばさない', () => {
  // 「ヨドバシで抽選」という記事だが、ヨドバシへのリンクは記事内に無く、
  // 関連記事としてポケモンセンターのリンクだけがある状況
  const html = `
    <html><head><title>『ポケカ』30周年記念商品がヨドバシ・ドット・コムで抽選販売！</title></head>
    <body>
      <h1>『ポケカ』30周年記念商品がヨドバシ・ドット・コムで抽選販売！</h1>
      <p>詳細は各店舗にて。</p>
      <a href="https://www.pokemoncenter-online.com/news?id=20260821">ポケモンセンターの応募はこちら</a>
    </body></html>`;
  const got = extractDestination(html, 'https://example.com/article/1', SHOPS);
  assert.equal(got, null, '違う店へのリンクを応募先にしてはいけない');
});

test('extractDestination: 名指しした店のリンクがあればそれを選ぶ', () => {
  const html = `
    <html><head><title>『ポケカ』30周年記念商品がヨドバシ・ドット・コムで抽選販売！</title></head>
    <body>
      <h1>『ポケカ』30周年記念商品がヨドバシ・ドット・コムで抽選販売！</h1>
      <a href="https://www.pokemoncenter-online.com/news?id=1">関連: ポケモンセンター</a>
      <a href="https://www.yodobashi.com/product/100000001008765432/">ヨドバシで応募する</a>
    </body></html>`;
  const got = extractDestination(html, 'https://example.com/article/2', SHOPS);
  assert.ok(got, '候補が見つかるべき');
  assert.match(got.url, /yodobashi\.com/);
  assert.equal(got.label, 'ヨドバシ');
});

test('extractDestination: 店を名指ししていない記事なら従来どおり最良候補を返す', () => {
  const html = `
    <html><head><title>ポケカ30周年記念商品の抽選販売がまもなく開始</title></head>
    <body>
      <h1>ポケカ30周年記念商品の抽選販売がまもなく開始</h1>
      <a href="https://www.pokemoncenter-online.com/item/abc123">抽選に応募する</a>
    </body></html>`;
  const got = extractDestination(html, 'https://example.com/article/3', SHOPS);
  assert.ok(got, '名指しが無ければ従来どおり採用してよい');
  assert.match(got.url, /pokemoncenter-online\.com/);
});

test('extractDestination: 別名(ポケセン)での名指しも効く', () => {
  const html = `
    <html><head><title>ポケセンで30周年パックの抽選販売応募が開始</title></head>
    <body>
      <h1>ポケセンで30周年パックの抽選販売応募が開始</h1>
      <a href="https://books.rakuten.co.jp/rb/18595282">楽天ブックスで予約</a>
    </body></html>`;
  const got = extractDestination(html, 'https://example.com/article/4', SHOPS);
  assert.equal(got, null, '「ポケセン」の記事で楽天ブックスに飛ばしてはいけない');
});

test('extractDestination: 呼び出し側のタイトルでも名指し判定が効く（本文から見出しが取れない場合）', () => {
  // Yahoo!ニュースのように、本文HTMLから見出しをうまく取れないサイトを想定
  const html = `
    <html><body>
      <div class="opaque-wrapper"><span>本文</span></div>
      <a href="https://www.30th.pokemon-card.com/product/m6a">30周年特設サイト</a>
    </body></html>`;
  const title = '『ポケカ』30周年記念商品がヨドバシ・ドット・コムで抽選販売！';
  const withTitle = extractDestination(html, 'https://news.yahoo.co.jp/articles/x', SHOPS, { title });
  assert.equal(withTitle, null, 'ヨドバシの記事を別サイトへ飛ばしてはいけない');
});

test('extractDestination: 第4引数を省略しても従来どおり動く（後方互換）', () => {
  const html = `
    <html><head><title>ポケカ抽選まもなく開始</title></head>
    <body><a href="https://www.pokemoncenter-online.com/item/abc">応募する</a></body></html>`;
  const got = extractDestination(html, 'https://example.com/a', SHOPS);
  assert.ok(got);
  assert.match(got.url, /pokemoncenter-online/);
});

// --- クラスタ間で応募リンクを引き継ぐときの安全弁 ---

import { titleMentionsLabel } from '../src/score.js';

const LABELS = ['ヨドバシ.com', 'ポケモンセンターオンライン', 'ポケセン', '楽天ブックス', 'Amazon'];

test('titleMentionsLabel: 「ヨドバシ.com」は「ヨドバシ」表記でも一致する', () => {
  assert.equal(titleMentionsLabel('ヨドバシ・ドット・コムで抽選販売', 'ヨドバシ.com'), true);
  assert.equal(titleMentionsLabel('ポケセンで抽選', 'ポケセン'), true);
  assert.equal(titleMentionsLabel('ポケカ30周年の抽選', 'ヨドバシ.com'), false);
});

test('inheritApplyInfo: タイトルが名指しした店の応募リンクだけを引き継ぐ', () => {
  const rep = { title: '『ポケカ』30周年記念商品がヨドバシ・ドット・コムで抽選販売！', destUrl: null };
  const cluster = [
    rep,
    { title: '別記事', destUrl: 'https://www.30th.pokemon-card.com/product/m6a', destLabel: 'ポケモンカード公式' },
    { title: '別記事2', destUrl: 'https://limited.yodobashi.com/entry/shared', destLabel: 'ヨドバシ.com' },
  ];
  const got = inheritApplyInfo(rep, cluster, LABELS);
  assert.equal(got.destUrl, 'https://limited.yodobashi.com/entry/shared');
  assert.equal(got.destLabel, 'ヨドバシ.com');
});

test('inheritApplyInfo: 名指しした店のリンクが無ければ引き継がない', () => {
  const rep = { title: '『ポケカ』30周年記念商品がヨドバシ・ドット・コムで抽選販売！', destUrl: null };
  const cluster = [
    rep,
    { title: '別記事', destUrl: 'https://www.30th.pokemon-card.com/product/m6a', destLabel: 'ポケモンカード公式' },
  ];
  const got = inheritApplyInfo(rep, cluster, LABELS);
  assert.equal(got.destUrl, undefined, '違う店のリンクを引き継いではいけない');
});

test('inheritApplyInfo: 店を名指ししていない記事なら従来どおり引き継ぐ', () => {
  const rep = { title: 'ポケカ30周年記念商品の抽選販売がまもなく開始', destUrl: null };
  const cluster = [
    rep,
    { title: '別記事', destUrl: 'https://www.30th.pokemon-card.com/product/m6a', destLabel: 'ポケモンカード公式' },
  ];
  const got = inheritApplyInfo(rep, cluster, LABELS);
  assert.equal(got.destUrl, 'https://www.30th.pokemon-card.com/product/m6a');
});

test('inheritApplyInfo: 店名リストが未指定なら従来どおり動く（後方互換）', () => {
  const rep = { title: 'ヨドバシで抽選販売', destUrl: null };
  const cluster = [rep, { title: 'x', destUrl: 'https://example.com/a', destLabel: 'どこか' }];
  assert.equal(inheritApplyInfo(rep, cluster).destUrl, 'https://example.com/a');
});

// --- 小売店の発売予定日の取り込み ---

import { parseShopJson } from '../src/sources/shops.js';

test('parseShopJson: 楽天APIの release_date_text を発売予定として取り込む', () => {
  const json = JSON.stringify({
    items: [
      {
        title: 'UNION ARENA ブースターパック ウマ娘【UA59BT】',
        item_url: '/rb/18999999',
        creation_time: new Date().toISOString(),
        release_date_text: '2026年12月11日',
        sales_start_time: '2026-09-21T12:00:00.000Z',
        sales_end_time: '2026-09-28T23:59:59.000Z',
      },
    ],
  });
  const site = {
    id: 'rakuten-test',
    baseUrl: 'https://books.rakuten.co.jp',
    type: 'json',
    listKey: 'items',
    titleKey: 'title',
    pathKey: 'item_url',
    dateKey: 'creation_time',
    dateFormat: 'iso',
    startsAtKey: 'sales_start_time',
    deadlineKey: 'sales_end_time',
    releaseTextKey: 'release_date_text',
  };
  const out = parseShopJson(JSON.parse(json), site);
  assert.equal(out.length, 1);
  assert.equal(out[0].releaseText, '2026年12月11日', '発売予定日が取れること');
  assert.equal(out[0].deadline, '2026-09-28T23:59:59.000Z', '受付締切は従来どおり');
});

test('parseShopJson: releaseTextKey が無い設定でも壊れない（後方互換）', () => {
  const json = JSON.stringify({
    items: [{ title: 'テスト商品 カードゲーム', item_url: '/rb/1', creation_time: new Date().toISOString() }],
  });
  const site = {
    id: 'x', baseUrl: 'https://books.rakuten.co.jp', type: 'json',
    listKey: 'items', titleKey: 'title', pathKey: 'item_url',
    dateKey: 'creation_time', dateFormat: 'iso',
  };
  const out = parseShopJson(JSON.parse(json), site);
  assert.equal(out.length, 1);
  assert.equal(out[0].releaseText, '', '未設定なら空文字');
});

// --- 買えない商品を応募先として出さない ---

test('parseShopJson: 在庫状態が「ご注文できない商品」なら除外する', () => {
  const site = {
    id: 't', baseUrl: 'https://books.rakuten.co.jp', type: 'json',
    listKey: 'items', titleKey: 'title', pathKey: 'item_url',
    stockTextKey: 'stock_status_text',
    stockExclude: 'ご注文できない|売り切れ|品切|販売終了|在庫なし',
  };
  const rows = {
    items: [
      { title: '買える商品 カードゲーム', item_url: '/rb/1', stock_status_text: '入荷予約（入荷次第発送）' },
      { title: '買えない商品 カードゲーム', item_url: '/rb/2', stock_status_text: 'ご注文できない商品' },
      { title: '売切れ商品 カードゲーム', item_url: '/rb/3', stock_status_text: '売り切れ' },
      { title: '販売終了 カードゲーム', item_url: '/rb/4', stock_status_text: '販売終了' },
    ],
  };
  const out = parseShopJson(rows, site);
  assert.equal(out.length, 1, '買える商品だけが残ること');
  assert.equal(out[0].title, '買える商品 カードゲーム');
});

test('parseShopJson: stockTextKey 未設定なら在庫で除外しない（後方互換）', () => {
  const site = {
    id: 't', baseUrl: 'https://books.rakuten.co.jp', type: 'json',
    listKey: 'items', titleKey: 'title', pathKey: 'item_url',
  };
  const rows = { items: [{ title: 'なにか カードゲーム', item_url: '/rb/1', stock_status_text: 'ご注文できない商品' }] };
  assert.equal(parseShopJson(rows, site).length, 1);
});

// --- 年が省略された締切の解釈（記事の掲載日を基準にする）---

import { enrichItems as enrichForYear } from '../src/enrich.js';

test('enrichItems: 年の無い「8月28日まで」を、記事の掲載日基準で解釈する', async () => {
  // 記事は8/25掲載、締切は「8月28日」。実行日が9/4でも 2026年 と解釈されるべき。
  // 現在時刻を基準にすると「過去だから翌年」となり、締切が1年先に見えてしまう。
  const html = `
    <html><body><div class="entry-content">
      <h1>ポケモンカード抽選販売のお知らせ</h1>
      <p>応募受付は8月28日23時59分までです。奮ってご応募ください。</p>
      <a href="https://p-bandai.jp/item/item-1000012345/">抽選に応募する</a>
    </div></body></html>`;
  const fetchStub = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'text/html; charset=utf-8' },
    arrayBuffer: async () => new TextEncoder().encode(html).buffer,
    text: async () => html,
  });

  const item = {
    title: 'ポケモンカード抽選販売のお知らせ',
    url: 'https://news.example.com/a',
    publishedAt: '2026-08-25T00:00:00.000Z',
    intentTags: ['抽選'],
    ips: ['pokemon', 'lottery'],
  };
  await enrichForYear([item], { concurrency: 1, fetchImpl: fetchStub });

  assert.ok(item.deadline, '締切が取れること');
  assert.equal(
    new Date(item.deadline).getUTCFullYear(),
    2026,
    `記事掲載年で解釈されるべき（実際: ${item.deadline}）`
  );
});
