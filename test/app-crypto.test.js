/**
 * test/app-crypto.test.js
 *
 * 区画L: マイ情報の暗号化バックアップと、ショップ登録チェックリスト。
 *
 * ここで守りたいのは機能そのものより **安全性の約束** で、次の3つは
 * 実装が変わっても絶対に崩してはいけない:
 *   1. パスワード / クレジットカードの類を保存しない（スキーマに存在させない）
 *   2. 個人情報を外部へ送らない（送信系APIをソースに一切書かない）
 *   3. バックアップは端末上でしか復号できない（鍵はパスフレーズ由来・改ざんは検出）
 *
 * Node 20+ なら globalThis.crypto.subtle が使えるので app/crypto.js を直接 import できる。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  encryptJson,
  decryptJson,
  isEncryptedBackup,
  BACKUP_VERSION,
  KDF_NAME,
  KDF_ITERATIONS,
  bytesToBase64,
  base64ToBytes,
} from '../app/crypto.js';

import {
  PROFILE_FIELDS,
  PROFILE_KEYS,
  PROFILE_GROUPS,
  FORBIDDEN_KEY_PARTS,
  isForbiddenKey,
  normalizeProfile,
  loadProfile,
  saveProfile,
  clearProfile,
  hasProfile,
  digitsOnly,
  formatZip,
  formatPhone,
  formatBirth,
  derivedRows,
  profileSummaryText,
  normalizeShopList,
  categoryLabels,
  shopIndex,
  shopKey,
  safeShopUrl,
  normalizeShopStatus,
  loadShopStatus,
  saveShopStatus,
  shopStatusSummary,
  unregisteredShopsFor,
} from '../app/profile.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);
const readApp = (name) => readFile(join(root, 'app', name), 'utf8');

/** テストに使う「いかにも個人情報」なデータ。日本語・絵文字・記号を混ぜる。 */
const SAMPLE = {
  profile: {
    lastName: '山田',
    firstName: '太郎',
    lastNameKana: 'ヤマダ',
    firstNameKana: 'タロウ',
    zip1: '100',
    zip2: '0001',
    pref: '東京都',
    city: '千代田区千代田',
    address1: '1-1',
    address2: 'テストマンション101号室 🏠',
    phone: '090-1234-5678',
    email: 'yamada+tcg@example.com',
    birthYear: '1990',
    birthMonth: '1',
    birthDay: '2',
  },
  shopStatus: { 'p-bandai.jp': true, 'yodobashi.com': true },
  memo: '絵文字も通ること 🎴🔒 ＆ 全角記号',
};

const PASS = 'とても長い合言葉-2026';

/* ==========================================================================
   crypto.js — 暗号化バックアップ
   ========================================================================== */

test('encryptJson → decryptJson で元のオブジェクトに戻る（日本語・絵文字を含む）', async () => {
  const text = await encryptJson(SAMPLE, PASS);
  const back = await decryptJson(text, PASS);
  assert.deepEqual(back, SAMPLE);
});

test('出力は JSON で v / kdf / iter / salt / iv / ct が揃っている', async () => {
  const text = await encryptJson(SAMPLE, PASS);
  const env = JSON.parse(text);

  assert.deepEqual(
    Object.keys(env).sort(),
    ['ct', 'iter', 'iv', 'kdf', 'salt', 'v'],
  );
  assert.equal(env.v, BACKUP_VERSION);
  assert.equal(env.kdf, 'PBKDF2-SHA256');
  assert.equal(env.kdf, KDF_NAME);
  assert.equal(env.iter, 210000);
  assert.equal(env.iter, KDF_ITERATIONS);
  assert.equal(typeof env.salt, 'string');
  assert.equal(typeof env.iv, 'string');
  assert.equal(typeof env.ct, 'string');
});

test('salt は16バイト、IV は12バイト（AES-GCM の推奨サイズ）', async () => {
  const env = JSON.parse(await encryptJson(SAMPLE, PASS));
  assert.equal(base64ToBytes(env.salt).length, 16);
  assert.equal(base64ToBytes(env.iv).length, 12);
});

test('パスフレーズが違うと復号は失敗する（握りつぶさず例外）', async () => {
  const text = await encryptJson(SAMPLE, PASS);
  await assert.rejects(
    () => decryptJson(text, `${PASS}x`),
    (err) => err instanceof Error && /パスフレーズ/.test(err.message),
  );
});

test('パスフレーズが空なら例外', async () => {
  const text = await encryptJson(SAMPLE, PASS);
  await assert.rejects(() => encryptJson(SAMPLE, ''), /パスフレーズ/);
  await assert.rejects(() => decryptJson(text, ''), /パスフレーズ/);
});

test('暗号文を1文字でも書き換えたら復号は失敗する（AES-GCMの認証タグ）', async () => {
  const text = await encryptJson(SAMPLE, PASS);
  const env = JSON.parse(text);

  // ct の先頭1文字を別の base64 文字に差し替える
  const first = env.ct[0];
  const replacement = first === 'A' ? 'B' : 'A';
  env.ct = replacement + env.ct.slice(1);

  await assert.rejects(
    () => decryptJson(JSON.stringify(env), PASS),
    (err) => err instanceof Error && /復元できませんでした/.test(err.message),
  );
});

test('IV を書き換えても復号は失敗する', async () => {
  const env = JSON.parse(await encryptJson(SAMPLE, PASS));
  const iv = base64ToBytes(env.iv);
  iv[0] = (iv[0] + 1) % 256;
  env.iv = bytesToBase64(iv);
  await assert.rejects(() => decryptJson(JSON.stringify(env), PASS), /復元できませんでした/);
});

test('salt を書き換えても復号は失敗する（別の鍵が導出されるため）', async () => {
  const env = JSON.parse(await encryptJson(SAMPLE, PASS));
  const salt = base64ToBytes(env.salt);
  salt[0] = (salt[0] + 1) % 256;
  env.salt = bytesToBase64(salt);
  await assert.rejects(() => decryptJson(JSON.stringify(env), PASS), /復元できませんでした/);
});

test('同じ入力・同じパスフレーズでも毎回違う暗号文になる（salt と IV がランダム）', async () => {
  const a = JSON.parse(await encryptJson(SAMPLE, PASS));
  const b = JSON.parse(await encryptJson(SAMPLE, PASS));

  assert.notEqual(a.salt, b.salt, 'salt が使い回されている');
  assert.notEqual(a.iv, b.iv, 'IV が使い回されている');
  assert.notEqual(a.ct, b.ct, '暗号文が決定的になっている');

  // どちらも同じ内容に戻ること
  assert.deepEqual(await decryptJson(JSON.stringify(a), PASS), SAMPLE);
  assert.deepEqual(await decryptJson(JSON.stringify(b), PASS), SAMPLE);
});

test('平文が暗号文の中に現れない（氏名・住所・メール・電話）', async () => {
  const text = await encryptJson(SAMPLE, PASS);
  const leaks = [
    '山田', '太郎', 'ヤマダ', 'タロウ',
    '東京都', '千代田区千代田', 'テストマンション',
    'yamada+tcg@example.com', '090-1234-5678', '1234',
    'p-bandai.jp', PASS,
  ];
  for (const needle of leaks) {
    assert.equal(text.includes(needle), false, `平文が漏れている: ${needle}`);
  }
  // キー名も出ていないこと
  for (const key of Object.keys(SAMPLE.profile)) {
    assert.equal(text.includes(key), false, `キー名が漏れている: ${key}`);
  }
});

test('isEncryptedBackup: 本物だけ true', async () => {
  const text = await encryptJson({ a: 1 }, PASS);
  assert.equal(isEncryptedBackup(text), true);

  assert.equal(isEncryptedBackup(''), false);
  assert.equal(isEncryptedBackup('こんにちは'), false);
  assert.equal(isEncryptedBackup('{"a":1}'), false);
  assert.equal(isEncryptedBackup('[1,2,3]'), false);
  assert.equal(isEncryptedBackup(null), false);
  assert.equal(isEncryptedBackup(undefined), false);
  assert.equal(isEncryptedBackup(123), false);
  // 必須キー欠け
  const env = JSON.parse(text);
  delete env.iv;
  assert.equal(isEncryptedBackup(JSON.stringify(env)), false);
  // base64 でない値
  const bad = { ...JSON.parse(text), ct: 'これはbase64ではない' };
  assert.equal(isEncryptedBackup(JSON.stringify(bad)), false);
});

test('バックアップでない文字列を復号しようとしたら分かるエラーになる', async () => {
  await assert.rejects(() => decryptJson('ただのメモ', PASS), /暗号化バックアップのファイルではありません/);
  await assert.rejects(() => decryptJson('{"hello":"world"}', PASS), /暗号化バックアップのファイルではありません/);
});

test('未知のバージョン / 未知のKDF / 異常な反復回数は拒否する', async () => {
  const base = JSON.parse(await encryptJson({ a: 1 }, PASS));

  await assert.rejects(
    () => decryptJson(JSON.stringify({ ...base, v: 99 }), PASS),
    /形式（v99）には対応していません/,
  );
  await assert.rejects(
    () => decryptJson(JSON.stringify({ ...base, kdf: 'scrypt' }), PASS),
    /未知の鍵導出方式/,
  );
  await assert.rejects(
    () => decryptJson(JSON.stringify({ ...base, iter: 1 }), PASS),
    /反復回数の指定が不正/,
  );
  await assert.rejects(
    () => decryptJson(JSON.stringify({ ...base, iter: 999999999 }), PASS),
    /反復回数の指定が不正/,
  );
});

test('空オブジェクト・配列・入れ子も往復できる', async () => {
  for (const value of [{}, { list: [1, 2, 3] }, { nested: { a: { b: '深い🌀' } } }]) {
    const back = await decryptJson(await encryptJson(value, PASS), PASS);
    assert.deepEqual(back, value);
  }
});

test('base64 ヘルパは往復する / 不正な入力は例外', () => {
  const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
  assert.deepEqual([...base64ToBytes(bytesToBase64(bytes))], [...bytes]);
  assert.throws(() => base64ToBytes('あいうえお'), /base64/);
  assert.throws(() => base64ToBytes(''), /base64/);
});

/* ==========================================================================
   セキュリティ要件のソース走査
   ========================================================================== */

/** 個人情報を外に出しうるAPI。profile / crypto には1つも書かせない。 */
const NETWORK_APIS = ['fetch(', 'XMLHttpRequest', 'sendBeacon', 'WebSocket', 'EventSource', 'navigator.send'];

test('app/profile.js に送信系APIが一切含まれない', async () => {
  const src = await readApp('profile.js');
  for (const api of NETWORK_APIS) {
    assert.equal(src.includes(api), false, `profile.js に ${api} が含まれている（個人情報は端末外に出さない）`);
  }
});

test('app/crypto.js に送信系APIが一切含まれない', async () => {
  const src = await readApp('crypto.js');
  for (const api of NETWORK_APIS) {
    assert.equal(src.includes(api), false, `crypto.js に ${api} が含まれている（鍵も暗号文もどこにも送らない）`);
  }
});

test('app/crypto.js は外部ライブラリを import していない（Web Crypto API のみ）', async () => {
  const src = await readApp('crypto.js');
  assert.equal(/^\s*import\s/m.test(src), false, 'crypto.js が何かを import している');
  assert.equal(src.includes('crypto.subtle'), true);
});

test('パスワード / クレジットカード系のフィールドが profile のスキーマに存在しない', () => {
  const banned = ['password', 'passwd', 'card', 'cvv', 'credit', 'cvc', 'pin', 'mynumber', 'ssn'];
  for (const key of PROFILE_KEYS) {
    const lower = key.toLowerCase();
    for (const word of banned) {
      assert.equal(lower.includes(word), false, `禁止フィールドがスキーマにある: ${key}`);
    }
  }
  // 逆向きの保証: 判定関数がちゃんと弾くこと
  for (const word of ['password', 'passwd', 'cardNumber', 'cvv', 'creditCard', 'myNumber']) {
    assert.equal(isForbiddenKey(word), true, `${word} を禁止できていない`);
  }
  for (const key of PROFILE_KEYS) {
    assert.equal(isForbiddenKey(key), false, `正当なキーを誤って禁止している: ${key}`);
  }
  assert.ok(FORBIDDEN_KEY_PARTS.includes('password'));
  assert.ok(FORBIDDEN_KEY_PARTS.includes('card'));
});

test('index.html にパスワード / カード番号の入力欄が存在しない', async () => {
  const html = await readFile(join(root, 'app', 'index.html'), 'utf8');

  // マイ情報のフォームにあるのは text 入力だけ。
  // password 型はバックアップの「パスフレーズ」専用（端末内で鍵を導出するためのもので、保存もしない）
  const passwordIds = [...html.matchAll(/<input[^>]*type="password"[^>]*>/g)].map((m) => m[0]);
  for (const tag of passwordIds) {
    assert.match(tag, /id="bkPass[123]"/, `想定外の password 入力欄がある: ${tag}`);
  }
  assert.equal(passwordIds.length, 3, 'パスフレーズ欄は3つ（新規2・復元1）だけのはず');

  // クレジットカード・マイナンバー等の入力欄は存在しない（文中の言及ではなく input タグだけを見る）
  const inputs = [...html.matchAll(/<input[^>]*>/g)].map((m) => m[0].toLowerCase());
  for (const tag of inputs) {
    for (const word of ['cardnumber', 'creditcard', 'cc-number', 'cvv', 'cvc', 'マイナンバー', 'card-', 'passport']) {
      assert.equal(tag.includes(word), false, `カード等の入力欄が疑われる: ${tag}`);
    }
  }
  // 画面上の明示
  assert.ok(html.includes('パスワードとカード情報は保存しません'), '保存しない旨の明記が無い');
  assert.ok(html.includes('1Password'), 'パスワード管理を任せる案内が無い');
  assert.ok(html.includes('パスフレーズを忘れると'), 'パスフレーズ紛失の警告が無い');
});

test('index.html のリンクは https のみ（外部への送信フォームも無い）', async () => {
  const html = await readFile(join(root, 'app', 'index.html'), 'utf8');
  for (const m of html.matchAll(/href="([^"]+)"/g)) {
    const href = m[1];
    if (href.startsWith('./') || href.startsWith('#')) continue;
    assert.match(href, /^https:\/\//, `安全でない href: ${href}`);
  }
  // action 付き（＝どこかへ送る）フォームが無いこと
  assert.equal(/<form[^>]*\saction=/.test(html), false, 'action 付きの form がある');
});

/* ==========================================================================
   profile.js — マイ情報
   ========================================================================== */

test('スキーマ: 会員登録で必要になる項目が揃っている', () => {
  const expected = [
    'lastName', 'firstName', 'lastNameKana', 'firstNameKana',
    'zip1', 'zip2', 'pref', 'city', 'address1', 'address2',
    'phone', 'email',
    'birthYear', 'birthMonth', 'birthDay',
  ];
  assert.deepEqual(PROFILE_KEYS, expected);

  // 全フィールドが既知のグループに属していること（UIから漏れない保証）
  const groups = new Set(PROFILE_GROUPS.map((g) => g.key));
  for (const f of PROFILE_FIELDS) {
    assert.ok(groups.has(f.group), `未知のグループ: ${f.group}`);
    assert.equal(typeof f.label, 'string');
    assert.ok(f.label.length > 0);
  }
});

test('normalizeProfile: 未知キー・禁止キー・非文字列を落とす', () => {
  const out = normalizeProfile({
    lastName: '  山田  ',
    firstName: '',
    password: 'ひみつ',
    cardNumber: '4111111111111111',
    nickname: 'たろ',
    phone: 12345,
    email: { evil: true },
  });
  assert.deepEqual(out, { lastName: '山田', phone: '12345' });
  assert.equal('password' in out, false);
  assert.equal('cardNumber' in out, false);
  assert.equal('nickname' in out, false);
  assert.equal('firstName' in out, false, '空文字は残さない');
});

test('normalizeProfile: 壊れた入力でも落ちない', () => {
  assert.deepEqual(normalizeProfile(null), {});
  assert.deepEqual(normalizeProfile(undefined), {});
  assert.deepEqual(normalizeProfile('文字列'), {});
  assert.deepEqual(normalizeProfile([1, 2]), {});
});

test('loadProfile / saveProfile / clearProfile は localStorage が無くても落ちない', () => {
  // Node には使える localStorage が無い。それでも例外を投げずに空を返すこと
  assert.deepEqual(loadProfile(), {});
  assert.deepEqual(saveProfile({ lastName: '山田', password: 'x' }), { lastName: '山田' });
  assert.deepEqual(clearProfile(), {});
  assert.equal(hasProfile({ lastName: '山田' }), true);
  assert.equal(hasProfile({}), false);
  assert.equal(hasProfile({ password: 'x' }), false);
});

test('整形: 郵便番号 / 電話 / 生年月日', () => {
  assert.equal(digitsOnly('090-1234-5678'), '09012345678');
  assert.equal(formatZip({ zip1: '100', zip2: '0001' }), '100-0001');
  assert.equal(formatZip({ zip1: '100' }), '');
  assert.equal(formatPhone({ phone: '090-1234-5678' }), '090-1234-5678');
  assert.equal(formatPhone({ phone: '09012345678' }), '090-1234-5678');
  assert.equal(formatPhone({ phone: '0312345678' }), '03-1234-5678');
  assert.equal(formatPhone({}), '');
  assert.equal(formatBirth({ birthYear: '1990', birthMonth: '1', birthDay: '2' }), '1990/01/02');
  assert.equal(formatBirth({ birthYear: '1990' }), '');
});

test('derivedRows: 姓名まとめ・カナ・ハイフン有無の両方が出る', () => {
  const rows = derivedRows(SAMPLE.profile);
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  assert.equal(byKey.fullName, '山田 太郎');
  assert.equal(byKey.fullNameNoSpace, '山田太郎');
  assert.equal(byKey.fullNameKana, 'ヤマダ タロウ');
  assert.equal(byKey.zip, '100-0001');
  assert.equal(byKey.zipDigits, '1000001');
  assert.equal(byKey.phoneHyphen, '090-1234-5678');
  assert.equal(byKey.phoneDigits, '09012345678');
  assert.equal(byKey.birth, '1990/01/02');
  assert.ok(byKey.address.includes('東京都'));

  // 空のプロフィールでは1行も出さない（空欄をコピーさせない）
  assert.deepEqual(derivedRows({}), []);
});

test('profileSummaryText: 入っている項目だけを行に並べる', () => {
  const text = profileSummaryText(SAMPLE.profile);
  assert.ok(text.includes('セイ（カナ）: ヤマダ'));
  assert.ok(text.includes('メールアドレス: yamada+tcg@example.com'));
  assert.ok(text.includes('電話（ハイフンなし）: 09012345678'));
  assert.equal(profileSummaryText({}), '');
  // パスワードの類は当然入らない
  assert.equal(profileSummaryText({ ...SAMPLE.profile, password: 'ひみつ' }).includes('ひみつ'), false);
});

/* ==========================================================================
   profile.js — ショップ登録チェックリスト
   ========================================================================== */

/** 実物の config/shops.json を読む（アプリ側にハードコードしていないことの確認も兼ねる） */
async function realShopsConfig() {
  return JSON.parse(await readFile(join(root, 'config', 'shops.json'), 'utf8'));
}

test('normalizeShopList: config/shops.json から一覧を作る（ハードコードしない）', async () => {
  const raw = await realShopsConfig();
  const list = normalizeShopList(raw);

  assert.ok(list.length > 30, `店が少なすぎる: ${list.length}`);

  const labels = list.map((s) => s.label);
  assert.ok(labels.includes('プレミアムバンダイ'));
  assert.ok(labels.includes('ヨドバシ.com'));

  // 同じ店名が複数ドメインで登録されていてもチェック項目は1つにまとまる
  assert.equal(labels.filter((l) => l === 'Amazon').length, 1);
  const amazon = list.find((s) => s.label === 'Amazon');
  assert.ok(amazon.domains.includes('amazon.co.jp'));
  assert.ok(amazon.domains.includes('amzn.to'));

  // id は一意
  assert.equal(new Set(list.map((s) => s.id)).size, list.length);

  // 登録ページのリンクは https のみ
  for (const shop of list) {
    assert.match(shop.url, /^https:\/\//, `https でないURL: ${shop.url}`);
    assert.equal(safeShopUrl(shop.url), shop.url);
  }

  // メーカー直販が先頭に来る（一番早く・確実に応募できる店から潰したい）
  assert.equal(list[0].category, 'maker');
});

test('app/config.js の写しと config/shops.json は同じ一覧になる（単一ファイル版の保険）', async () => {
  const { SHOPS_CONFIG } = await import('../app/config.js');
  const fromConfig = normalizeShopList(await realShopsConfig()).map((s) => s.label).sort();
  const fromEmbedded = normalizeShopList(SHOPS_CONFIG).map((s) => s.label).sort();
  assert.deepEqual(fromEmbedded, fromConfig, 'app/config.js の写しが古い（config/shops.json と揃えること）');
});

test('normalizeShopList: 壊れた入力・空でも落ちない', () => {
  assert.deepEqual(normalizeShopList(null), []);
  assert.deepEqual(normalizeShopList({}), []);
  assert.deepEqual(normalizeShopList({ shops: 'x' }), []);
  assert.deepEqual(normalizeShopList([{ label: '名前だけ' }]), []);
  assert.deepEqual(normalizeShopList([{ domain: 'x.jp' }]), []);
  assert.equal(normalizeShopList([{ label: 'A', domain: 'a.jp', enabled: false }]).length, 0);
});

test('safeShopUrl: https 以外は通さない', () => {
  assert.equal(safeShopUrl('https://p-bandai.jp/'), 'https://p-bandai.jp/');
  assert.equal(safeShopUrl('http://p-bandai.jp/'), null);
  assert.equal(safeShopUrl('javascript:alert(1)'), null);
  assert.equal(safeShopUrl('data:text/html,x'), null);
  assert.equal(safeShopUrl(''), null);
  assert.equal(safeShopUrl(null), null);
});

test('shopIndex / shopKey: 表記ゆれ・別名・ドメインで引ける', () => {
  const list = normalizeShopList([
    { label: 'プレミアムバンダイ', domain: 'p-bandai.jp', category: 'maker', priority: 10, aliases: ['プレバン'] },
    { label: 'Yahoo!ショッピング', domain: 'shopping.yahoo.co.jp', category: 'ec', priority: 7 },
  ]);
  const index = shopIndex(list);

  assert.equal(index.get(shopKey('プレミアムバンダイ')).id, 'p-bandai.jp');
  assert.equal(index.get(shopKey('プレバン')).id, 'p-bandai.jp');
  assert.equal(index.get(shopKey('p-bandai.jp')).id, 'p-bandai.jp');
  // 全角の「！」でも同じ店に当たる
  assert.equal(index.get(shopKey('Yahoo！ショッピング')).id, 'shopping.yahoo.co.jp');
  assert.equal(index.get(shopKey('存在しない店')), undefined);
});

test('normalizeShopStatus / saveShopStatus: true のキーだけ残す', () => {
  assert.deepEqual(normalizeShopStatus({ a: true, b: false, c: 'yes', d: 1 }), { a: true });
  assert.deepEqual(normalizeShopStatus(null), {});
  assert.deepEqual(normalizeShopStatus([true]), {});
  assert.deepEqual(saveShopStatus({ 'p-bandai.jp': true, x: false }), { 'p-bandai.jp': true });
  assert.deepEqual(loadShopStatus(), {});
});

test('shopStatusSummary: 登録済み件数を数える', () => {
  const list = normalizeShopList([
    { label: 'A', domain: 'a.jp', category: 'maker', priority: 10 },
    { label: 'B', domain: 'b.jp', category: 'maker', priority: 9 },
  ]);
  assert.deepEqual(shopStatusSummary(list, { 'a.jp': true }), { done: 1, total: 2 });
  assert.deepEqual(shopStatusSummary(list, {}), { done: 0, total: 2 });
  assert.deepEqual(shopStatusSummary([], {}), { done: 0, total: 0 });
});

/* ---------- 本命: 未登録警告 ---------- */

const NOW = new Date('2026-09-01T00:00:00.000Z');
const SHOPS = normalizeShopList([
  { label: 'ヨドバシ.com', domain: 'yodobashi.com', category: 'kaden', priority: 7, aliases: ['ヨドバシ'] },
  { label: 'プレミアムバンダイ', domain: 'p-bandai.jp', category: 'maker', priority: 10, aliases: ['プレバン'] },
]);

/** テスト用の FeedItem */
function item(over = {}) {
  return {
    id: Math.random().toString(36).slice(2),
    title: 'テスト抽選',
    url: 'https://example.com/news/1',
    destUrl: 'https://yodobashi.com/product/1',
    destLabel: 'ヨドバシ',
    intentTags: ['抽選'],
    deadline: null,
    startsAt: null,
    ...over,
  };
}

test('unregisteredShopsFor: 未登録の店の抽選を拾う', () => {
  const out = unregisteredShopsFor(
    [item({ deadline: '2026-09-14T12:00:00.000Z' })],
    {},
    SHOPS,
    { now: NOW },
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'yodobashi.com');
  assert.equal(out[0].label, 'ヨドバシ.com', '別名で書かれていても正式名で返す');
  assert.equal(out[0].known, true);
  assert.equal(out[0].url, 'https://yodobashi.com/');
  assert.equal(out[0].count, 1);
  assert.equal(out[0].nextAt, '2026-09-14T12:00:00.000Z');
  assert.equal(out[0].nextKind, 'deadline');
});

test('unregisteredShopsFor: 登録済みの店は出さない（これが機能の本体）', () => {
  const items = [item({ deadline: '2026-09-14T12:00:00.000Z' })];
  assert.equal(unregisteredShopsFor(items, { 'yodobashi.com': true }, SHOPS, { now: NOW }).length, 0);
  // false は「未登録」扱い
  assert.equal(unregisteredShopsFor(items, { 'yodobashi.com': false }, SHOPS, { now: NOW }).length, 1);
});

test('unregisteredShopsFor: 受付終了（締切が過去）は警告しない', () => {
  const out = unregisteredShopsFor(
    [item({ deadline: '2026-08-20T12:00:00.000Z' })],
    {},
    SHOPS,
    { now: NOW },
  );
  assert.deepEqual(out, []);
});

test('unregisteredShopsFor: 受付開始が未来ならそれを次の予定にする（事前登録が最も効く場面）', () => {
  const out = unregisteredShopsFor(
    [item({ startsAt: '2026-09-05T01:00:00.000Z', deadline: '2026-09-20T12:00:00.000Z' })],
    {},
    SHOPS,
    { now: NOW },
  );
  assert.equal(out[0].nextAt, '2026-09-05T01:00:00.000Z');
  assert.equal(out[0].nextKind, 'start');
});

test('unregisteredShopsFor: 遠すぎる予定では急かさない', () => {
  const far = [item({ deadline: '2027-01-01T00:00:00.000Z' })];
  assert.equal(unregisteredShopsFor(far, {}, SHOPS, { now: NOW }).length, 0);
  assert.equal(unregisteredShopsFor(far, {}, SHOPS, { now: NOW, withinDays: 400 }).length, 1);
});

test('unregisteredShopsFor: 同じ店はまとめ、最も近い予定を代表にする', () => {
  const out = unregisteredShopsFor(
    [
      item({ deadline: '2026-09-20T12:00:00.000Z' }),
      item({ deadline: '2026-09-03T12:00:00.000Z', title: '一番近いやつ' }),
      item({ deadline: '2026-09-10T12:00:00.000Z' }),
    ],
    {},
    SHOPS,
    { now: NOW },
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].count, 3);
  assert.equal(out[0].nextAt, '2026-09-03T12:00:00.000Z');
  assert.equal(out[0].sample.title, '一番近いやつ');
});

test('unregisteredShopsFor: 予定が近い順に並ぶ', () => {
  const out = unregisteredShopsFor(
    [
      item({ destLabel: 'プレバン', destUrl: 'https://p-bandai.jp/item/1', deadline: '2026-09-20T00:00:00.000Z' }),
      item({ deadline: '2026-09-02T00:00:00.000Z' }),
    ],
    {},
    SHOPS,
    { now: NOW },
  );
  assert.deepEqual(out.map((e) => e.id), ['yodobashi.com', 'p-bandai.jp']);
});

test('unregisteredShopsFor: 一覧に無い店（ミントモール等）も取りこぼさない', () => {
  const out = unregisteredShopsFor(
    [item({ destLabel: 'ミントモール', destUrl: 'https://mint-mall.example/x', deadline: '2026-09-05T00:00:00.000Z' })],
    {},
    SHOPS,
    { now: NOW },
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'other:ミントモール');
  assert.equal(out[0].known, false);
  assert.equal(out[0].url, null, 'ドメインを推測してリンクを作らないこと');

  // その id でチェックを付ければ黙る
  assert.equal(
    unregisteredShopsFor(
      [item({ destLabel: 'ミントモール', deadline: '2026-09-05T00:00:00.000Z' })],
      { 'other:ミントモール': true },
      SHOPS,
      { now: NOW },
    ).length,
    0,
  );
});

test('unregisteredShopsFor: destLabel が無い・応募と無関係なものは無視する', () => {
  const out = unregisteredShopsFor(
    [
      item({ destLabel: null, destUrl: null }),
      item({ destLabel: '', destUrl: null }),
      { title: 'ただのニュース', destLabel: 'ヨドバシ', destUrl: null, intentTags: ['新商品'] },
      null,
      'ごみ',
    ],
    {},
    SHOPS,
    { now: NOW },
  );
  assert.deepEqual(out, []);
});

test('unregisteredShopsFor: 日時が取れない案件も件数には数える（勝手に締切を作らない）', () => {
  const out = unregisteredShopsFor([item()], {}, SHOPS, { now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].nextAt, null);
  assert.equal(out[0].nextKind, null);
});

test('unregisteredShopsFor: 壊れた引数でも落ちない', () => {
  assert.deepEqual(unregisteredShopsFor(null, null, null), []);
  assert.deepEqual(unregisteredShopsFor(undefined, undefined, undefined, {}), []);
  assert.deepEqual(unregisteredShopsFor([], {}, []), []);
});

test('unregisteredShopsFor: 実データ形式のフィードでも例外なく動く', async () => {
  // app/feed.json は実行時の生成物なので、クローン直後には存在しない。
  // リポジトリに同梱しているサンプルを使い、どの環境でも同じ結果になるようにする。
  const feed = JSON.parse(await readFile(join(root, 'public', 'feed.sample.json'), 'utf8'));
  const shops = normalizeShopList(await realShopsConfig());

  const out = unregisteredShopsFor(feed.items, {}, shops, { now: NOW, withinDays: 3650 });
  assert.ok(Array.isArray(out));
  for (const entry of out) {
    assert.equal(typeof entry.label, 'string');
    assert.ok(entry.count >= 1);
    if (entry.url !== null) assert.match(entry.url, /^https:\/\//);
  }
  // 実データにある店（カードラボ等）を登録済みにすると、その分だけ減る
  if (out.length) {
    const after = unregisteredShopsFor(feed.items, { [out[0].id]: true }, shops, { now: NOW, withinDays: 3650 });
    assert.equal(after.length, out.length - 1);
  }
});

test('categoryLabels: config の _categories を優先しつつ既定で埋める', async () => {
  const labels = categoryLabels(await realShopsConfig());
  assert.equal(labels.maker, 'メーカー直販・公式ストア');
  assert.equal(labels.other, 'その他', '設定に無いキーは既定で埋まる');
  assert.equal(categoryLabels(null).cardshop, 'カードショップ');
});
