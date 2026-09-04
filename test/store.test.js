/**
 * 区画D: src/store.js のユニットテスト（ネット不要）
 *
 *   node --test test/store.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  loadPosted,
  isPosted,
  markPosted,
  savePosted,
  prunePosted,
  canonicalKey,
  RETENTION_DAYS,
} from '../src/store.js';

/** 一時ディレクトリに posted.json のパスを作る */
async function tmpPostedPath() {
  const dir = await mkdtemp(path.join(tmpdir(), 'tcgbot-store-'));
  return path.join(dir, 'data', 'posted.json');
}

/** テスト用のダミーアイテム */
function item(id, url) {
  return { id, url, title: `記事 ${id}` };
}

test('canonicalKey: トラッキングパラメータ・末尾スラッシュ・www を正規化する', () => {
  assert.equal(
    canonicalKey('https://www.example.com/news/123/?utm_source=twitter&utm_medium=social'),
    'https://example.com/news/123'
  );
  assert.equal(canonicalKey('https://example.com/a?b=1#section'), 'https://example.com/a?b=1');
  assert.equal(canonicalKey(''), '');
  assert.equal(canonicalKey(undefined), '');
  // パースできない文字列はそのまま
  assert.equal(canonicalKey('not a url'), 'not a url');
});

test('loadPosted: ファイルが無ければ空のストアを返す', async () => {
  const file = await tmpPostedPath();
  const store = await loadPosted(file);
  assert.deepEqual(store, { items: {} });
});

test('loadPosted: JSONが壊れていても落ちずに初期化する', async () => {
  const file = await tmpPostedPath();
  await savePosted({ items: {} }, file); // data/ を作らせる
  await writeFile(file, '{ これは壊れたJSON ', 'utf8');

  const store = await loadPosted(file);
  assert.deepEqual(store.items, {});
});

test('loadPosted: items が配列など想定外の形でも初期化する', async () => {
  const file = await tmpPostedPath();
  await savePosted({ items: {} }, file);
  await writeFile(file, JSON.stringify({ items: ['a', 'b'] }), 'utf8');

  const store = await loadPosted(file);
  assert.deepEqual(store.items, {});
});

test('保存 → 読込 → 重複判定 が一巡する', async () => {
  const file = await tmpPostedPath();

  const store = await loadPosted(file);
  const a = item('aaaaaaaaaaaaaaaa', 'https://example.com/news/1');
  const b = item('bbbbbbbbbbbbbbbb', 'https://example.com/news/2');

  assert.equal(isPosted(store, a), false);

  markPosted(store, [a]);
  assert.equal(isPosted(store, a), true);
  assert.equal(isPosted(store, b), false);

  const saved = await savePosted(store, file);
  assert.equal(saved.count, 2, 'id と URL の2キーが記録される');

  // ファイルが実在し、JSONとして読める
  const raw = JSON.parse(await readFile(file, 'utf8'));
  assert.ok(raw.items['aaaaaaaaaaaaaaaa']);
  assert.ok(raw.items['https://example.com/news/1']);

  // 読み直しても重複判定できる
  const reloaded = await loadPosted(file);
  assert.equal(isPosted(reloaded, a), true);
  assert.equal(isPosted(reloaded, b), false);
});

test('isPosted: id が違っても canonical URL が一致すれば投稿済み', async () => {
  const file = await tmpPostedPath();
  const store = await loadPosted(file);

  markPosted(store, [item('id-original', 'https://www.example.com/news/1/')]);

  // 別ID・トラッキングパラメータ付き・www有無違い でも同一とみなす
  const sameArticle = item('id-different', 'https://example.com/news/1?utm_source=rss');
  assert.equal(isPosted(store, sameArticle), true);
});

test('isPosted: URL が違っても id が一致すれば投稿済み', async () => {
  const store = { items: {} };
  markPosted(store, [item('same-id', 'https://example.com/a')]);
  assert.equal(isPosted(store, item('same-id', 'https://other.example.com/b')), true);
});

test('isPosted: 空ストア / 壊れたストアでも false を返して落ちない', () => {
  assert.equal(isPosted({ items: {} }, item('x', 'https://example.com/x')), false);
  assert.equal(isPosted({}, item('x', 'https://example.com/x')), false);
  assert.equal(isPosted(null, item('x', 'https://example.com/x')), false);
});

test('prunePosted: 30日より古いエントリだけを削除する', () => {
  const now = new Date('2026-08-23T00:00:00.000Z');
  const day = 24 * 60 * 60 * 1000;

  const store = {
    items: {
      recent: new Date(now.getTime() - 1 * day).toISOString(),
      edge29: new Date(now.getTime() - 29 * day).toISOString(),
      old31: new Date(now.getTime() - 31 * day).toISOString(),
      old365: new Date(now.getTime() - 365 * day).toISOString(),
      broken: 'これは日付ではない',
    },
  };

  const removed = prunePosted(store, now);
  assert.equal(removed, 3, '31日前・365日前・不正値 の3件が削除される');
  assert.deepEqual(Object.keys(store.items).sort(), ['edge29', 'recent']);
});

test('savePosted: 保存時に30日より古いエントリが prune される', async () => {
  const file = await tmpPostedPath();
  const now = new Date('2026-08-23T00:00:00.000Z');
  const day = 24 * 60 * 60 * 1000;

  const store = { items: {} };
  // 古い記録を直接埋め込む
  markPosted(store, [item('old-id', 'https://example.com/old')], new Date(now.getTime() - (RETENTION_DAYS + 5) * day));
  markPosted(store, [item('new-id', 'https://example.com/new')], new Date(now.getTime() - 1 * day));

  const result = await savePosted(store, file, { now });
  assert.equal(result.pruned, 2, '古い方の id / URL の2キーが prune される');
  assert.equal(result.count, 2, '新しい方の id / URL の2キーだけが残る');

  const reloaded = await loadPosted(file);
  assert.equal(isPosted(reloaded, item('old-id', 'https://example.com/old')), false);
  assert.equal(isPosted(reloaded, item('new-id', 'https://example.com/new')), true);
});

test('savePosted: data/ ディレクトリが無ければ作成し、一時ファイルを残さない', async () => {
  const file = await tmpPostedPath(); // data/ はまだ存在しない
  const store = { items: {} };
  markPosted(store, [item('id1', 'https://example.com/1')]);

  await savePosted(store, file);

  const files = await readdir(path.dirname(file));
  assert.deepEqual(files, ['posted.json'], '.tmp-* が残っていないこと');
});

test('savePosted: 出力JSONはキーがソートされていて再読込可能', async () => {
  const file = await tmpPostedPath();
  const store = { items: {} };
  markPosted(store, [item('zzz', 'https://example.com/z'), item('aaa', 'https://example.com/a')]);

  await savePosted(store, file);
  const raw = JSON.parse(await readFile(file, 'utf8'));
  const keys = Object.keys(raw.items);
  assert.deepEqual(keys, [...keys].sort());
});

test('markPosted: 記録時刻はISO8601', () => {
  const store = { items: {} };
  const now = new Date('2026-08-23T09:00:00.000Z');
  markPosted(store, [item('id1', 'https://example.com/1')], now);
  assert.equal(store.items['id1'], '2026-08-23T09:00:00.000Z');
});
