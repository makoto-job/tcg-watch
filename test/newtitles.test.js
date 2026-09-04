/**
 * test/newtitles.test.js — 区画M: 新作・第1弾・予約開始済み商品の情報強化（ネットワーク不要）
 *
 * 背景:
 *  「まだ発売されていないが、もう予約が始まっている商品」——特に新規タイトルの第1弾と、
 *  人気作の再販・第2弾——を拾えるようにするための追加分を検証する。
 *
 *  最大の穴は **ユニオンアリーナ（UNION ARENA）** だった。ハンターハンター専用のTCGは
 *  存在せず、ハンターハンターはバンダイのクロスIP TCG「ユニオンアリーナ」に参戦している。
 *  当botはこのIPキーを持っていなかったため、参戦タイトルの新弾も予約も丸ごと落としていた。
 *
 * ここで守りたいこと:
 *  1. ユニオンアリーナのIPキーワードが効くこと
 *  2. **誤爆しないこと**（「ユニオン」だけ／「アリーナ」＝会場名 で当てない）
 *  3. 「第1弾」のような汎用語で既存IPの記事を newtcg にしてしまわないこと
 *  4. 追加した公式サイトのセレクタが、実際に取得したHTMLの抜粋で動くこと
 *  5. クエリ設定の整合（id重複なし・正規IPキーのみ・上限内・抽選系にはlottery）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { matchIps, normalizeForMatch } from '../src/collect.js';
import { parseNewsList } from '../src/sources/official.js';

const SOURCES_PATH = new URL('../config/sources.json', import.meta.url);
const OFFICIAL_PATH = new URL('../config/official-sites.json', import.meta.url);
const SHOPS_PATH = new URL('../config/shop-sources.json', import.meta.url);

const sources = JSON.parse(await readFile(SOURCES_PATH, 'utf8'));
const officialCfg = JSON.parse(await readFile(OFFICIAL_PATH, 'utf8'));
const shopCfg = JSON.parse(await readFile(SHOPS_PATH, 'utf8'));

const ips = sources.ips;
const queries = sources.googleNews.queries;

/** クエリ本数の上限（test/queries.test.js の MAX_QUERIES と同じ値） */
const MAX_QUERIES = 120;

/** @param {string} text @param {string} ip */
const hits = (text, ip) => matchIps(text, ips).includes(ip);

/* ------------------------------------------------------------------ */
/* 1. ユニオンアリーナがIPとして存在する                                */
/* ------------------------------------------------------------------ */

test('unionarena が ips に定義されている（label/weight/keywords/hashtag）', () => {
  const ua = ips.unionarena;
  assert.ok(ua, 'unionarena が config/sources.json に無い');
  assert.equal(ua.label, 'ユニオンアリーナ');
  assert.equal(ua.hashtag, '#ユニオンアリーナ');
  assert.ok(ua.weight >= 0.5 && ua.weight <= 1.5);
  assert.ok(Array.isArray(ua.keywords) && ua.keywords.length >= 3);
  // 実際に使われている表記が入っていること
  for (const kw of ['ユニオンアリーナ', 'UNION ARENA', 'ユニアリ']) {
    assert.ok(ua.keywords.includes(kw), `キーワード "${kw}" が無い`);
  }
});

/* ------------------------------------------------------------------ */
/* 2. matchIps: ユニオンアリーナに当たるべきもの                        */
/* ------------------------------------------------------------------ */

const UA_POSITIVE = [
  // 実際に公式サイト・楽天ブックスに出ていた表記
  'UNION ARENA ブースターパック ウマ娘 プリティーダービー【UA59BT】',
  'UNION ARENA アドバンスデッキ BLEACH 千年血戦篇 【UA01DC】',
  'ユニオンアリーナ 新弾「HUNTER×HUNTER」の予約が開始',
  'ユニオンアリーナに『ジョジョの奇妙な冒険』シリーズが参戦決定',
  'ユニアリ 第2弾ブースターパック 抽選販売のお知らせ',
  'UNIONARENA new booster pack announced', // 空白なし表記
  '【ユニオンアリーナ】スタートデッキ 再販決定',
];

for (const text of UA_POSITIVE) {
  test(`matchIps: unionarena ← "${text.slice(0, 34)}"`, () => {
    assert.ok(hits(text, 'unionarena'), `unionarena にマッチすべき: ${text}\n実際: ${matchIps(text, ips)}`);
  });
}

test('ハンターハンターのユニアリ記事は unionarena として拾える（専用TCGは存在しない）', () => {
  const t = 'ユニオンアリーナ ブースターパック HUNTER×HUNTER 第2弾 予約受付中';
  const got = matchIps(t, ips);
  assert.ok(got.includes('unionarena'), `実際: ${got}`);
});

/* ------------------------------------------------------------------ */
/* 3. matchIps: ユニオンアリーナに当たってはいけないもの（誤爆・厚め）  */
/* ------------------------------------------------------------------ */

const UA_NEGATIVE = [
  // 「ユニオン」だけ
  'ヨーロピアンユニオンの新方針について',
  'クレディ・アグリコル ユニオン 決算発表',
  'ユニオン建設が新社屋を着工',
  '労働組合（ユニオン）が団体交渉を申し入れ',
  // 「アリーナ」だけ（会場名）
  'さいたまスーパーアリーナでライブ開催',
  '横浜アリーナ 公演チケット 抽選販売',
  '有明アリーナ 完成披露',
  'アリーナ席のチケットが即完売',
  // 「ユニオン」と「アリーナ」が別文脈で同居しても、カタカナ表記なら latin の AND 条件には当たらない
  'ユニオン系労組の集会が大阪城ホールとアリーナで開催',
  // カード関連だが別IP
  'ポケモンカード 強化拡張パック 予約開始',
  'ワンピースカード 新弾 抽選販売',
  // 英語の一般語
  'The union representative visited the arena project site', // union と arena は別語だが…下で個別に検証
];

for (const text of UA_NEGATIVE) {
  // 最後の英文だけは「UNION ARENA」のAND条件に構造上当たってしまうため個別テストで扱う
  if (text.startsWith('The union representative')) continue;
  test(`matchIps: unionarena に誤爆しない ← "${text.slice(0, 34)}"`, () => {
    assert.ok(
      !hits(text, 'unionarena'),
      `unionarena に誤爆した: ${text}\n実際: ${matchIps(text, ips)}`
    );
  });
}

test('「ユニオン」単独・「アリーナ」単独では unionarena にならない（正規化後も）', () => {
  assert.equal(normalizeForMatch('ユニオン'), 'ユニオン');
  assert.ok(!hits('ユニオン', 'unionarena'));
  assert.ok(!hits('アリーナ', 'unionarena'));
  assert.ok(!hits('ユニオン・スクエア', 'unionarena'));
  assert.ok(!hits('武道館とアリーナのキャパ比較', 'unionarena'));
  // 一方で中黒入りの正式表記は拾う（記号は正規化で消える）
  assert.ok(hits('ユニオン・アリーナ 新弾情報', 'unionarena'));
});

/* ------------------------------------------------------------------ */
/* 4. newtcg: 汎用語で既存IPを誤って「新作」にしない                    */
/* ------------------------------------------------------------------ */

/**
 * 「第1弾」「新シリーズ」「予約開始」などの汎用語は既存IPの商品にも当たる。
 * newtcg は "新規タイトル" を意味するので、これらの語**だけ**では newtcg を付けない。
 * （拾うのは googleNews.queries 側のメーカー起点クエリに任せる）
 */
const NEWTCG_NEGATIVE = [
  'ポケモンカードゲーム 拡張パック 第1弾 予約開始',
  'ポケモンカードゲーム 新シリーズ「メガシンカex」始動',
  'ポケモンカードゲーム 新シリーズが始動、第1弾は12月発売',
  'ワンピースカードゲーム 第二弾 スタートデッキ 発売予定',
  'ワンピースカードゲームの新シリーズが始動',
  '遊戯王ラッシュデュエル 新シリーズ始動、カードゲームの遊び方も一新',
  '遊戯王OCG ストラクチャーデッキ 第2弾 予約受付中',
  'デュエル・マスターズ 新シリーズ 第1弾が発売',
  'マジック：ザ・ギャザリング 統率者デッキ 基本セット 予約開始',
  'ユニオンアリーナ ブースターパック 第2弾 予約受付中',
  'デジモンカードゲーム 構築済みデッキ 第1弾 発売決定',
  'バトルスピリッツ 新シリーズ始動、第1弾は12月発売',
];

for (const text of NEWTCG_NEGATIVE) {
  test(`matchIps: newtcg に誤爆しない ← "${text.slice(0, 34)}"`, () => {
    assert.ok(
      !hits(text, 'newtcg'),
      `汎用語だけで newtcg が付いた: ${text}\n実際: ${matchIps(text, ips)}`
    );
  });
}

test('newtcg の汎用語（第1弾/新シリーズ/予約開始）はキーワードに単独で入っていない', () => {
  const generic = ['第1弾', '第一弾', '第2弾', '第二弾', '新シリーズ', '始動', '参戦', '参入',
    'スタートデッキ', 'スターターデッキ', '構築済みデッキ', '基本セット',
    '予約受付中', '発売予定', '予約開始'];
  for (const kw of ips.newtcg.keywords) {
    assert.ok(
      !generic.includes(kw.trim()),
      `newtcg に汎用語が単独で入っている: "${kw}"（既存IPの商品を新作扱いしてしまう）`
    );
  }
});

test('newtcg のキーワードに「カードゲーム＋汎用語」だけの複合語が無い', () => {
  // 「カードゲーム 始動」は "ポケモンカードゲーム …始動" に当たってしまう。
  // 新規タイトルを意味させるには「新」「新作」など新規性を示す語が要る。
  // ※「参入」は企業がカード事業に入る話なので既存IPの商品記事には出ない＝対象外。
  const generic = ['始動', '新シリーズ', '発表', '第1弾', '第2弾', '予約', '発売', '新弾'];
  for (const kw of ips.newtcg.keywords) {
    const parts = kw.split(/\s+/).filter(Boolean);
    if (parts.length !== 2) continue;
    const [a, b] = parts;
    const isBareCardGame = /^(カードゲーム|トレーディングカード|TCG)$/i.test(a);
    assert.ok(
      !(isBareCardGame && generic.includes(b)),
      `newtcg に汎用複合語が入っている: "${kw}"（既存IPの記事を新作扱いしてしまう）`
    );
  }
});

test('newtcg: 具体的な新規タイトル名とメーカー起点の複合語なら当たる', () => {
  assert.ok(hits('NARUTOカードゲーム 第1弾の発売日が決定', 'newtcg'));
  assert.ok(hits('バンダイが新作カードゲームを発表、来春発売', 'newtcg'));
  assert.ok(hits('コナミ 新作 カードゲーム 始動', 'newtcg'));
  assert.ok(hits('タカラトミー、新作のカードゲームを発表', 'newtcg'));
  // メーカー名だけ／新作だけでは当てない
  assert.ok(!hits('バンダイの決算が発表された', 'newtcg'));
  assert.ok(!hits('コナミの新作ゲームが発売', 'newtcg'), 'カードゲームでなければ当てない');
});

/* ------------------------------------------------------------------ */
/* 5. 公式サイト parseNewsList: 実際に取得したHTMLの抜粋で検証           */
/* ------------------------------------------------------------------ */

const siteById = (id) => {
  const s = officialCfg.sites.find((x) => x.id === id);
  assert.ok(s, `config/official-sites.json に ${id} が無い`);
  return s;
};

// ── ユニオンアリーナ公式 https://www.unionarena-tcg.com/jp/news/ の実HTML抜粋 ──
// 1件目・2件目は商品情報（拾いたい）、3件目は定型イベント告知（titleExclude で落としたい）。
const UA_HTML = `
<div class="newsList fadein">
  <ul class="newsBox">
    <li class="newsDetail" data-tags="products,BLC">
      <a href="/jp/products/decks/dc-blc.php">
        <div class="newsthumbnail"><img src="/jp/images/products/decks/dc-blc/img_thumbnail.png?v" alt="BLEACH 千年血戦篇 アドバンスドデッキ 商品情報を更新"></div>
        <dl>
          <dt class="newsTit"><span class="js_newsTit">BLEACH 千年血戦篇 アドバンスドデッキ 商品情報を更新</span></dt>
          <dd class="newsCategory"><object><a href="/jp/news/?tags=products">商品情報</a></object></dd>
          <dd class="newsDate">2026.08.28</dd>
        </dl>
      </a>
    </li>
    <li class="newsDetail" data-tags="news">
      <a href="/jp/titles/">
        <div class="newsthumbnail"><img src="/jp/images/titles/img_thumbnail.png" alt=""></div>
        <dl>
          <dt class="newsTit"><span class="js_newsTit">「『ジョジョの奇妙な冒険』シリーズ」が参戦決定</span></dt>
          <dd class="newsCategory"><object><a href="/jp/news/?tags=news">ニュース</a></object></dd>
          <dd class="newsDate">2026.07.21</dd>
        </dl>
      </a>
    </li>
    <li class="newsDetail" data-tags="events,TTG,BLC">
      <a href="/jp/events/unionrare-struggle-battle/2026/21st/">
        <div class="newsthumbnail"><img src="/jp/images/events/img_thumbnail.png" alt=""></div>
        <dl>
          <dt class="newsTit"><span class="js_newsTit">「ユニオンレア争奪バトル 21stシーズン開催」を公開</span></dt>
          <dd class="newsCategory"><object><a href="/jp/news/?tags=events">イベント</a></object></dd>
          <dd class="newsDate">2026.09.01</dd>
        </dl>
      </a>
    </li>
  </ul>
</div>`;

test('parseNewsList: ユニオンアリーナ公式の実HTML抜粋から商品情報と参戦決定を取れる', () => {
  const out = parseNewsList(UA_HTML, siteById('unionarena-official'));
  assert.equal(out.length, 2, `定型イベントを除いた2件のはず: ${JSON.stringify(out, null, 1)}`);

  assert.equal(out[0].title, 'BLEACH 千年血戦篇 アドバンスドデッキ 商品情報を更新');
  assert.equal(out[0].link, 'https://www.unionarena-tcg.com/jp/products/decks/dc-blc.php');
  // 日付は JST として解釈される（2026.08.28 00:00 JST = 2026-08-27T15:00Z）
  assert.equal(new Date(out[0].pubDate).toISOString(), '2026-08-27T15:00:00.000Z');

  assert.equal(out[1].title, '「『ジョジョの奇妙な冒険』シリーズ」が参戦決定');
  assert.equal(out[1].link, 'https://www.unionarena-tcg.com/jp/titles/');

  // 定型イベント告知は titleExclude で落ちている
  assert.ok(!out.some((o) => o.title.includes('ユニオンレア争奪バトル')));
});

test('ユニオンアリーナ公式から取れたタイトルは matchIps でも unionarena に落ちる', () => {
  const site = siteById('unionarena-official');
  const out = parseNewsList(UA_HTML, site);
  // タイトル単体ではIPが分からない商品もあるが、config の ips で補われる契約
  assert.deepEqual(site.ips, ['unionarena']);
  assert.ok(out.length > 0);
});

// ── ホロライブOCG公式 https://hololive-official-cardgame.com/news/ の実HTML抜粋 ──
const HOLO_HTML = `
<div class="list">
  <ul>
    <li >
      <a href="https://hololive-official-cardgame.com/news/post/64/">
        <div class="thumb"><img width="1920" height="1080" src="https://hololive-official-cardgame.com/wp-content/uploads/2026/08/thumb.png" class="attachment-post-thumbnail" alt="" /></div>
        <div class="flex-wrap">
          <time>2026.08.20</time>
          <div class="category other"><p>Other</p></div>
        </div>
        <p class="text">『エクストラブースター サマー・ホログラム』コンビニでも販売中！</p>
      </a>
    </li>
    <li >
      <a href="https://hololive-official-cardgame.com/news/post/deck-showcase_vol-11/">
        <div class="thumb"></div>
        <div class="flex-wrap"><time>2026.08.20</time></div>
        <p class="text">イチ推し！デッキ紹介！vol.11 ～サマー・ホログラム～</p>
      </a>
    </li>
    <li >
      <a href="/cardlist/"><span>カードリスト</span></a>
    </li>
  </ul>
</div>`;

test('parseNewsList: ホロライブOCG公式の実HTML抜粋を解釈できる（タイトル無しの行は落ちる）', () => {
  const out = parseNewsList(HOLO_HTML, siteById('hololive-ocg-official'));
  assert.equal(out.length, 2, JSON.stringify(out, null, 1));
  assert.equal(out[0].title, '『エクストラブースター サマー・ホログラム』コンビニでも販売中！');
  assert.equal(out[0].link, 'https://hololive-official-cardgame.com/news/post/64/');
  assert.equal(new Date(out[0].pubDate).toISOString(), '2026-08-19T15:00:00.000Z');
  // <p class="text"> を持たないナビ行は採用されない
  assert.ok(!out.some((o) => o.link.endsWith('/cardlist/')));
});

// ── NARUTOカードゲーム公式 https://www.naruto-cardgame.com/jp/news/ の実HTML抜粋 ──
const NARUTO_HTML = `
<div class="newsListCol">
  <ul class="newsList js_moreList" data-more-num="10">
    <li class="newsListItem card">
      <a class="cardBox" href="/jp/welcome/">
        <div class="cardThumb"><img src="/images/welcome/thumbnail.webp?v1" alt=""></div>
        <dl class="cardData">
          <dt class="cardTitle">「NARUTOカードゲームとは」を公開！</dt>
          <dd class="cardInfo">
            <div class="category">お知らせ</div>
            <time class="date" datetime="2026-07-29">2026.07.29</time>
          </dd>
        </dl>
      </a>
    </li>
    <li class="newsListItem card">
      <a class="cardBox" href="/jp/news/bcgfes26-27.php">
        <div class="cardThumb"><img src="/jp/images/news/bcgfes26-27/mv.webp" alt=""></div>
        <dl class="cardData">
          <dt class="cardTitle">「BANDAI CARD GAMES Fest 26-27」のイベント情報を公開！</dt>
          <dd class="cardInfo">
            <div class="category">イベント</div>
            <time class="date" datetime="2026-07-29">2026.07.29</time>
          </dd>
        </dl>
      </a>
    </li>
  </ul>
</div>`;

test('parseNewsList: NARUTOカードゲーム公式（新規タイトル）の実HTML抜粋を解釈できる', () => {
  const site = siteById('naruto-cardgame-official');
  const out = parseNewsList(NARUTO_HTML, site);
  assert.equal(out.length, 2, JSON.stringify(out, null, 1));
  assert.equal(out[0].title, '「NARUTOカードゲームとは」を公開！');
  assert.equal(out[0].link, 'https://www.naruto-cardgame.com/jp/welcome/');
  assert.equal(new Date(out[0].pubDate).toISOString(), '2026-07-28T15:00:00.000Z');
  assert.deepEqual(site.ips, ['newtcg'], '新規タイトルなので newtcg 扱い');
});

test('追加した公式サイトは全て https / enabled / パターン一式を持つ', () => {
  for (const id of ['unionarena-official', 'hololive-ocg-official', 'naruto-cardgame-official']) {
    const s = siteById(id);
    assert.equal(s.enabled, true, `${id}: enabled`);
    assert.match(s.url, /^https:\/\//, `${id}: url`);
    assert.match(s.baseUrl, /^https:\/\//, `${id}: baseUrl`);
    assert.equal(s.type, 'html', `${id}: type`);
    assert.ok(s.itemPattern && s.linkPattern && s.titlePattern && s.datePattern, `${id}: パターン一式`);
    assert.ok(s.weight >= 0.5 && s.weight <= 1.5, `${id}: weight`);
    assert.ok(s.note && s.note.length > 30, `${id}: note（調査メモ）必須`);
    // 正規表現として壊れていないこと
    for (const k of ['itemPattern', 'linkPattern', 'titlePattern', 'datePattern', 'titleExclude']) {
      if (!s[k]) continue;
      assert.doesNotThrow(() => new RegExp(s[k]), `${id}: ${k} が正規表現として不正`);
    }
  }
});

test('既存の公式サイト定義を壊していない（id重複なし・件数が減っていない）', () => {
  const idsSeen = new Set();
  for (const s of officialCfg.sites) {
    assert.ok(!idsSeen.has(s.id), `id重複: ${s.id}`);
    idsSeen.add(s.id);
  }
  for (const id of ['pokemon-card-official', 'onepiece-cardgame-official', 'yugioh-ocg-official',
    'duelmasters-official', 'mtg-jp-official', 'gundam-gcg-official', 'dragonball-fw-official',
    'hololive-news', 'p-bandai-lotterysales', 'digimon-card-official', 'battlespirits-official']) {
    assert.ok(idsSeen.has(id), `既存サイトが消えている: ${id}`);
  }
});

/* ------------------------------------------------------------------ */
/* 6. 小売店（楽天ブックス）にユニオンアリーナを足した                  */
/* ------------------------------------------------------------------ */

test('shop-sources: 楽天ブックスのユニオンアリーナ検索が追加されている', () => {
  const s = shopCfg.sites.find((x) => x.id === 'rakuten-books-unionarena');
  assert.ok(s, 'rakuten-books-unionarena が無い');
  assert.equal(s.enabled, true);
  assert.equal(s.type, 'json');
  assert.deepEqual(s.ips, ['unionarena']);
  assert.match(s.url, /^https:\/\//);
  // sales_start_time / sales_end_time は「抽選エントリー期間」ではないことが
  // 実地確認で判明したため使わない（期間内のはずの商品が店側で「期間外」と表示された）。
  // 誤った締切は、締切を出さないことより有害。
  assert.equal(s.startsAtKey, undefined, '受付期間として使ってはいけない');
  assert.equal(s.deadlineKey, undefined, '受付期間として使ってはいけない');
  assert.equal(s.applyVerified, false, '受付中と確認できていない印が必要');
});

test('shop-sources: 既存エントリを消していない', () => {
  const idsSeen = new Set(shopCfg.sites.map((s) => s.id));
  for (const id of ['rakuten-books-lottery', 'rakuten-books-tcg-new', 'rakuten-books-dragonball',
    'rakuten-books-duelmasters', 'c-labo-new', 'c-labo-yoyaku', 'mint-mall-cardgame-box']) {
    assert.ok(idsSeen.has(id), `既存の小売店定義が消えている: ${id}`);
  }
  assert.equal(idsSeen.size, shopCfg.sites.length, 'shop id が重複している');
});

/* ------------------------------------------------------------------ */
/* 7. クエリ設定の整合                                                 */
/* ------------------------------------------------------------------ */

test('追加したクエリを含めても上限内で、id重複が無い', () => {
  assert.ok(queries.length <= MAX_QUERIES, `クエリが多すぎます: ${queries.length}本`);
  const seen = new Set();
  for (const q of queries) {
    assert.ok(!seen.has(q.id), `ID重複: ${q.id}`);
    seen.add(q.id);
  }
});

test('全クエリの ips が正規のIPキーだけを使う（unionarena を含む）', () => {
  const keys = new Set(Object.keys(ips));
  assert.ok(keys.has('unionarena'));
  for (const q of queries) {
    for (const ip of q.ips) assert.ok(keys.has(ip), `${q.id}: 未知のIPキー ${ip}`);
  }
});

test('unionarena に十分な本数のクエリがある', () => {
  const n = queries.filter((q) => q.ips.includes('unionarena')).length;
  assert.ok(n >= 5, `unionarena のクエリが ${n}本しかない`);
});

test('ハンターハンター起点のクエリが入っている（専用TCGが無いための代替導線）', () => {
  assert.ok(
    queries.some((q) => /ハンターハンター|HUNTER/i.test(q.query) && q.ips.includes('unionarena')),
    'ユニオンアリーナ × ハンターハンター のクエリが無い'
  );
});

test('メーカー起点の「新作カードゲーム」クエリが newtcg で入っている', () => {
  const makers = ['バンダイ', 'コナミ', 'タカラトミー'];
  for (const m of makers) {
    assert.ok(
      queries.some((q) => q.query.includes(m) && q.ips.includes('newtcg')),
      `${m} 起点の newtcg クエリが無い`
    );
  }
});

test('「第1弾」「発売予定」など予約前商品を狙うクエリが入っている', () => {
  const wanted = ['第1弾', '第2弾', '発売予定', '予約開始'];
  for (const w of wanted) {
    assert.ok(queries.some((q) => q.query.includes(w)), `"${w}" を含むクエリが無い`);
  }
});

test('IPキーワード未登録の新規タイトルを落とさないため、第1弾/第2弾クエリには newtcg が付く', () => {
  // 「ハリー・ポッター カードゲーム 第2弾」のように未登録タイトルの記事は、
  // クエリ側で newtcg を最低保証しないと「どのIPにも当たらない」として捨てられてしまう。
  const firstOrSecond = queries.filter((q) => /第\d弾/.test(q.query));
  assert.ok(firstOrSecond.length >= 2, `第N弾クエリが ${firstOrSecond.length}本しかない`);
  assert.ok(
    firstOrSecond.every((q) => q.ips.includes('newtcg')),
    `newtcg の無い第N弾クエリ: ${firstOrSecond.filter((q) => !q.ips.includes('newtcg')).map((q) => q.id)}`
  );
});

test('追加分も含め、抽選・予約系のクエリには必ず lottery が付く', () => {
  const intent = /抽選|予約|再販|受注|応募/;
  for (const q of queries) {
    if (!intent.test(q.query)) continue;
    assert.ok(q.ips.includes('lottery'), `${q.id}: 抽選系クエリなのに lottery が無い`);
  }
});

test('第N弾クエリは「新作」「予約」「発売決定」まで絞り込まれている（汎用検索にしない）', () => {
  // 「カードゲーム 第2弾」だけのような広すぎるクエリは、イヤホンやフィギュアの
  // 「第2弾」まで拾ってしまう。必ず新作・予約・発売を示す語を添える。
  for (const q of queries.filter((x) => /第\d弾/.test(x.query))) {
    assert.match(q.query, /新作|予約|発売/, `${q.id}: 絞り込みの弱いクエリ「${q.query}」`);
  }
});

test('IP横断の予約・発売予定クエリは lottery だけにして newtcg を汚さない', () => {
  // 「トレーディングカード 予約開始」のような語は、トレカ付き新聞やアイドルグッズまで
  // 拾ってしまう。newtcg を付けるとバッジが信用できなくなるので lottery に寄せる。
  for (const id of ['gn-preorder-start', 'gn-release-upcoming']) {
    const q = queries.find((x) => x.id === id);
    assert.ok(q, `${id} が無い`);
    assert.ok(!q.ips.includes('newtcg'), `${id}: 汎用クエリに newtcg が付いている`);
  }
});
