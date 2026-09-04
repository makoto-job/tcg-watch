/**
 * 区画D: 投稿済みアイテムの永続化ストア
 *
 * 保存先: `data/posted.json`
 * 形式:   `{ "items": { "<key>": "<ISO8601>" } }`
 *          key は アイテムID と canonical URL の両方を入れる（どちらでも重複判定できるように）
 *
 * npm依存ゼロ / Node標準のみ。
 */

import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { resolveFromRoot } from './config.js';

/** 保持期間（日）。これより古いエントリは savePosted 時に prune される */
export const RETENTION_DAYS = 30;

/** 既定の保存先（プロジェクトルート基準） */
export const DEFAULT_POSTED_PATH = 'data/posted.json';

/**
 * URL を重複判定用に正規化する。
 * （src/resolve.js の canonicalizeUrl とは独立。store 単体でテストできるよう自前実装）
 * @param {string} url
 * @returns {string} 正規化済みURL。パースできなければ trim した元文字列
 */
export function canonicalKey(url) {
  if (typeof url !== 'string' || url.trim() === '') return '';
  const raw = url.trim();
  try {
    const u = new URL(raw);
    u.hash = '';
    u.protocol = u.protocol.toLowerCase();
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    // トラッキングパラメータを除去
    const drop = [];
    for (const key of u.searchParams.keys()) {
      if (/^(utm_|ref$|ref_|gclid$|fbclid$|mc_cid$|mc_eid$|igshid$|spm$|yclid$|_ga$)/i.test(key)) {
        drop.push(key);
      }
    }
    for (const key of drop) u.searchParams.delete(key);
    // 末尾スラッシュ正規化（ルート '/' は残す）
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.replace(/\/+$/, '');
    }
    let out = u.toString();
    if (out.endsWith('?')) out = out.slice(0, -1);
    return out;
  } catch {
    return raw;
  }
}

/**
 * @typedef {Object} PostedStore
 * @property {Record<string,string>} items  key -> ISO8601 の記録時刻
 * @property {string} [__path] 内部用: 読み込み元パス（savePosted のデフォルトに使う）
 */

/**
 * 空のストアを作る。
 * @param {string} [filePath]
 * @returns {PostedStore}
 */
function emptyStore(filePath) {
  const store = { items: {} };
  if (filePath) Object.defineProperty(store, '__path', { value: filePath, enumerable: false, writable: true });
  return store;
}

/**
 * 投稿済みストアを読み込む。
 * ファイルが無い / JSONが壊れている場合も落ちずに初期化する（壊れている場合は warn）。
 * @param {string} [filePath=DEFAULT_POSTED_PATH]
 * @returns {Promise<PostedStore>}
 */
export async function loadPosted(filePath = DEFAULT_POSTED_PATH) {
  const file = resolveFromRoot(filePath);

  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (!err || err.code !== 'ENOENT') {
      console.warn(`[store] 投稿済みファイルを読めませんでした（${file}）: ${err?.message}。空の状態で開始します。`);
    }
    return emptyStore(file);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    console.warn(
      `[store] ${file} のJSONが壊れています（${err.message}）。空の状態で初期化します（元ファイルは次回保存時に上書きされます）。`
    );
    return emptyStore(file);
  }

  if (!parsed || typeof parsed !== 'object' || typeof parsed.items !== 'object' || parsed.items === null || Array.isArray(parsed.items)) {
    console.warn(`[store] ${file} の形式が想定外です。空の状態で初期化します。`);
    return emptyStore(file);
  }

  const store = emptyStore(file);
  for (const [k, v] of Object.entries(parsed.items)) {
    if (typeof k === 'string' && k !== '' && typeof v === 'string') {
      store.items[k] = v;
    }
  }
  return store;
}

/**
 * 1アイテムに対する記録キー（id と canonical URL）。
 * @param {{id?:string, url?:string}} item
 * @returns {string[]}
 */
function keysFor(item) {
  const keys = [];
  if (item && typeof item.id === 'string' && item.id !== '') keys.push(item.id);
  const ck = canonicalKey(item?.url);
  if (ck !== '') keys.push(ck);
  return keys;
}

/**
 * 既に投稿済みか。id または canonical URL のどちらかが記録済みなら true。
 * @param {PostedStore} store
 * @param {{id?:string, url?:string}} item
 * @returns {boolean}
 */
export function isPosted(store, item) {
  if (!store || typeof store.items !== 'object' || store.items === null) return false;
  return keysFor(item).some((k) => Object.prototype.hasOwnProperty.call(store.items, k));
}

/**
 * アイテム群を投稿済みとして記録する（id と URL の両方をキーにする）。
 * @param {PostedStore} store
 * @param {Array<{id?:string, url?:string}>} items
 * @param {Date} [now=new Date()]
 * @returns {PostedStore} 同じ store（チェーン用）
 */
export function markPosted(store, items, now = new Date()) {
  if (!store.items) store.items = {};
  const iso = (now instanceof Date ? now : new Date(now)).toISOString();
  for (const item of items || []) {
    for (const k of keysFor(item)) {
      store.items[k] = iso;
    }
  }
  return store;
}

/**
 * 保持期間より古いエントリを取り除く（破壊的）。
 * @param {PostedStore} store
 * @param {Date} [now=new Date()]
 * @param {number} [retentionDays=RETENTION_DAYS]
 * @returns {number} 削除件数
 */
export function prunePosted(store, now = new Date(), retentionDays = RETENTION_DAYS) {
  if (!store || !store.items) return 0;
  const cutoff = (now instanceof Date ? now.getTime() : new Date(now).getTime()) - retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const [k, v] of Object.entries(store.items)) {
    const t = Date.parse(v);
    // パースできない値も掃除対象にする
    if (!Number.isFinite(t) || t < cutoff) {
      delete store.items[k];
      removed += 1;
    }
  }
  return removed;
}

/**
 * ストアを保存する。
 *  1. 30日より古いエントリを prune
 *  2. `data/` が無ければ作成
 *  3. 一時ファイルに書いて rename する原子的書き込み
 *
 * @param {PostedStore} store
 * @param {string} [filePath] 省略時は loadPosted 時のパス、それも無ければ既定パス
 * @param {{ now?: Date, retentionDays?: number }} [opts]
 * @returns {Promise<{path:string, count:number, pruned:number}>}
 */
export async function savePosted(store, filePath, opts = {}) {
  const { now = new Date(), retentionDays = RETENTION_DAYS } = opts;
  const target = resolveFromRoot(filePath || store?.__path || DEFAULT_POSTED_PATH);

  const pruned = prunePosted(store, now, retentionDays);

  await mkdir(path.dirname(target), { recursive: true });

  // キーをソートして安定した diff にする（GitHub Actions のコミットが読みやすくなる）
  const sortedItems = {};
  for (const k of Object.keys(store.items).sort()) sortedItems[k] = store.items[k];
  const payload = JSON.stringify({ items: sortedItems }, null, 2) + '\n';

  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tmp, payload, 'utf8');
    await rename(tmp, target);
  } catch (err) {
    // 一時ファイルが残らないよう後始末
    try {
      await unlink(tmp);
    } catch {
      /* noop */
    }
    throw new Error(`投稿済みファイルの保存に失敗しました（${target}）: ${err.message}`);
  }

  return { path: target, count: Object.keys(sortedItems).length, pruned };
}
