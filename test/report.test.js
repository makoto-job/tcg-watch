// test/report.test.js
// Node標準テストランナー / ネットワークアクセスなし
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildReportHtml, deadlineBadge, isExpired, isApplyOpen, esc, safeUrl } from '../src/report.js';

const NOW = new Date('2026-08-24T00:00:00.000Z'); // JST 8/24 09:00

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

/** NOW から相対的な ISO8601 */
function iso(offsetMs) {
  return new Date(NOW.getTime() + offsetMs).toISOString();
}

let seq = 0;
/** FeedItem / RankedItem 相当。第2フェーズのフィールドは既定で未設定（=null） */
function makeItem(overrides = {}) {
  seq += 1;
  return {
    id: `id${seq}`,
    title: `テストタイトル${seq}`,
    url: `https://news.example.com/article/${seq}`,
    sourceName: '4Gamer',
    publishedAt: '2026-08-23T10:00:00.000Z',
    summary: '',
    ips: ['pokemon'],
    intentTags: ['抽選'],
    score: 42.5,
    clusterSize: 1,
    isRanked: false,
    rank: null,
    ...overrides,
  };
}

function render(over = {}) {
  return buildReportHtml({ top: [], texts: [], feedItems: [], stats: {}, now: NOW, ...over });
}

/** 「いま応募できるもの」セクションだけを切り出す（無ければ空文字） */
function offersSection(html) {
  const start = html.indexOf('<h2>🎯 いま応募できるもの');
  if (start === -1) return '';
  const end = html.indexOf('<h2>今日のランキング', start);
  return html.slice(start, end === -1 ? undefined : end);
}

// ---------------------------------------------------------------------------
// deadlineBadge — 残り時間の見せ方
// ---------------------------------------------------------------------------

test('deadlineBadge: deadline が無ければ null（「締切不明」と書かない）', () => {
  assert.equal(deadlineBadge(null, NOW), null);
  assert.equal(deadlineBadge(undefined, NOW), null);
  assert.equal(deadlineBadge('', NOW), null);
  assert.equal(deadlineBadge('not-a-date', NOW), null);
});

test('deadlineBadge: 残り時間で文言が切り替わる', () => {
  assert.deepEqual(
    { ...deadlineBadge(iso(-HOUR), NOW), diffMs: undefined },
    { state: 'expired', text: '受付終了', diffMs: undefined },
  );
  assert.equal(deadlineBadge(iso(-1), NOW).state, 'expired');

  // 1時間未満 = 最も強い警告
  assert.equal(deadlineBadge(iso(30 * 60 * 1000), NOW).text, 'まもなく締切');
  assert.equal(deadlineBadge(iso(30 * 60 * 1000), NOW).state, 'urgent');

  // 24時間未満
  assert.equal(deadlineBadge(iso(3 * HOUR + 60000), NOW).text, 'あと3時間');
  assert.equal(deadlineBadge(iso(3 * HOUR + 60000), NOW).state, 'soon');
  assert.equal(deadlineBadge(iso(23 * HOUR), NOW).text, 'あと23時間');

  // 7日未満
  assert.equal(deadlineBadge(iso(2 * DAY + HOUR), NOW).text, 'あと2日');
  assert.equal(deadlineBadge(iso(2 * DAY + HOUR), NOW).state, 'near');
  assert.equal(deadlineBadge(iso(DAY + 60000), NOW).text, 'あと1日');

  // それ以上は日付表示（JST）
  const far = deadlineBadge('2026-09-03T14:59:00.000Z', NOW); // JST 9/3 23:59
  assert.equal(far.state, 'far');
  assert.equal(far.text, '9/3まで');
});

test('deadlineBadge: 境界（ちょうど1時間 / 24時間 / 7日）', () => {
  assert.equal(deadlineBadge(iso(HOUR), NOW).text, 'あと1時間');
  assert.equal(deadlineBadge(iso(DAY), NOW).text, 'あと1日');
  assert.equal(deadlineBadge(iso(7 * DAY), NOW).state, 'far');
});

test('isExpired / isApplyOpen', () => {
  assert.equal(isExpired(makeItem(), NOW), false); // deadline 無し = 期限切れ扱いしない
  assert.equal(isExpired(makeItem({ deadline: iso(-DAY) }), NOW), true);
  assert.equal(isApplyOpen(makeItem(), NOW), false); // destUrl 無し
  assert.equal(isApplyOpen(makeItem({ destUrl: 'https://p-bandai.jp/x' }), NOW), true);
  assert.equal(
    isApplyOpen(makeItem({ destUrl: 'https://p-bandai.jp/x', deadline: iso(-DAY) }), NOW),
    false,
  );
  // javascript: は弾く
  assert.equal(isApplyOpen(makeItem({ destUrl: 'javascript:alert(1)' }), NOW), false);
});

// ---------------------------------------------------------------------------
// 応募ボタン
// ---------------------------------------------------------------------------

test('destUrl があるとき応募ボタンのHTMLが出る（店名つき）', () => {
  const item = makeItem({
    destUrl: 'https://p-bandai.jp/item/item-1000012345/',
    destLabel: 'プレミアムバンダイ',
    deadline: iso(2 * DAY),
    applyVerified: true,
  });
  const html = render({ top: [item], feedItems: [item] });

  assert.ok(html.includes('class="apply"'), '応募ボタンが無い');
  assert.ok(html.includes('プレミアムバンダイで応募'), 'ラベルに店名が入っていない');
  assert.ok(html.includes('https://p-bandai.jp/item/item-1000012345/'), '応募URLが無い');
  assert.ok(html.includes('rel="noopener noreferrer"'));
});

test('destLabel が無くても destUrl があればボタンは出る', () => {
  const item = makeItem({ destUrl: 'https://www.pokemoncenter-online.com/x' });
  const html = render({ feedItems: [item] });
  assert.ok(html.includes('応募ページへ'), html.slice(0, 200));
  // 行き先はドメインで補う
  assert.ok(html.includes('pokemoncenter-online.com'));
});

test('destUrl が null なら応募ボタンは出ない（後方互換）', () => {
  const item = makeItem();
  const html = render({ top: [item], feedItems: [item] });
  assert.equal(html.includes('class="apply"'), false, '応募ボタンが出てしまっている');
  assert.equal(html.includes('で応募'), false);
  assert.equal(html.includes('<h2>🎯 いま応募できるもの'), false);
});

test('destUrl が全て null でもレポートは組み立つ（完全な後方互換）', () => {
  const items = [makeItem(), makeItem({ intentTags: [] }), makeItem({ summary: '要約です' })];
  const html = render({ top: items, feedItems: items, texts: ['テストツイート'] });
  assert.ok(html.includes('今日のランキング'));
  assert.ok(html.includes('アプリに載る最新情報'));
  assert.ok(html.includes('投稿される文面'));
  for (const it of items) assert.ok(html.includes(it.url), `${it.url} が出ていない`);
});

// ---------------------------------------------------------------------------
// 主リンクの入れ替え（項目そのものを押したら応募ページへ）
// ---------------------------------------------------------------------------

test('destUrl があるとき、タイトルのリンク先が destUrl になる', () => {
  const item = makeItem({
    title: 'ポケカ30周年 抽選販売',
    url: 'https://news.example.com/pokeka',
    destUrl: 'https://p-bandai.jp/item/item-1/',
    destLabel: 'プレミアムバンダイ',
  });
  const html = render({ top: [item], feedItems: [item] });

  // rank__title / row__title / offer__title いずれのタイトルも destUrl を指す
  const titleHrefs = [...html.matchAll(/class="(?:rank__title|row__title|offer__title)[^"]*"><a href="([^"]+)"/g)]
    .map((m) => m[1]);
  assert.ok(titleHrefs.length >= 3, `タイトルリンクが見つからない: ${titleHrefs.length}`);
  for (const href of titleHrefs) {
    assert.equal(href, 'https://p-bandai.jp/item/item-1/', `タイトルが応募ページを指していない: ${href}`);
  }
});

test('destUrl があるとき、記事への副リンクも同時に存在する（ニュースも大切）', () => {
  const item = makeItem({
    url: 'https://news.example.com/pokeka',
    destUrl: 'https://p-bandai.jp/item/item-1/',
    destLabel: 'プレミアムバンダイ',
  });
  const html = render({ top: [item], feedItems: [item] });
  assert.ok(html.includes('class="readmore"'), '記事への副リンクが消えている');
  assert.ok(html.includes('記事を読む'), '「記事を読む」が無い');
  assert.ok(html.includes('href="https://news.example.com/pokeka"'), '記事URLが残っていない');
});

test('行き先（店名）がタイトルの近くに必ず表示される', () => {
  const item = makeItem({ destUrl: 'https://p-bandai.jp/item/1/', destLabel: 'プレミアムバンダイ' });
  const html = render({ feedItems: [item] });
  assert.ok(html.includes('class="dest-hint"'), '行き先表示が無い');
  assert.match(html, /class="dest-hint">.*?プレミアムバンダイ/s);
});

test('destUrl が無いとき、タイトルは記事URLのままでチップもリンクにならない', () => {
  const item = makeItem({ url: 'https://news.example.com/plain', intentTags: ['抽選', '予約'] });
  const html = render({ top: [item], feedItems: [item] });

  const titleHrefs = [...html.matchAll(/class="(?:rank__title|row__title)[^"]*"><a href="([^"]+)"/g)].map(
    (m) => m[1],
  );
  assert.ok(titleHrefs.length >= 2);
  for (const href of titleHrefs) assert.equal(href, 'https://news.example.com/plain');

  // ※ 文字列 "chip--link" はCSS定義にも現れるので、マークアップの形で判定する
  assert.equal(/<a class="chip [^"]*chip--link"/.test(html), false, 'チップがリンクになってしまっている');
  assert.ok(html.includes('<span class="chip chip--hot">抽選</span>'), 'チップが span でない');
  assert.equal(html.includes('<span class="dest-hint">'), false, '行き先表示が出てしまっている');
});

test('destUrl があるとき intentTags チップが応募ページへのリンクになる', () => {
  const item = makeItem({
    title: 'ポケカ抽選',
    intentTags: ['抽選', '予約'],
    destUrl: 'https://p-bandai.jp/item/1/',
    destLabel: 'プレミアムバンダイ',
  });
  const html = render({ feedItems: [item] });
  assert.ok(html.includes('chip--link'), 'チップがリンクになっていない');
  assert.match(html, /<a class="chip chip--hot chip--link" href="https:\/\/p-bandai\.jp\/item\/1\/"/);
  // アクセシビリティ: 何が起きるか読み上げで分かること
  assert.ok(html.includes('aria-label="ポケカ抽選 — プレミアムバンダイの抽選ページを開く"'), html.match(/aria-label="[^"]*"/g));
});

// ---------------------------------------------------------------------------
// 締切バッジのレンダリング
// ---------------------------------------------------------------------------

test('締切バッジがHTMLに出る／deadline が無ければ出ない', () => {
  const withDl = render({ feedItems: [makeItem({ deadline: iso(3 * HOUR + 60000) })] });
  assert.ok(withDl.includes('class="dl dl--soon"'), withDl.match(/class="dl[^"]*"/g));
  assert.ok(withDl.includes('あと3時間'));

  const without = render({ feedItems: [makeItem()] });
  assert.equal(/class="dl dl--/.test(without), false, 'バッジが出てしまっている');
  assert.equal(without.includes('締切不明'), false);
});

test('締切バッジの state が残り時間で切り替わる（レポート出力上でも）', () => {
  const cases = [
    [iso(-DAY), 'dl--expired', '受付終了'],
    [iso(20 * 60 * 1000), 'dl--urgent', 'まもなく締切'],
    [iso(5 * HOUR), 'dl--soon', 'あと5時間'],
    [iso(3 * DAY), 'dl--near', 'あと3日'],
    [iso(30 * DAY), 'dl--far', 'まで'],
  ];
  for (const [deadline, cls, text] of cases) {
    const html = render({ feedItems: [makeItem({ deadline })] });
    assert.ok(html.includes(`class="dl ${cls}"`), `${cls} が出ていない`);
    assert.ok(html.includes(text), `${text} が出ていない`);
  }
});

test('締切切れは最新情報リストで淡色表示になる', () => {
  const html = render({ feedItems: [makeItem({ deadline: iso(-DAY) })] });
  assert.ok(html.includes('<li class="row is-expired">'), '淡色クラスが付いていない');
});

test('startsAt が未来なら「受付開始」を出す', () => {
  const html = render({ feedItems: [makeItem({ startsAt: '2026-08-28T03:00:00.000Z' })] });
  assert.ok(html.includes('dl--start'), '受付開始バッジが無い');
  assert.ok(html.includes('8/28 12:00 受付開始'), html.match(/dl--start[^<]*<[^>]*>[^<]*/));

  // 過去の startsAt は出さない
  const past = render({ feedItems: [makeItem({ startsAt: iso(-DAY) })] });
  assert.equal(past.includes('受付開始'), false);
});

// ---------------------------------------------------------------------------
// 「いま応募できるもの」セクション
// ---------------------------------------------------------------------------

test('「いま応募できるもの」は締切が近い順に並ぶ', () => {
  const items = [
    makeItem({ title: '3番目に近い', destUrl: 'https://p-bandai.jp/c/', deadline: iso(5 * DAY) }),
    makeItem({ title: '1番目に近い', destUrl: 'https://p-bandai.jp/a/', deadline: iso(2 * HOUR) }),
    makeItem({ title: '締切不明なので最後', destUrl: 'https://p-bandai.jp/d/' }),
    makeItem({ title: '2番目に近い', destUrl: 'https://p-bandai.jp/b/', deadline: iso(DAY) }),
  ];
  const html = render({ feedItems: items });
  const sec = offersSection(html);
  assert.notEqual(sec, '', 'セクションが出ていない');

  const order = [...sec.matchAll(/class="offer__title[^"]*"><a[^>]*>([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(order, ['1番目に近い', '2番目に近い', '3番目に近い', '締切不明なので最後']);
});

test('「いま応募できるもの」は締切切れを含まない／0件なら出ない', () => {
  const expiredOnly = [
    makeItem({ destUrl: 'https://p-bandai.jp/x/', deadline: iso(-HOUR) }),
    makeItem(), // destUrl なし
  ];
  const html = render({ top: expiredOnly, feedItems: expiredOnly });
  assert.equal(offersSection(html), '', '0件なのにセクションが出ている');

  const mixed = [...expiredOnly, makeItem({ title: '生きてる', destUrl: 'https://p-bandai.jp/y/' })];
  const sec = offersSection(render({ feedItems: mixed }));
  assert.ok(sec.includes('生きてる'));
  assert.equal(sec.includes('受付終了'), false, '締切切れが混ざっている');
});

test('「いま応募できるもの」はランキングと最新情報を重複なくまとめる', () => {
  const item = makeItem({ id: 'same-id', title: '同じネタ', destUrl: 'https://p-bandai.jp/z/' });
  const sec = offersSection(render({ top: [item], feedItems: [item] }));
  const count = (sec.match(/class="offer/g) || []).length;
  // offer / offer__tags / offer__title / offer__when で1件あたり4回
  assert.ok(sec.includes('1件'), sec.slice(0, 200));
  assert.equal((sec.match(/<article class="offer/g) || []).length, 1, `重複している: ${count}`);
});

test('「いま応募できるもの」はランキングより前（統計のすぐ下）に出る', () => {
  const item = makeItem({ destUrl: 'https://p-bandai.jp/z/' });
  const html = render({ top: [item], feedItems: [item] });
  const iStats = html.indexOf('class="stats"');
  const iOffers = html.indexOf('<h2>🎯 いま応募できるもの');
  const iRank = html.indexOf('<h2>今日のランキング');
  assert.ok(iStats < iOffers && iOffers < iRank, `順序が違う: ${iStats} / ${iOffers} / ${iRank}`);
});

// ---------------------------------------------------------------------------
// XSS / エスケープ
// ---------------------------------------------------------------------------

test('HTMLエスケープが効いている（タイトル・店名・URL）', () => {
  const item = makeItem({
    title: '<script>alert("xss")</script>',
    destLabel: '<img src=x onerror=alert(1)>',
    sourceName: '"><script>bad()</script>',
    summary: '<b>要約</b>',
    intentTags: ['<script>t</script>'],
    destUrl: 'https://p-bandai.jp/item/1/?a=1&b=2',
  });
  const html = render({ top: [item], feedItems: [item] });

  assert.equal(html.includes('<script>alert'), false, 'タイトルがエスケープされていない');
  assert.equal(html.includes('<img src=x'), false, '店名がエスケープされていない');
  assert.equal(html.includes('<script>bad()'), false, '媒体名がエスケープされていない');
  assert.equal(html.includes('<b>要約</b>'), false, '要約がエスケープされていない');
  assert.ok(html.includes('&lt;script&gt;alert('), 'エスケープ後の文字列が無い');
  assert.ok(html.includes('?a=1&amp;b=2'), 'URLの & がエスケープされていない');
});

test('javascript: スキームの destUrl は無視される', () => {
  const item = makeItem({ destUrl: 'javascript:alert(1)', destLabel: 'わな' });
  const html = render({ top: [item], feedItems: [item] });
  assert.equal(html.includes('javascript:'), false, 'javascript: が出力された');
  assert.equal(html.includes('class="apply"'), false, '不正URLでボタンが出た');
  assert.equal(offersSection(html), '', '不正URLがセクションに入った');
});

test('esc / safeUrl の単体挙動', () => {
  assert.equal(esc('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  assert.equal(esc(null), '');
  assert.equal(safeUrl('https://example.com/a'), 'https://example.com/a');
  assert.equal(safeUrl('HTTPS://example.com'), 'HTTPS://example.com');
  assert.equal(safeUrl('javascript:alert(1)'), '');
  assert.equal(safeUrl('data:text/html,x'), '');
  assert.equal(safeUrl(null), '');
});

test('受付中と確認できていないものは「応募」ではなく「確認」と表示する', () => {
  // 店の一覧に載っていても抽選が締め切られていることがある。
  // 「応募できる」と書いて飛ばした先が期間外だと、利用者を裏切ることになる。
  const item = makeItem({
    destUrl: 'https://books.rakuten.co.jp/rb/18737983/',
    destLabel: '楽天ブックス',
    applyVerified: false,
  });
  const html = render({ top: [item], feedItems: [item] });

  assert.ok(html.includes('楽天ブックスで確認'), '「確認」表記になっていない');
  assert.ok(!html.includes('楽天ブックスで応募'), '未確認なのに「応募」と断定している');
  assert.ok(html.includes('https://books.rakuten.co.jp/rb/18737983/'), 'リンク自体は残すこと');
});
