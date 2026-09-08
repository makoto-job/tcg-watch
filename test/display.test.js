/**
 * 表示部（app/）のテスト。
 *
 * app/app.js は読み込み時に document を触るので node からは import できない。
 * そこで、
 *   ・純粋なロジックと設定は app/config.js に置いて直接テストする
 *   ・DOMを組み立てる部分は「二度と戻ってはいけない書き方」をソースで押さえる
 * という分け方にしている。
 *
 *   node --test test/display.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  IP_LABELS,
  IP_ORDER,
  FRESH_HOURS,
  STALE_HOURS,
  freshnessLevel,
} from '../app/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const read = (rel) => readFile(join(root, rel), 'utf8');

// ────────────────────────────────────────────────────────────
// ジャンル（チップ）の定義
//
// 利用者から「ドラゴンボールのバッジも追加して」と指摘があった件。
// 実際にはチップが「フィードに含まれるジャンルだけ」だったため、
// その日の記事が無いジャンルはバッジごと消えていた。
// ────────────────────────────────────────────────────────────

test('IP_ORDER は収集側（config/sources.json）の対象IPと完全に一致する', async () => {
  const sources = JSON.parse(await read('config/sources.json'));
  const collected = Object.keys(sources.ips).sort();
  assert.deepEqual(
    [...IP_ORDER].sort(),
    collected,
    'アプリのチップと収集側の対象IPがずれている（unionarena が抜けていた事故と同じ形）',
  );
});

test('IP_ORDER のすべてに日本語ラベルがあり、重複していない', () => {
  assert.equal(new Set(IP_ORDER).size, IP_ORDER.length, 'IP_ORDER に重複がある');
  for (const key of IP_ORDER) {
    assert.ok(IP_LABELS[key], `${key} のラベルが無い`);
  }
  assert.deepEqual(Object.keys(IP_LABELS).sort(), [...IP_ORDER].sort());
});

test('すべてのジャンルに色がある（ライト・ダーク両方）', async () => {
  const css = await read('app/style.css');
  // ダークは @media (prefers-color-scheme: dark) の中で再定義している
  const darkStart = css.indexOf('@media (prefers-color-scheme: dark)');
  assert.ok(darkStart > 0, 'ダークモードのブロックが見つからない');
  const light = css.slice(0, darkStart);
  const dark = css.slice(darkStart);

  for (const key of IP_ORDER) {
    assert.ok(light.includes(`--ip-${key}:`), `ライトに --ip-${key} が無い`);
    assert.ok(dark.includes(`--ip-${key}:`), `ダークに --ip-${key} が無い`);
  }
});

test('チップは全ジャンルを常に描く（フィードにある分だけに絞らない）', async () => {
  const js = await read('app/app.js');
  assert.ok(
    !/IP_ORDER\.filter\(\([^)]*\)\s*=>\s*present\.has/.test(js),
    'フィードに含まれるジャンルだけを出す書き方が戻っている（0件でジャンルが消える）',
  );
  assert.ok(/el\.ipChips\.replaceChildren\(\.\.\.IP_ORDER\.map\(/.test(js), 'チップの元が IP_ORDER ではない');
});

test('0件のチップは淡色＋件数付きで、押しても行き止まりにしない', async () => {
  const js = await read('app/app.js');
  const css = await read('app/style.css');

  // 件数を出している
  assert.ok(js.includes("count.className = 'chip__count'"), 'チップに件数の要素が無い');
  // 0件は選択させず、理由を出す
  assert.ok(
    js.includes('ipCount(key).visible === 0') && js.includes('toast(emptyChipMessage(key))'),
    '0件のチップを押したときの案内が無い',
  );
  assert.ok(js.includes("refs.btn.setAttribute('aria-disabled', 'true')"), '0件チップが支援技術に伝わらない');
  // 淡色の見た目
  assert.ok(css.includes('.chip.is-empty'), '0件チップのスタイルが無い');
});

test('0件の一覧には理由と戻り道を出す', async () => {
  const html = await read('app/index.html');
  const js = await read('app/app.js');
  assert.ok(html.includes('id="btnEmptyClear"'), '0件表示に解除ボタンが無い');
  assert.ok(js.includes('function renderEmptyState()'), '0件表示の文言を出す処理が無い');
  assert.ok(js.includes('function clearAllFilters('), '絞り込み解除の共通処理が無い');
});

// ────────────────────────────────────────────────────────────
// 情報の鮮度
//
// 店が購入制限を 6BOX → 4BOX に変えたのに、古い内容を出していた件。
// 「いつ時点の情報か」を画面から分かるようにする。
// ────────────────────────────────────────────────────────────

test('freshnessLevel: 取得からの経過時間を3段階に分ける', () => {
  assert.equal(freshnessLevel(0), 'fresh');
  assert.equal(freshnessLevel(FRESH_HOURS - 0.1), 'fresh');
  assert.equal(freshnessLevel(FRESH_HOURS), 'aging');
  assert.equal(freshnessLevel(STALE_HOURS - 0.1), 'aging');
  assert.equal(freshnessLevel(STALE_HOURS), 'stale');
  assert.equal(freshnessLevel(24 * 30), 'stale');
});

test('freshnessLevel: 時計ズレ（未来・壊れた値）でも警告しない', () => {
  assert.equal(freshnessLevel(-5), 'fresh');
  assert.equal(freshnessLevel(NaN), 'fresh');
  assert.equal(freshnessLevel(undefined), 'fresh');
});

test('鮮度のしきい値は「その日のうちに気づける」範囲にある', () => {
  assert.ok(FRESH_HOURS > 0 && FRESH_HOURS < STALE_HOURS);
  assert.ok(STALE_HOURS <= 24, '1日以上たった店の情報を「新しい」と見せてはいけない');
});

test('店由来の項目だけに取得時刻を出す（ニュースの日付と混ぜない）', async () => {
  const js = await read('app/app.js');
  assert.ok(js.includes("if (!item || item.tier !== 'shop') return null;"), '鮮度の対象が店由来に限定されていない');
  assert.ok(js.includes("span.className = 'dl dl--stale'"), '古い情報の注意バッジが無い');

  const css = await read('app/style.css');
  assert.ok(css.includes('.dl--stale'), '注意バッジのスタイルが無い');
  assert.ok(css.includes('.hdr__updated.is-stale'), 'フィード全体が古いときの表示が無い');
});

// ────────────────────────────────────────────────────────────
// 安全性（表示部で守り続けること）
// ────────────────────────────────────────────────────────────

test('フィード由来のテキストを innerHTML で流し込んでいない', async () => {
  const js = await read('app/app.js');
  const hits = js.split('\n').filter((line) => /\.innerHTML\s*=/.test(line));
  assert.deepEqual(hits, [], `innerHTML への代入がある: ${hits.join(' / ')}`);
});

test('href に入れる前に http(s) かどうかを必ず確かめている', async () => {
  const js = await read('app/app.js');
  assert.ok(/function safeUrl/.test(js), 'safeUrl が無い');
  assert.ok(/\^https\?:/.test(js), 'http(s) の判定が無い');
  // a.href への代入は safeUrl / primaryUrl を通ったものだけ
  const bad = js
    .split('\n')
    .filter((line) => /\.href\s*=\s*/.test(line))
    .filter((line) => !/(url|dest|tweetUrl|href)\b/.test(line));
  assert.deepEqual(bad, [], `検査していない href 代入がある: ${bad.join(' / ')}`);
});

// ────────────────────────────────────────────────────────────
// お店の表示範囲
//
// 利用者から「未登録のショップに、住んでるエリアからだいぶ遠い小売店が出る。
// 行けないので不要」という指摘があった件。
// 既定はオンライン＋自分の都道府県だけ。ただし全部見る道は必ず残す。
// ────────────────────────────────────────────────────────────

test('警告は仕分けを通してから描く（生の一覧をそのまま出さない）', async () => {
  const js = await read('app/app.js');
  assert.ok(js.includes('partitionUnregisteredShops('), '遠近の仕分けを通していない');
  assert.ok(
    !/unregisteredShopsFor\([^)]*\)\s*\n?\s*\.slice\(/.test(js),
    '仕分けを通さずに未登録一覧をそのまま切り出している（遠方の店がまた出る）',
  );
  assert.ok(js.includes('pref: state.profile.pref'), 'マイ情報の都道府県を見ていない');
});

test('隠した分は件数で見せ、すべて表示に戻れる（行き止まりを作らない）', async () => {
  const html = await read('app/index.html');
  const js = await read('app/app.js');

  assert.ok(html.includes('id="btnWarnScope"'), '遠方も表示するボタンが無い');
  assert.ok(html.includes('id="areaShowAll"'), 'マイ情報側の切り替えが無い');
  // 押す前に何件出るか分かる
  assert.ok(/遠方のお店も表示（\$\{far\}件）/.test(js), '件数を出さずに押させている');
  assert.ok(js.includes('近くのお店だけにする'), '戻す側の文言が無い');
  assert.ok(js.includes('function setWarnShowAll('), '表示範囲を切り替える処理が無い');
});

test('「興味なし」は取り消せる（マイ情報に一覧と解除がある）', async () => {
  const html = await read('app/index.html');
  const js = await read('app/app.js');

  assert.ok(js.includes("mute.className = 'warn__mute'"), '興味なしボタンが無い');
  assert.ok(js.includes('function setShopHidden('), '興味なしの保存処理が無い');
  assert.ok(html.includes('id="mutedList"'), '興味なしにした店の一覧が無い');
  assert.ok(js.includes('function mutedRows()'), '一覧を組み立てる処理が無い');
  assert.ok(js.includes('function buildMutedRow('), '解除ボタンを作る処理が無い');
  // 抽選が無くなった店も一覧に出す（そうしないと解除できない）
  assert.ok(js.includes('Object.keys(state.shopHidden).map('), '保存済みの全件から一覧を作っていない');
});

test('都道府県を促すときは理由を添える（強制しない）', async () => {
  const js = await read('app/app.js');
  const profile = await read('app/profile.js');
  assert.ok(js.includes('近くのお店だけ出せます'), '入力を促す理由が書かれていない');
  assert.ok(profile.includes("key: 'pref'") && profile.includes('入れると近くのお店だけ出せます'), '入力欄に理由が無い');
  // 必須にしていないこと
  assert.ok(!/pref[^\n]*required/.test(profile), '都道府県を必須にしている');
});

test('表示範囲のスタイルは既存のトークンで作る（後付けの色を足さない）', async () => {
  const css = await read('app/style.css');
  for (const sel of ['.warn__mute', '.warn__more', '.warn__scope', '.shop__name--plain']) {
    assert.ok(css.includes(sel), `${sel} のスタイルが無い`);
  }
  const block = css.slice(css.indexOf('.warn__mute'), css.indexOf('/* ---------- ボトムシート'));
  const hardCoded = block.match(/:\s*#[0-9a-f]{3,8}\b/gi) || [];
  assert.deepEqual(hardCoded, [], `色を直書きしている: ${hardCoded.join(' / ')}`);
  assert.ok(block.includes('min-height: var(--tap)'), 'タップ領域が既存の寸法に揃っていない');
});
