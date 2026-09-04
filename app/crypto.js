/* ==========================================================================
   TCGウォッチ — crypto.js
   マイ情報の「暗号化バックアップ」。

   設計方針（ここは絶対に緩めないこと）:
     ・鍵はユーザーのパスフレーズから **端末上で** 導出する（PBKDF2）
     ・サーバーは存在しない。鍵も暗号文も、どこにも送らない
     ・外部ライブラリは使わない。標準の Web Crypto API のみ
     ・復号に失敗したら握りつぶさず必ず例外にする
       （「たぶん合ってる」で壊れたデータを流し込む方が害が大きい）
   ========================================================================== */

/** バックアップ形式のバージョン。将来フォーマットを変えるときに上げる。 */
export const BACKUP_VERSION = 1;

/** 鍵導出アルゴリズム名（ファイルに記録して将来の移行に備える） */
export const KDF_NAME = 'PBKDF2-SHA256';

/** PBKDF2 の反復回数 */
export const KDF_ITERATIONS = 210000;

/** salt は 16バイト、IV は 12バイト（AES-GCM の推奨値）。毎回ランダムに作る。 */
const SALT_BYTES = 16;
const IV_BYTES = 12;

/** 明らかにおかしい iter を弾くための範囲（DoS的な巨大値を避ける） */
const MIN_ITERATIONS = 1000;
const MAX_ITERATIONS = 5000000;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/* ---------------------------------------------------------------
   環境チェック
   --------------------------------------------------------------- */

/**
 * crypto.subtle は「安全なコンテキスト」でしか生えない。
 * file:// や 素の http:// で開くと undefined になり、原因が分からず詰まりやすい。
 * だから理由が分かるメッセージにして投げる。
 */
function requireSubtle() {
  const c = globalThis.crypto;
  if (!c || !c.subtle) {
    throw new Error(
      'この環境では暗号化を使えません。'
      + 'file:// で開いた場合や、https でない接続では Web Crypto API が無効になります。'
      + 'https:// か http://localhost で開き直してください。',
    );
  }
  return c.subtle;
}

function randomBytes(length) {
  const c = globalThis.crypto;
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new Error('この環境では乱数を生成できません（crypto.getRandomValues がありません）。');
  }
  const bytes = new Uint8Array(length);
  c.getRandomValues(bytes);
  return bytes;
}

/* ---------------------------------------------------------------
   base64（ブラウザは btoa/atob、Node は Buffer）
   --------------------------------------------------------------- */

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** @param {Uint8Array} bytes */
export function bytesToBase64(bytes) {
  if (typeof globalThis.btoa === 'function') {
    // 大きい配列で spread すると引数上限に当たるので分割する
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return globalThis.btoa(binary);
  }
  if (typeof globalThis.Buffer !== 'undefined') {
    return globalThis.Buffer.from(bytes).toString('base64');
  }
  throw new Error('base64 エンコードに対応していない環境です。');
}

/** @returns {Uint8Array} */
export function base64ToBytes(text) {
  if (typeof text !== 'string' || text.length === 0 || !BASE64_RE.test(text)) {
    throw new Error('バックアップの中身が壊れています（base64 として読めません）。');
  }
  if (typeof globalThis.atob === 'function') {
    let binary;
    try {
      binary = globalThis.atob(text);
    } catch {
      throw new Error('バックアップの中身が壊れています（base64 として読めません）。');
    }
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  }
  if (typeof globalThis.Buffer !== 'undefined') {
    return new Uint8Array(globalThis.Buffer.from(text, 'base64'));
  }
  throw new Error('base64 デコードに対応していない環境です。');
}

/* ---------------------------------------------------------------
   鍵導出
   --------------------------------------------------------------- */

async function deriveKey(passphrase, salt, iterations) {
  const subtle = requireSubtle();
  const material = await subtle.importKey(
    'raw',
    textEncoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false, // 鍵自体は取り出せないようにする
    ['encrypt', 'decrypt'],
  );
}

function assertPassphrase(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new Error('パスフレーズを入力してください。');
  }
}

/* ---------------------------------------------------------------
   公開API
   --------------------------------------------------------------- */

/**
 * オブジェクトを暗号化してバックアップファイルの中身（JSON文字列）を返す。
 * salt と IV は毎回新しく作るので、同じ入力でも毎回違う暗号文になる。
 *
 * @param {object} obj
 * @param {string} passphrase
 * @returns {Promise<string>}
 */
export async function encryptJson(obj, passphrase) {
  assertPassphrase(passphrase);
  const subtle = requireSubtle();

  const plaintext = textEncoder.encode(JSON.stringify(obj ?? null));
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = await deriveKey(passphrase, salt, KDF_ITERATIONS);

  const cipher = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext),
  );

  return JSON.stringify({
    v: BACKUP_VERSION,
    kdf: KDF_NAME,
    iter: KDF_ITERATIONS,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ct: bytesToBase64(cipher),
  }, null, 2);
}

/**
 * バックアップファイルの中身を復号してオブジェクトに戻す。
 * パスフレーズ違い・改ざん・形式違いは全て例外。**握りつぶさない。**
 *
 * @param {string} text
 * @param {string} passphrase
 * @returns {Promise<object>}
 */
export async function decryptJson(text, passphrase) {
  assertPassphrase(passphrase);
  const subtle = requireSubtle();

  const envelope = parseEnvelope(text);
  if (!envelope) {
    throw new Error('暗号化バックアップのファイルではありません。');
  }
  if (envelope.v !== BACKUP_VERSION) {
    throw new Error(`このバックアップの形式（v${envelope.v}）には対応していません。アプリを更新してください。`);
  }
  if (envelope.kdf !== KDF_NAME) {
    throw new Error(`未知の鍵導出方式です: ${String(envelope.kdf)}`);
  }
  const iterations = Number(envelope.iter);
  if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
    throw new Error('バックアップの反復回数の指定が不正です。');
  }

  const salt = base64ToBytes(envelope.salt);
  const iv = base64ToBytes(envelope.iv);
  const cipher = base64ToBytes(envelope.ct);

  const key = await deriveKey(passphrase, salt, iterations);

  let plaintext;
  try {
    plaintext = await subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  } catch {
    // AES-GCM の認証タグ検証に落ちた = パスフレーズ違い or 改ざん。
    // どちらかは原理的に区別できないので、両方の可能性を伝える。
    throw new Error('復元できませんでした。パスフレーズが違うか、ファイルが壊れています。');
  }

  try {
    return JSON.parse(textDecoder.decode(plaintext));
  } catch {
    throw new Error('復号はできましたが、中身がJSONとして読めませんでした。');
  }
}

/**
 * その文字列が暗号化バックアップとして読める形かどうか。
 * （復号はしない。ファイル選択直後に「これバックアップじゃないですよ」と言うため）
 * @param {string} text
 * @returns {boolean}
 */
export function isEncryptedBackup(text) {
  return parseEnvelope(text) !== null;
}

/** 形が合っていれば封筒オブジェクトを、違えば null を返す */
function parseEnvelope(text) {
  if (typeof text !== 'string') return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (typeof parsed.v !== 'number') return null;
  if (typeof parsed.kdf !== 'string') return null;
  if (typeof parsed.iter !== 'number') return null;
  for (const key of ['salt', 'iv', 'ct']) {
    if (typeof parsed[key] !== 'string' || parsed[key].length === 0) return null;
    if (!BASE64_RE.test(parsed[key])) return null;
  }
  return parsed;
}
