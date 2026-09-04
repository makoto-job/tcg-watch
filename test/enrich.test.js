/**
 * test/enrich.test.js — 区画G のユニットテスト（ネットワークアクセスなし）
 * 実行: node --test test/enrich.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  unwrapAffiliate,
  extractDestination,
  extractSchedule,
  extractMainText,
  enrichItems,
  loadShopsConfig,
} from '../src/enrich.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOPS = JSON.parse(await readFile(path.join(HERE, '..', 'config', 'shops.json'), 'utf8'));

const NOW = new Date('2026-08-23T00:00:00.000Z'); // JST 2026-08-23 09:00

/* ================================================================== */
/* unwrapAffiliate                                                     */
/* ================================================================== */

test('unwrapAffiliate: もしもアフィリエイト（url=）を解除する', () => {
  const target = 'https://p-bandai.jp/item/item-1000123456/';
  const src = `https://af.moshimo.com/af/c/click?a_id=1234567&p_id=99&pc_id=88&pl_id=77&url=${encodeURIComponent(target)}`;
  assert.equal(unwrapAffiliate(src), target);
});

test('unwrapAffiliate: バリューコマース（vc_url=）を解除する', () => {
  const target = 'https://www.yodobashi.com/product/100000001007654321/';
  const src = `https://ck.jp.ap.valuecommerce.com/servlet/referral?sid=3000000&pid=88000000&vc_url=${encodeURIComponent(target)}`;
  assert.equal(unwrapAffiliate(src), target);
});

test('unwrapAffiliate: 楽天アフィリエイト（pc=）を解除する', () => {
  const target = 'https://item.rakuten.co.jp/shopname/abc-123/';
  const src = `https://hb.afl.rakuten.co.jp/hgc/g00abcde.xxxxx/?pc=${encodeURIComponent(target)}&m=${encodeURIComponent(target)}`;
  assert.equal(unwrapAffiliate(src), target);
});

test('unwrapAffiliate: Amazon の tag / linkCode / ascsubtag / ref を除去する', () => {
  const src = 'https://www.amazon.co.jp/dp/B0ABCDEFGH/ref=nosim?tag=example-22&linkCode=ogi&ascsubtag=xyz';
  assert.equal(unwrapAffiliate(src), 'https://www.amazon.co.jp/dp/B0ABCDEFGH');
});

test('unwrapAffiliate: Amazon の必要なパスは壊さない', () => {
  const src = 'https://www.amazon.co.jp/gp/product/B0ABCDEFGH?tag=example-22';
  assert.equal(unwrapAffiliate(src), 'https://www.amazon.co.jp/gp/product/B0ABCDEFGH');
});

test('unwrapAffiliate: 二重ネスト（もしも → バリューコマース → 実URL）を2段まで解除する', () => {
  const target = 'https://p-bandai.jp/item/item-1000199999/';
  const vc = `https://ck.jp.ap.valuecommerce.com/servlet/referral?sid=1&pid=2&vc_url=${encodeURIComponent(target)}`;
  const src = `https://af.moshimo.com/af/c/click?a_id=1&url=${encodeURIComponent(vc)}`;
  assert.equal(unwrapAffiliate(src), target);
});

test('unwrapAffiliate: 二重エンコードされた url= も解除できる', () => {
  const target = 'https://p-bandai.jp/item/item-1000123456/';
  const src = `https://af.moshimo.com/af/c/click?a_id=1&url=${encodeURIComponent(encodeURIComponent(target))}`;
  assert.equal(unwrapAffiliate(src), target);
});

test('unwrapAffiliate: 解除不能な a8.net は入力をそのまま返す', () => {
  const src = 'https://px.a8.net/svt/ejp?a8mat=ABCDEF+GHIJKL+MNOP+QRSTU';
  assert.equal(unwrapAffiliate(src), src);
});

test('unwrapAffiliate: 通常URL・空文字・不正入力はそのまま返る', () => {
  assert.equal(unwrapAffiliate('https://www.4gamer.net/games/999/G999999/20260823001/'), 'https://www.4gamer.net/games/999/G999999/20260823001/');
  assert.equal(unwrapAffiliate(''), '');
  assert.equal(unwrapAffiliate(null), '');
  assert.equal(unwrapAffiliate('not a url'), 'not a url');
});

/* ================================================================== */
/* extractDestination                                                  */
/* ================================================================== */

test('extractDestination: priority が高いドメインを選ぶ', () => {
  const html = `
    <article>
      <p><a href="https://www.amazon.co.jp/dp/B0ABCDEFGH">Amazonで見る</a></p>
      <p><a href="https://p-bandai.jp/item/item-1000123456/">プレミアムバンダイ</a></p>
    </article>`;
  const dest = extractDestination(html, 'https://www.example.jp/news/1', SHOPS);
  assert.ok(dest);
  assert.equal(dest.url, 'https://p-bandai.jp/item/item-1000123456');
  assert.equal(dest.label, 'プレミアムバンダイ');
  assert.equal(dest.priority, 10);
});

test('extractDestination: 同じドメインならアンカーテキストに「抽選」があるものを優先する', () => {
  const html = `
    <article>
      <a href="https://www.amazon.co.jp/dp/B000000001">商品情報</a>
      <a href="https://www.amazon.co.jp/dp/B000000002">抽選販売に応募する</a>
    </article>`;
  const dest = extractDestination(html, 'https://www.example.jp/news/1', SHOPS);
  assert.ok(dest);
  assert.equal(dest.url, 'https://www.amazon.co.jp/dp/B000000002');
});

test('extractDestination: 5回以上出現する共通リンク（ヘッダ/フッタ）は除外する', () => {
  const nav = '<a href="https://p-bandai.jp/item/nav-banner/">プレミアムバンダイ</a>'.repeat(5);
  const html = `
    <header>${nav}</header>
    <article>
      <a href="https://www.yodobashi.com/product/100000001007654321/">ヨドバシで予約</a>
    </article>
    <footer>${nav}</footer>`;
  const dest = extractDestination(html, 'https://www.example.jp/news/1', SHOPS);
  assert.ok(dest);
  assert.equal(dest.label, 'ヨドバシ.com');
  assert.ok(!dest.url.includes('p-bandai'));
});

test('extractDestination: 4回までの出現なら除外しない', () => {
  const nav = '<a href="https://p-bandai.jp/item/item-1000123456/">プレミアムバンダイ</a>'.repeat(4);
  const html = `<article>${nav}<a href="https://www.yodobashi.com/product/1/">ヨドバシ</a></article>`;
  const dest = extractDestination(html, 'https://www.example.jp/news/1', SHOPS);
  assert.ok(dest);
  assert.equal(dest.label, 'プレミアムバンダイ');
});

test('extractDestination: blockedDomains（転売系）は絶対に選ばない', () => {
  const html = `
    <article>
      <a href="https://snkrdunk.com/trading-cards/12345">スニダンで買う（抽選）</a>
      <a href="https://jp.mercari.com/item/m12345">メルカリで購入</a>
      <a href="https://rakuma.rakuten.co.jp/item/abc">ラクマで購入</a>
      <a href="https://www.amazon.co.jp/dp/B000000003">Amazonで予約</a>
    </article>`;
  const dest = extractDestination(html, 'https://www.example.jp/news/1', SHOPS);
  assert.ok(dest);
  assert.equal(dest.label, 'Amazon');
  assert.ok(!/snkrdunk|mercari|rakuma/.test(dest.url));
});

test('extractDestination: 候補ゼロなら null', () => {
  const html = `
    <article>
      <a href="https://www.4gamer.net/games/1/">関連記事</a>
      <a href="https://twitter.com/example">公式X</a>
      <a href="#top">ページ先頭へ</a>
    </article>`;
  assert.equal(extractDestination(html, 'https://www.example.jp/news/1', SHOPS), null);
});

test('extractDestination: 相対URLが baseUrl で絶対化される', () => {
  const html = '<article><a href="/item/item-1000123456/">抽選販売はこちら</a></article>';
  const dest = extractDestination(html, 'https://p-bandai.jp/news/detail/12345', SHOPS);
  assert.ok(dest);
  assert.equal(dest.url, 'https://p-bandai.jp/item/item-1000123456');
});

test('extractDestination: トップページそのものより商品ページを優先する', () => {
  const html = `
    <article>
      <a href="https://p-bandai.jp/">プレミアムバンダイ公式サイト</a>
      <a href="https://www.amazon.co.jp/dp/B000000004">Amazonの商品ページ</a>
    </article>`;
  const dest = extractDestination(html, 'https://www.example.jp/news/1', SHOPS);
  assert.ok(dest);
  assert.equal(dest.label, 'Amazon');
});

test('extractDestination: 記事内のアフィリエイトリンクも解除して採用する', () => {
  const target = 'https://p-bandai.jp/item/item-1000177777/';
  const html = `<article><a href="https://af.moshimo.com/af/c/click?a_id=1&amp;url=${encodeURIComponent(target)}">抽選予約はこちら</a></article>`;
  const dest = extractDestination(html, 'https://www.example.jp/news/1', SHOPS);
  assert.ok(dest);
  assert.equal(dest.url, 'https://p-bandai.jp/item/item-1000177777');
});

test('extractDestination: 解除不能な a8.net リンクは採用しない', () => {
  const html = '<article><a href="https://px.a8.net/svt/ejp?a8mat=ABC">抽選予約はこちら</a></article>';
  assert.equal(extractDestination(html, 'https://www.example.jp/news/1', SHOPS), null);
});

test('extractDestination: より具体的なドメイン定義（楽天ブックス）が優先される', () => {
  const html = '<article><a href="https://books.rakuten.co.jp/rb/12345678/">楽天ブックスで予約</a></article>';
  const dest = extractDestination(html, 'https://www.example.jp/news/1', SHOPS);
  assert.ok(dest);
  assert.equal(dest.label, '楽天ブックス');
});

test('extractDestination: 不正入力でも throw せず null を返す', () => {
  assert.equal(extractDestination(null, 'https://x.jp/', SHOPS), null);
  assert.equal(extractDestination('<a href>', 'https://x.jp/', SHOPS), null);
  assert.equal(extractDestination('<a href="https://p-bandai.jp/item/a/">x</a>', 'https://x.jp/', null), null);
});

/* ================================================================== */
/* extractSchedule                                                     */
/* ================================================================== */

test('extractSchedule: 受付期間（曜日カッコ付き）', () => {
  const r = extractSchedule('受付期間：8月28日(木)12:00〜9月3日(水)23:59', { now: NOW });
  assert.equal(r.startsAt, '2026-08-28T03:00:00.000Z');
  assert.equal(r.deadline, '2026-09-03T14:59:00.000Z');
});

test('extractSchedule: 年つき・「から」「まで」区切り', () => {
  const r = extractSchedule('2026年8月28日 12時00分から2026年9月3日 23時59分まで', { now: NOW });
  assert.equal(r.startsAt, '2026-08-28T03:00:00.000Z');
  assert.equal(r.deadline, '2026-09-03T14:59:00.000Z');
});

test('extractSchedule: スラッシュ表記', () => {
  const r = extractSchedule('8/28 12:00 〜 9/3 23:59', { now: NOW });
  assert.equal(r.startsAt, '2026-08-28T03:00:00.000Z');
  assert.equal(r.deadline, '2026-09-03T14:59:00.000Z');
});

test('extractSchedule: 全角チルダ・全角数字でも同じ結果', () => {
  const r = extractSchedule('受付期間：８月２８日１２：００～９月３日２３：５９', { now: NOW });
  assert.equal(r.startsAt, '2026-08-28T03:00:00.000Z');
  assert.equal(r.deadline, '2026-09-03T14:59:00.000Z');
});

test('extractSchedule: 右辺が時刻だけ（同日の期間）', () => {
  const r = extractSchedule('受付は8/28 12:00〜23:59', { now: NOW });
  assert.equal(r.startsAt, '2026-08-28T03:00:00.000Z');
  assert.equal(r.deadline, '2026-08-28T14:59:00.000Z');
});

test('extractSchedule: 締切だけ（応募締切）', () => {
  const r = extractSchedule('応募締切：9月3日23時59分', { now: NOW });
  assert.equal(r.startsAt, null);
  assert.equal(r.deadline, '2026-09-03T14:59:00.000Z');
});

test('extractSchedule: 締切だけ（〜9月3日まで）は時刻を23:59に補完する', () => {
  const r = extractSchedule('〜9月3日まで', { now: NOW });
  assert.equal(r.startsAt, null);
  assert.equal(r.deadline, '2026-09-03T14:59:00.000Z');
});

test('extractSchedule: 開始だけ（受付開始）は時刻を00:00に補完する', () => {
  const r = extractSchedule('受付開始：8月28日より', { now: NOW });
  assert.equal(r.startsAt, '2026-08-27T15:00:00.000Z'); // JST 8/28 00:00
  assert.equal(r.deadline, null);
});

test('extractSchedule: 年跨ぎ（12月時点の「1月5日まで」は翌年）', () => {
  const now = new Date('2026-12-20T00:00:00.000Z');
  const r = extractSchedule('応募締切：1月5日まで', { now });
  assert.equal(r.deadline, '2027-01-05T14:59:00.000Z');
});

test('extractSchedule: 年跨ぎの期間（12/28〜1/5）は開始が今年・締切が翌年', () => {
  const now = new Date('2026-12-01T00:00:00.000Z');
  const r = extractSchedule('受付期間：12月28日12:00〜1月5日23:59', { now });
  assert.equal(r.startsAt, '2026-12-28T03:00:00.000Z');
  assert.equal(r.deadline, '2027-01-05T14:59:00.000Z');
});

test('extractSchedule: 「発売日」は締切として拾わない', () => {
  const r = extractSchedule('発売日9月5日', { now: NOW });
  assert.deepEqual(r, { startsAt: null, deadline: null });
});

test('extractSchedule: 「発送予定」「入荷」も締切にしない', () => {
  assert.deepEqual(extractSchedule('商品の発送予定は9月20日です', { now: NOW }), { startsAt: null, deadline: null });
  assert.deepEqual(extractSchedule('次回入荷は10月1日を予定', { now: NOW }), { startsAt: null, deadline: null });
});

test('extractSchedule: 発売日と応募締切が混在しても締切だけを正しく拾う', () => {
  const r = extractSchedule('9月5日発売予定です。応募は9月1日まで受け付けます。', { now: NOW });
  assert.equal(r.deadline, '2026-09-01T14:59:00.000Z');
});

test('extractSchedule: 日付が無い/判断がつかない文字列は両方 null', () => {
  assert.deepEqual(extractSchedule('新商品が登場します', { now: NOW }), { startsAt: null, deadline: null });
  assert.deepEqual(extractSchedule('', { now: NOW }), { startsAt: null, deadline: null });
  assert.deepEqual(extractSchedule(null, { now: NOW }), { startsAt: null, deadline: null });
  // 文脈のない裸の日付は推測で埋めない
  assert.deepEqual(extractSchedule('9月3日', { now: NOW }), { startsAt: null, deadline: null });
});

test('extractSchedule: Asia/Tokyo として解釈しUTCで返す', () => {
  const r = extractSchedule('応募締切は8月28日12:00です', { now: NOW });
  assert.equal(r.deadline, '2026-08-28T03:00:00.000Z');
});

test('extractSchedule: 存在しない日付は採用しない', () => {
  assert.equal(extractSchedule('応募締切：2月30日まで', { now: NOW }).deadline, null);
});

/* ================================================================== */
/* 実記事で見つかった不具合の再発防止                                  */
/* ================================================================== */

test('extractDestination: 記事タイトルが名指しした店を、より高priorityの店より優先する', () => {
  // 実例: inside-games の駿河屋抽選記事。記事下部のアフィリエイト価格ウィジェット
  // （Amazon/楽天）に引っ張られて Amazon が選ばれてしまっていた。
  const html = `
    <html><head><title>『ポケカ』30周年記念商品が、駿河屋通販で抽選販売！ | インサイド</title></head>
    <body><article>
      <p>詳細は<a href="https://www.suruga-ya.jp/blog?q=pokeka_chusen260820.html">ブログ</a>をご確認ください。</p>
      <a href="https://www.amazon.co.jp/dp/B0GXCRBL5J">ポケモンカードゲーム MEGA 拡張パック 30th CELEBRATION BOX</a>
      <a href="https://www.amazon.co.jp/dp/B0GXCRBL5J">Amazon</a>
    </article></body></html>`;
  const dest = extractDestination(html, 'https://www.inside-games.jp/article/1.html', SHOPS);
  assert.ok(dest);
  assert.equal(dest.label, '駿河屋');
  assert.ok(dest.url.includes('suruga-ya.jp'));
});

test('extractDestination: 記事と無関係なアフィリエイト広告リンクは採用しない', () => {
  // 実例: ガンプラ記事に貼られたポケカのAmazonアフィリエイトリンク
  const html = `
    <html><head><title>「MODEROID ラインバレル オーバードライブ」「MODEROID ヴァーダント」が予約受付中！ | インサイド</title></head>
    <body><article>
      <p>それぞれ9月30日まで予約受付中。</p>
      <a href="https://www.amazon.co.jp/dp/B0GXCRBL5J">ポケモンカードゲーム MEGA 拡張パック 30th CELEBRATION BOX</a>
      <a href="https://www.amazon.co.jp/dp/B0GXCRBL5J">Amazon</a>
    </article></body></html>`;
  assert.equal(extractDestination(html, 'https://www.inside-games.jp/article/2.html', SHOPS), null);
});

test('extractDestination: 記事と関係するアンカーなら通常どおり採用する', () => {
  const html = `
    <html><head><title>『ポケカ』30th CELEBRATIONがAmazonで抽選販売！ | インサイド</title></head>
    <body><article>
      <a href="https://www.amazon.co.jp/dp/B0GXCRBL5J">ポケモンカードゲーム MEGA 拡張パック 30th CELEBRATION BOX</a>
    </article></body></html>`;
  const dest = extractDestination(html, 'https://www.inside-games.jp/article/3.html', SHOPS);
  assert.ok(dest);
  assert.equal(dest.label, 'Amazon');
});

test('extractSchedule: 「支払期間」「当選発表」を応募締切として拾わない', () => {
  const text = '応募期間は8月20日20時〜9月6日まで。当選発表は9月7日。支払期間は9月7日〜9月11日までです。';
  const r = extractSchedule(text, { now: NOW });
  assert.equal(r.startsAt, '2026-08-20T11:00:00.000Z'); // JST 8/20 20:00
  assert.equal(r.deadline, '2026-09-06T14:59:00.000Z'); // JST 9/6 23:59
});

test('extractSchedule: 支払期間しか無ければ締切は出さない', () => {
  const r = extractSchedule('当選発表は9月7日。支払期間は9月7日〜9月11日までです。', { now: NOW });
  assert.deepEqual(r, { startsAt: null, deadline: null });
});

test('extractSchedule: 時刻まで明記された期間を、時刻の無い要約より優先する', () => {
  // 実例: 見出しに「応募は8月20日から9月6日」、本文に「8月20日20時〜9月6日まで」
  const text = '応募は8月20日から9月6日。 応募期間は8月20日20時〜9月6日まで。';
  const r = extractSchedule(text, { now: NOW });
  assert.equal(r.startsAt, '2026-08-20T11:00:00.000Z', '20時が反映される');
  assert.equal(r.deadline, '2026-09-06T14:59:00.000Z');
});

test('extractSchedule: 「お届け時期 11月11日〜11月20日発送予定」は締切にしない', () => {
  const text = '■抽選応募受付期間 いずれも8月28日12:00〜8月31日16:59 ・お届け時期 11月11日〜11月20日発送予定';
  const r = extractSchedule(text, { now: NOW });
  assert.equal(r.startsAt, '2026-08-28T03:00:00.000Z');
  assert.equal(r.deadline, '2026-08-31T07:59:00.000Z'); // JST 8/31 16:59
});

/* ================================================================== */
/* extractMainText                                                     */
/* ================================================================== */

const LONG = 'この商品は抽選販売となります。詳細は公式サイトをご確認ください。'.repeat(8);

test('extractMainText: 関連記事ブロックではなく本文を返す', () => {
  const html = `
    <html><body>
      <nav><a href="/">トップ</a>ドンキで抽選販売！8月31日まで応募受付中</nav>
      <article class="arti-body"><p>${LONG}応募期間は9月1日まで。</p></article>
      <article class="pickup-content">別の抽選は8月31日まで</article>
      <aside>ランキング: 別商品の抽選は8月15日まで</aside>
    </body></html>`;
  const text = extractMainText(html);
  assert.ok(text.includes('応募期間は9月1日まで'));
  assert.ok(!text.includes('8月31日'), '関連記事の締切が混入していない');
  assert.ok(!text.includes('8月15日'));
});

test('extractMainText: <article> が無ければ本文コンテナ div を使う', () => {
  const html = `
    <html><body>
      <div class="left_contents">サイドバー: 別の抽選は8月15日まで</div>
      <div class="entry-content"><p>${LONG}</p><div><p>受付期間は9月3日23:59まで。</p></div></div>
    </body></html>`;
  const text = extractMainText(html);
  assert.ok(text.includes('9月3日23:59まで'), '入れ子の div を跨いで本文が取れる');
  assert.ok(!text.includes('8月15日'));
});

test('extractMainText: 本文領域が無ければ空文字（＝締切を出さない）', () => {
  assert.equal(extractMainText('<html><body><p>短い</p></body></html>'), '');
  assert.equal(extractMainText(''), '');
  assert.equal(extractMainText(null), '');
});

test('extractMainText: script / style の中身は混入しない', () => {
  const html = `<article><script>var d="8月15日まで";</script><style>.a{}</style><p>${LONG}応募は9月3日まで。</p></article>`;
  const text = extractMainText(html);
  assert.ok(text.includes('9月3日まで'));
  assert.ok(!text.includes('8月15日'));
});

test('enrichItems: 関連記事の締切を本文の締切と取り違えない', async () => {
  const html = `
    <html><head><title>ポケカ抽選販売 | テスト</title></head><body>
      <article class="arti-body">
        <p>${LONG}</p>
        <p>応募期間：9月1日12:00〜9月10日23:59</p>
        <p><a href="https://p-bandai.jp/item/item-1000111111/">抽選販売に応募する</a></p>
      </article>
      <aside><a href="/x">別記事: ドンキで抽選販売！8月31日まで応募受付中</a></aside>
    </body></html>`;
  const items = [makeItem()];
  await enrichItems(items, { shopsConfig: SHOPS, fetchImpl: makeFetchStub(async () => htmlResponse(html)) });
  assert.equal(items[0].deadline, '2026-09-10T14:59:00.000Z');
  assert.equal(items[0].startsAt, '2026-09-01T03:00:00.000Z');
  assert.equal(items[0].destLabel, 'プレミアムバンダイ');
});

/* ================================================================== */
/* enrichItems                                                         */
/* ================================================================== */

function makeItem(over = {}) {
  return {
    id: 'aaaaaaaaaaaaaaaa',
    title: 'ポケカ 抽選販売',
    url: 'https://www.example.jp/news/1',
    sourceName: 'テスト',
    summary: '',
    publishedAt: NOW.toISOString(),
    ips: ['pokemon'],
    intentTags: ['抽選'],
    ...over,
  };
}

/** fetch スタブ。呼ばれたURLを記録する。 */
function makeFetchStub(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push(String(url));
    return handler(String(url), init);
  };
  fn.calls = calls;
  return fn;
}

function htmlResponse(body) {
  return {
    ok: true,
    status: 200,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) },
    text: async () => body,
  };
}

const ARTICLE_HTML = `
  <html><body>
    <article>
      <h1>ポケモンカード 抽選販売</h1>
      <p>受付期間：8月28日(木)12:00〜9月3日(水)23:59</p>
      <p><a href="https://www.pokemoncenter-online.com/?p=lottery-12345">抽選販売に応募する</a></p>
    </article>
  </body></html>`;

test('enrichItems: 対象アイテムから応募リンクと締切を取り出す', async () => {
  const fetchStub = makeFetchStub(async () => htmlResponse(ARTICLE_HTML));
  const items = [makeItem()];
  const out = await enrichItems(items, { shopsConfig: SHOPS, fetchImpl: fetchStub, concurrency: 2 });

  assert.equal(out, items, '入力と同じ配列を返す');
  assert.equal(out[0].destLabel, 'ポケモンセンターオンライン');
  assert.ok(out[0].destUrl.includes('pokemoncenter-online.com'));
  assert.equal(out[0].startsAt, '2026-08-28T03:00:00.000Z');
  assert.equal(out[0].deadline, '2026-09-03T14:59:00.000Z');
  assert.equal(fetchStub.calls.length, 1);
});

test('enrichItems: 対象外アイテム（抽選・予約系でない）は素通しする', async () => {
  const fetchStub = makeFetchStub(async () => htmlResponse(ARTICLE_HTML));
  const items = [makeItem({ intentTags: ['新商品'], ips: ['mtg'] })];
  const out = await enrichItems(items, { shopsConfig: SHOPS, fetchImpl: fetchStub });

  assert.equal(fetchStub.calls.length, 0, '取得しない');
  assert.equal(out[0].destUrl, null);
  assert.equal(out[0].deadline, null);
  assert.equal(out[0].title, 'ポケカ 抽選販売', '元のフィールドは保持される');
});

test('enrichItems: ips に lottery があれば対象になる', async () => {
  const fetchStub = makeFetchStub(async () => htmlResponse(ARTICLE_HTML));
  const items = [makeItem({ intentTags: [], ips: ['lottery'] })];
  await enrichItems(items, { shopsConfig: SHOPS, fetchImpl: fetchStub });
  assert.equal(fetchStub.calls.length, 1);
});

test('enrichItems: fetch が失敗しても throw せず元のitemが壊れない', async () => {
  const fetchStub = makeFetchStub(async () => {
    throw new Error('ECONNRESET');
  });
  const items = [makeItem()];
  const out = await enrichItems(items, { shopsConfig: SHOPS, fetchImpl: fetchStub });

  assert.equal(out[0].destUrl, null);
  assert.equal(out[0].deadline, null);
  assert.equal(out[0].title, 'ポケカ 抽選販売');
  assert.equal(out[0].url, 'https://www.example.jp/news/1');
});

test('enrichItems: 404 / 非HTML レスポンスでも壊れない', async () => {
  const items = [makeItem(), makeItem({ id: 'b', url: 'https://www.example.jp/news/2' })];
  const fetchStub = makeFetchStub(async (url) => {
    if (url.endsWith('/1')) return { ok: false, status: 404, headers: { get: () => null }, text: async () => '' };
    return { ok: true, status: 200, headers: { get: () => 'application/pdf' }, text: async () => 'binary' };
  });
  const out = await enrichItems(items, { shopsConfig: SHOPS, fetchImpl: fetchStub });
  assert.equal(out[0].destUrl, null);
  assert.equal(out[1].destUrl, null);
});

test('enrichItems: maxFetch の上限が効く', async () => {
  const fetchStub = makeFetchStub(async () => htmlResponse(ARTICLE_HTML));
  const items = Array.from({ length: 10 }, (_, i) =>
    makeItem({ id: `id${i}`, url: `https://www.example.jp/news/${i}` })
  );
  await enrichItems(items, { shopsConfig: SHOPS, fetchImpl: fetchStub, maxFetch: 3 });
  assert.equal(fetchStub.calls.length, 3);
});

test('enrichItems: 応募先と締切の両方が分かっていれば再取得しない', async () => {
  const fetchStub = makeFetchStub(async () => htmlResponse(ARTICLE_HTML));
  const items = [
    makeItem({
      destUrl: 'https://p-bandai.jp/item/item-1/',
      destLabel: 'プレミアムバンダイ',
      deadline: '2026-09-03T14:59:00.000Z',
    }),
  ];
  await enrichItems(items, { shopsConfig: SHOPS, fetchImpl: fetchStub });

  assert.equal(fetchStub.calls.length, 0);
  assert.equal(items[0].destUrl, 'https://p-bandai.jp/item/item-1/');
  assert.equal(items[0].destLabel, 'プレミアムバンダイ');
});

test('enrichItems: 応募先が分かっていても締切が未取得なら取りに行く', async () => {
  // 小売店由来のアイテムは最初から応募先を持つが、締切はページを見ないと分からない。
  // ここで取得を打ち切ると「いつまでに応募すればよいか」が永久に埋まらない。
  const fetchStub = makeFetchStub(async () => htmlResponse(ARTICLE_HTML));
  const items = [
    makeItem({
      destUrl: 'https://p-bandai.jp/item/item-1/',
      destLabel: 'プレミアムバンダイ',
      deadline: null,
    }),
  ];
  await enrichItems(items, { shopsConfig: SHOPS, fetchImpl: fetchStub });

  assert.equal(fetchStub.calls.length, 1, '締切のために1回は取得する');
  assert.equal(items[0].destUrl, 'https://p-bandai.jp/item/item-1/', '応募先は上書きされない');
  assert.equal(items[0].destLabel, 'プレミアムバンダイ');
});

test('enrichItems: 記事URL自体がショップドメインならそれを destUrl にする', async () => {
  const fetchStub = makeFetchStub(async () => htmlResponse(ARTICLE_HTML));
  const items = [makeItem({ url: 'https://p-bandai.jp/item/item-1000123456/' })];
  const out = await enrichItems(items, { shopsConfig: SHOPS, fetchImpl: fetchStub });

  // 応募先はURLから即決まる（外部の判定は不要）。
  // ただし締切が未取得なので、そのために1回だけ取得しにいく。
  assert.equal(out[0].destUrl, 'https://p-bandai.jp/item/item-1000123456');
  assert.equal(out[0].destLabel, 'プレミアムバンダイ');
  assert.equal(out[0].tier, 'shop');
  assert.equal(fetchStub.calls.length, 1, '締切抽出のための取得');
});

test('enrichItems: 同時実行数を超えて並列に走らない', async () => {
  let inFlight = 0;
  let peak = 0;
  const fetchStub = makeFetchStub(async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return htmlResponse(ARTICLE_HTML);
  });
  const items = Array.from({ length: 8 }, (_, i) =>
    makeItem({ id: `id${i}`, url: `https://www.example.jp/news/${i}` })
  );
  await enrichItems(items, { shopsConfig: SHOPS, fetchImpl: fetchStub, concurrency: 2 });
  assert.ok(peak <= 2, `peak=${peak}`);
});

test('enrichItems: items が配列でなくても throw しない', async () => {
  assert.equal(await enrichItems(null, { shopsConfig: SHOPS }), null);
  assert.equal(await enrichItems(undefined, { shopsConfig: SHOPS }), undefined);
});

test('enrichItems: オプション省略時は config/shops.json を読み込む', async () => {
  const cfg = await loadShopsConfig();
  assert.ok(cfg.shops.length > 40, `shops=${cfg.shops.length}`);
  assert.ok(cfg.blockedDomains.includes('snkrdunk.com'));
  assert.ok(cfg.anchorBoostWords.includes('抽選'));
});

/* ================================================================== */
/* config/shops.json の健全性                                          */
/* ================================================================== */

test('shops.json: 全エントリが domain / label / category / priority を持つ', () => {
  const cats = new Set(['maker', 'cardshop', 'toy', 'ec', 'kaden', 'cvs', 'anime', 'book', 'reuse', 'super']);
  for (const s of SHOPS.shops) {
    assert.ok(s.domain && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(s.domain), `bad domain: ${s.domain}`);
    assert.ok(s.label && typeof s.label === 'string', `bad label: ${s.domain}`);
    assert.ok(cats.has(s.category), `unknown category: ${s.domain} / ${s.category}`);
    assert.ok(Number.isInteger(s.priority) && s.priority >= 1 && s.priority <= 10, `bad priority: ${s.domain}`);
  }
});

test('shops.json: ドメインの重複がない', () => {
  const seen = new Set();
  for (const s of SHOPS.shops) {
    assert.ok(!seen.has(s.domain), `duplicate: ${s.domain}`);
    seen.add(s.domain);
  }
});

test('shops.json: 転売・フリマ系は shops に混入していない', () => {
  const resale = ['snkrdunk.com', 'mercari.com', 'fril.jp', 'aucfan.com', 'auctions.yahoo.co.jp', 'jmty.jp'];
  for (const bad of resale) {
    assert.ok(!SHOPS.shops.some((s) => s.domain === bad), `${bad} が shops に入っている`);
    assert.ok(SHOPS.blockedDomains.includes(bad), `${bad} が blockedDomains に無い`);
  }
});

test('shops.json: 販売チャネルが各カテゴリで網羅されている', () => {
  const byCat = {};
  for (const s of SHOPS.shops) byCat[s.category] = (byCat[s.category] || 0) + 1;
  for (const c of ['maker', 'cardshop', 'toy', 'ec', 'kaden', 'cvs', 'anime', 'book', 'reuse', 'super']) {
    assert.ok((byCat[c] || 0) >= 3, `category ${c} は3件以上必要 (現在 ${byCat[c] || 0})`);
  }
  // メーカー直販がカードショップ・総合ECより高優先であること
  const maker = SHOPS.shops.filter((s) => s.category === 'maker');
  const ec = SHOPS.shops.filter((s) => s.category === 'ec');
  assert.ok(Math.min(...maker.map((s) => s.priority)) >= Math.max(...ec.map((s) => s.priority)));
});
