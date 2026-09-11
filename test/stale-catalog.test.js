/**
 * 掲載日を持たない一覧（カタログ型）で、古い抽選を新着として出さないこと。
 *
 * きっかけ:
 *   プレミアムバンダイのカードダス一覧から取った
 *   「【抽選販売】ガンダムカードゲーム ブースターパックFreedom Acsension[GD05]」が
 *   アプリに「新着9分前」と表示された。実際は7月下旬発売・受付も当選発表も7月に終了。
 *
 *   原因は、情報源が日付を持たないときに取得時刻を掲載日として使い、
 *   それをそのまま「◯分前」と表示していたこと。
 *   持っていない情報を作り出しており、CLAUDE.md の
 *   「誤った情報は情報が無いことより有害」に正面から反する。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseReleaseTime } from '../src/sources/official.js';
import { toFeedItem } from '../src/feed.js';

const NOW = new Date('2026-09-11T01:00:00Z'); // JST 9/11 10:00

test('「7月下旬」を発売時期として読める', () => {
  const ms = parseReleaseTime('発売日：7月下旬', NOW);
  assert.ok(ms !== null);
  const d = new Date(ms);
  assert.equal(d.getUTCMonth() + 1, 7);
  assert.equal(d.getUTCDate(), 25);
  assert.equal(d.getUTCFullYear(), 2026);
});

test('上旬・中旬・下旬をそれぞれ別の日として扱う', () => {
  const early = parseReleaseTime('発売日：8月上旬', NOW);
  const mid = parseReleaseTime('発売日：8月中旬', NOW);
  const late = parseReleaseTime('発売日：8月下旬', NOW);
  assert.ok(early < mid && mid < late);
  assert.equal(new Date(early).getUTCDate(), 5);
  assert.equal(new Date(mid).getUTCDate(), 15);
  assert.equal(new Date(late).getUTCDate(), 25);
});

test('年が書いてあればそれに従う', () => {
  const ms = parseReleaseTime('2025年12月中旬', NOW);
  assert.equal(new Date(ms).getUTCFullYear(), 2025);
});

test('年が無いときは基準日にいちばん近い年を選ぶ', () => {
  // 1月の初めに「12月下旬」と書かれていたら、前年の12月とみなす
  const jan = new Date('2026-01-05T00:00:00Z');
  const ms = parseReleaseTime('発売日：12月下旬', jan);
  assert.equal(new Date(ms).getUTCFullYear(), 2025);
});

test('読めない文字列では日付をでっち上げない', () => {
  assert.equal(parseReleaseTime('発売日：未定', NOW), null);
  assert.equal(parseReleaseTime('', NOW), null);
  assert.equal(parseReleaseTime(null, NOW), null);
  assert.equal(parseReleaseTime('近日発売', NOW), null);
  assert.equal(parseReleaseTime('発売日：13月', NOW), null);
});

test('掲載日が無い項目は publishedAtKnown:false でフィードに載る', () => {
  const base = {
    id: 'x', title: '【抽選販売】ガンダムカードゲーム GD05',
    url: 'https://p-bandai.jp/item/item-1000254964',
    publishedAt: '2026-09-11T01:44:16.455Z',
  };
  assert.equal(toFeedItem({ ...base, publishedAtKnown: false }).publishedAtKnown, false);
  // 日付を持っている情報源はこれまでどおり true
  assert.equal(toFeedItem({ ...base, publishedAtKnown: true }).publishedAtKnown, true);
  // 指定が無い場合も true（既存の情報源の挙動を変えない）
  assert.equal(toFeedItem(base).publishedAtKnown, true);
});
