import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizePrefecture, isNationwide } from '../src/prefecture.js';
import { toFeedItem } from '../src/feed.js';

test('情報源のローマ字を正式名に直す', () => {
  assert.equal(normalizePrefecture('tokyo'), '東京都');
  assert.equal(normalizePrefecture('hyogo'), '兵庫県');
  assert.equal(normalizePrefecture('hokkaido'), '北海道');
  assert.equal(normalizePrefecture('kyoto'), '京都府');
  assert.equal(normalizePrefecture('osaka'), '大阪府');
});

test('全国（通販）は場所を問わない扱いにする', () => {
  assert.equal(normalizePrefecture('all'), '全国');
  assert.equal(normalizePrefecture('オンライン'), '全国');
  assert.equal(isNationwide('all'), true);
  assert.equal(isNationwide('tokyo'), false);
});

test('日本語で来ても正式名に揃う', () => {
  assert.equal(normalizePrefecture('東京'), '東京都');
  assert.equal(normalizePrefecture('東京都'), '東京都');
  assert.equal(normalizePrefecture('神奈川'), '神奈川県');
});

test('「東京都」を京都府と読み違えない', () => {
  assert.equal(normalizePrefecture('東京都千代田区'), '東京都');
  assert.equal(normalizePrefecture('京都府京都市'), '京都府');
});

test('読めないものは空。推測して間違った県を付けない', () => {
  assert.equal(normalizePrefecture('yokohama'), '');
  assert.equal(normalizePrefecture(''), '');
  assert.equal(normalizePrefecture(null), '');
  assert.equal(normalizePrefecture('カードショップ'), '');
});

test('長音の書き方が違っても読める', () => {
  assert.equal(normalizePrefecture('hyougo'), '兵庫県');
  assert.equal(normalizePrefecture('toukyou'), '東京都');
});

test('feed.json に載る時点で正式名になっている', () => {
  const base = { id: 'a', title: '抽選A', url: 'https://example.com/a', publishedAt: '2026-09-06T00:00:00Z' };
  assert.equal(toFeedItem({ ...base, prefecture: 'tokyo', deliveryType: 'store' }).prefecture, '東京都');
  assert.equal(toFeedItem({ ...base, prefecture: 'all', deliveryType: 'online' }).prefecture, '全国');
  assert.equal(toFeedItem(base).prefecture, '');
  // 受取方法はそのまま通す（表示側が判断する）
  assert.equal(toFeedItem({ ...base, deliveryType: 'store' }).deliveryType, 'store');
});
