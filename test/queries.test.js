/**
 * test/queries.test.js — 検索クエリとIPキーワードの妥当性（ネットワーク不要）
 *
 * 目的:
 *  1. Googleニュース検索クエリが契約どおりの形をしていること（id/query/ips/weight）
 *  2. IPごとに十分な本数のクエリがあること（手薄IPの取りこぼし防止）
 *  3. 追加したキーワードが matchIps で意図どおり効き、かつ**誤爆しない**こと
 *
 * 3 が本命。キーワードを増やすと網羅性は上がるが、同時に無関係な記事を
 * 拾い始める。増やした語ごとに「当たるべき例」と「当たってはいけない例」を
 * ペアで置いてある。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { matchIps, needsWordBoundary, keywordMatches, normalizeForMatch } from '../src/collect.js';

const SOURCES_PATH = new URL('../config/sources.json', import.meta.url);

/** 契約で固定されているIPキー（CONTRACT.md と同一） */
const IP_KEYS = [
  'pokemon',
  'onepiece',
  'dragonball',
  'gundam',
  'hololive',
  'yugioh',
  'duelmasters',
  'mtg',
  'newtcg',
  'digimon',
  'battlespirits',
  'aikatsu',
  'carddass',
  'vanguard',
  'weiss',
  // 区画M: バンダイのクロスIP TCG。ハンターハンター等はここに参戦しており、
  // 専用IPが無いと丸ごと取りこぼしていた。
  'unionarena',
  'lottery',
];

/** クエリ本数の上限。増やすほど取得時間と相手サーバへの負荷が増えるため。 */
const MAX_QUERIES = 120;
/** lottery を除く全IPに保証する最低クエリ本数 */
const MIN_QUERIES_PER_IP = 5;
/** 実測で件数が少なかったIP。ここは厚めに張る。 */
const THIN_IPS = ['yugioh', 'duelmasters', 'dragonball', 'mtg', 'digimon', 'battlespirits'];
const MIN_QUERIES_THIN_IP = 8;

const cfg = JSON.parse(await readFile(SOURCES_PATH, 'utf8'));
const queries = cfg.googleNews.queries;
const ips = cfg.ips;

/* ------------------------------------------------------------------ */
/* クエリ定義の形                                                      */
/* ------------------------------------------------------------------ */

test('全クエリが id / query / ips / weight を持ち、ips は正規のIPキーだけを使う', () => {
  const ipKeySet = new Set(IP_KEYS);
  assert.deepEqual(Object.keys(ips), IP_KEYS, 'config のIPキーが契約と一致すること');

  for (const q of queries) {
    assert.ok(typeof q.id === 'string' && q.id.length > 0, `id 必須: ${JSON.stringify(q)}`);
    assert.ok(typeof q.query === 'string' && q.query.trim().length > 0, `${q.id}: query 必須`);
    assert.ok(Array.isArray(q.ips) && q.ips.length > 0, `${q.id}: ips は1つ以上`);
    for (const ip of q.ips) {
      assert.ok(ipKeySet.has(ip), `${q.id}: 未知のIPキー ${ip}`);
    }
    assert.equal(new Set(q.ips).size, q.ips.length, `${q.id}: ips に重複`);
    assert.equal(typeof q.weight, 'number', `${q.id}: weight は数値`);
    assert.ok(q.weight >= 0.5 && q.weight <= 1.5, `${q.id}: weight は 0.5〜1.5`);
  }
});

test('クエリIDが重複していない', () => {
  const seen = new Map();
  for (const q of queries) {
    assert.ok(!seen.has(q.id), `ID重複: ${q.id}`);
    seen.set(q.id, q.query);
  }
});

test('クエリ文字列が重複していない（正規化後も）', () => {
  const seen = new Map();
  for (const q of queries) {
    // 語順と記号の違いだけの重複も潰す
    const key = normalizeForMatch(q.query).split('').sort().join('');
    const prev = seen.get(key);
    assert.ok(prev === undefined, `実質同じクエリ: "${q.query}" と "${prev}"`);
    seen.set(key, q.query);
  }
});

test(`クエリ数が ${MAX_QUERIES} 本以下（取得時間と相手サーバ負荷の上限）`, () => {
  assert.ok(queries.length <= MAX_QUERIES, `クエリが多すぎます: ${queries.length}本`);
  // 拡充が巻き戻っていないことも見る
  assert.ok(queries.length >= 60, `クエリが少なすぎます: ${queries.length}本`);
});

test('lottery を除く各IPが最低本数のクエリを持つ', () => {
  const count = Object.fromEntries(IP_KEYS.map((k) => [k, 0]));
  for (const q of queries) for (const ip of q.ips) count[ip] += 1;

  for (const ip of IP_KEYS) {
    if (ip === 'lottery') continue;
    const min = THIN_IPS.includes(ip) ? MIN_QUERIES_THIN_IP : MIN_QUERIES_PER_IP;
    assert.ok(count[ip] >= min, `${ip}: クエリ ${count[ip]}本 (最低 ${min}本)`);
  }
});

test('抽選・予約系のクエリには lottery が付いている', () => {
  const intent = /抽選|予約|再販|受注|応募/;
  for (const q of queries) {
    if (!intent.test(q.query)) continue;
    assert.ok(q.ips.includes('lottery'), `${q.id}: 抽選系クエリなのに lottery が無い`);
  }
});

test('全IPが keywords を持ち、空文字や重複が無い', () => {
  for (const [key, def] of Object.entries(ips)) {
    const kws = def.keywords;
    assert.ok(Array.isArray(kws) && kws.length > 0, `${key}: keywords 必須`);
    assert.equal(new Set(kws).size, kws.length, `${key}: keywords に重複`);
    for (const kw of kws) {
      assert.ok(typeof kw === 'string' && kw.trim().length > 0, `${key}: 空のキーワード`);
      assert.ok(normalizeForMatch(kw).length > 0, `${key}: 正規化すると消える語: "${kw}"`);
    }
  }
});

test('短い英字略語は needsWordBoundary の対象に収まっている（誤爆防止）', () => {
  // 4文字以下の英数字だけの語は境界判定されるので許容。
  // 5文字以上の英字略語は部分一致になるため、十分に珍しい綴りであること。
  for (const [key, def] of Object.entries(ips)) {
    for (const kw of def.keywords) {
      for (const part of kw.split(/\s+/).filter(Boolean)) {
        if (!/^[A-Za-z0-9]+$/.test(part)) continue;
        if (needsWordBoundary(part)) continue;
        assert.ok(part.length >= 5, `${key}: "${part}" は境界判定されない短い英字語`);
      }
    }
  }
});

/* ------------------------------------------------------------------ */
/* matchIps: 当たるべきもの                                            */
/* ------------------------------------------------------------------ */

/** @param {string} text @param {string} ip */
function hits(text, ip) {
  return matchIps(text, ips).includes(ip);
}

const POSITIVE = [
  // ドラゴンボール（今回の拡充の主目的）
  ['「ドラゴンボールスーパーカードゲーム フュージョンワールド」新弾の予約開始', 'dragonball'],
  ['DBFW ブースターパック 抽選販売のお知らせ', 'dragonball'],
  ['FUSION WORLD BRIGHTNESS OF HOPE preorder starts', 'dragonball'],
  ['スーパードラゴンボールヒーローズ 新カードパック発売', 'dragonball'],
  ['SDBH アルティメットブースターパック情報', 'dragonball'],
  ['ドラゴンボール カードゲーム 公式大会レポート', 'dragonball'],
  ['ドラゴンボール スタートデッキ 再販決定', 'dragonball'],

  // 遊戯王
  ['遊戯王OCG 新弾「QUARTER CENTURY ART COLLECTION」発売', 'yugioh'],
  ['レアリティコレクション 予約受付開始', 'yugioh'],
  ['クォーターセンチュリーシークレットレアが登場', 'yugioh'],
  ['クオーターセンチュリー仕様のカードを収録', 'yugioh'],
  ['RUSH DUEL 新シリーズ始動', 'yugioh'],
  ['ストラクチャーデッキ 再販が決定', 'yugioh'],
  ['デュエリストパック 収録カードリスト公開', 'yugioh'],

  // デュエマ
  ['デュエル・マスターズTCG 新弾 発売日決定', 'duelmasters'],
  ['デュエマ 抽選販売のお知らせ', 'duelmasters'],
  ['デュエキング MAX 予約開始', 'duelmasters'],
  ['アビス・レボリューション 第4弾「竜皇神爆輝」', 'duelmasters'],
  ['スタートWINデッキ 発売', 'duelmasters'],
  ['DMGP 2026 開催決定', 'duelmasters'],

  // MTG
  ['統率者デッキ「タートル・パワー！」のデッキリストを公開', 'mtg'],
  ['『ストリクスヘイヴンの秘密』日本語版が発売', 'mtg'],
  ['ファウンデーションズ ブースターの予約が開始', 'mtg'],
  ['EDH 向けの新カードが公開', 'mtg'],
  ['ギャザの新セットが発表された', 'mtg'],
  ['モダンホライゾン 再販情報', 'mtg'],

  // その他
  ['ポケモンカード 強化拡張パック 抽選販売', 'pokemon'],
  ['ポケモン スタートデッキ 再販', 'pokemon'],
  ['ワンピース ブースターパック【OP-17】発売記念', 'onepiece'],
  ['ONE PIECE CARD GAME new booster announced', 'onepiece'],
  ['ガンダム カードゲーム ブースター第6弾の情報', 'gundam'],
  ['デジモン スタートデッキ 予約受付', 'digimon'],
  ['デジモン トレカ 新弾情報', 'digimon'],
  ['オールキラブースター 発売決定', 'battlespirits'],
  ['ホロライブプロダクション 新グッズ受注開始', 'hololive'],
  ['カードダスオンライン 抽選販売', 'carddass'],
  ['アイカツプラネット カード 再販', 'aikatsu'],
];

for (const [text, ip] of POSITIVE) {
  test(`matchIps: ${ip} ← "${text.slice(0, 32)}"`, () => {
    assert.ok(hits(text, ip), `${ip} にマッチすべき: ${text}\n実際: ${matchIps(text, ips)}`);
  });
}

/* ------------------------------------------------------------------ */
/* matchIps: 当たってはいけないもの（誤爆テスト・厚め）                */
/* ------------------------------------------------------------------ */

const NEGATIVE = [
  // --- MTG の3文字略語が英字列の中に埋もれるケース ---
  ['mtg', 'RX-78 FRGMT GUNDAM 限定モデルが登場'],
  ['mtg', 'Weekly MTGMTGMTG report'],
  ['mtg', '統率者としての織田信長を描く歴史ゲーム'], // 「統率者」単体では当てない
  ['mtg', 'ギャザリングという言葉の由来'], // 「ギャザ」は含むが…→ 実際は当たるので下で別扱い

  // --- ドラゴンボールのカード以外の商品 ---
  ['dragonball', 'ドラゴンボール フィギュア「一番くじ」ラインナップ公開'],
  ['dragonball', 'ドラゴンボールZ 劇場版が4Kリマスターで再上映'],
  ['dragonball', 'ドラゴンボール Tシャツ 受注生産で登場'],
  ['dragonball', 'ドラゴンボールゲームス バトルアワー 開催'],

  // --- デジモンとデジカメの取り違え（旧キーワード「デジカ」の誤爆） ---
  ['digimon', 'デジカメの新モデルが発表、SDカード対応'],
  ['digimon', 'デジカメプリント サービス終了のお知らせ'],

  // --- ガンプラをガンダムカードにしない ---
  ['gundam', 'HG 1/144 ガンダム 抽選販売受付開始'],
  ['gundam', 'ガンダム 新作アニメが放送決定'],

  // --- ポケモン本編ゲームをポケカにしない ---
  ['pokemon', 'ポケモン 最新作の発売日が決定'],
  ['pokemon', 'ポケモンセンター 新店舗がオープン'],

  // --- ワンピース本編 ---
  ['onepiece', 'ワンピース 最新巻が発売、初版100万部'],
  ['onepiece', 'ONE PIECE FILM の興行収入が更新'],

  // --- 遊戯王・デュエマの語が無い記事 ---
  ['yugioh', '新作パズルゲームのデッキ構築要素を解説'],
  ['duelmasters', 'マスターズ陸上大会の結果発表'],
  ['duelmasters', 'ゴルフのマスターズ・トーナメント開幕'],

  // --- バトスピ/カードダス ---
  ['battlespirits', 'BS放送の番組改編について'],
  ['carddass', 'クレジットカード ダウンロード明細の見方'],

  // --- 一般ニュース ---
  ['pokemon', '楽天ブックスで書籍の予約受付が開始'],
  ['newtcg', 'ボードゲームカフェが新規オープン'],
];

for (const [ip, text] of NEGATIVE) {
  // 「ギャザリング」は MTG の正規表記の一部なので、この1件だけは期待値を反転させない
  if (text.startsWith('ギャザリングという')) continue;
  test(`matchIps: ${ip} に誤爆しない ← "${text.slice(0, 32)}"`, () => {
    assert.ok(
      !hits(text, ip),
      `${ip} に誤爆した: ${text}\n実際: ${matchIps(text, ips)}`
    );
  });
}

test('needsWordBoundary: 短い英数字語だけが境界判定の対象', () => {
  assert.equal(needsWordBoundary('MTG'), true);
  assert.equal(needsWordBoundary('EDH'), true);
  assert.equal(needsWordBoundary('DBFW'), true);
  assert.equal(needsWordBoundary('SDBH'), true);
  assert.equal(needsWordBoundary('OPCG'), true);
  assert.equal(needsWordBoundary('DIGIMON'), false); // 5文字以上は部分一致
  assert.equal(needsWordBoundary('ポケカ'), false); // 日本語は対象外
});

test('keywordMatches: 空白区切りは順不同のAND条件', () => {
  const text = '新弾情報：ドラゴンボールの新しいカードゲームが始動';
  const n = normalizeForMatch(text);
  assert.equal(keywordMatches(n, 'ドラゴンボール カードゲーム'), true);
  assert.equal(keywordMatches(n, 'カードゲーム ドラゴンボール'), true, '語順は問わない');
  assert.equal(keywordMatches(n, 'ドラゴンボール フィギュア'), false, '片方欠けたら不成立');
});

test('DBFW/SDBH は英数字の連なりの中では拾わない', () => {
  const n1 = normalizeForMatch('ADBFWX という型番の製品');
  assert.equal(keywordMatches(n1, 'DBFW', 'adbfwx という型番の製品'), false);
  const n2 = normalizeForMatch('DBFW 新弾');
  assert.equal(keywordMatches(n2, 'DBFW', 'dbfw 新弾'), true);
});
